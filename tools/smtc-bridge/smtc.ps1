# Chorus built-in SMTC reader.
#
# Reads Windows System Media Transport Controls through WinRT and hands back the
# same shape that smtc-bridge exposes, so Chorus can consume either one.
#
# PowerShell 5.1 is used deliberately: it is present on every Windows 10/11
# install, and it is the only PowerShell that can bind WinRT projections with the
# `ContentType=WindowsRuntime` syntax below. Windows PowerShell also ships
# WinForms, which the tray helper relies on.
#
# NOTE: this file is written for Windows PowerShell 5.1 and must avoid PowerShell 7
# syntax (no ternary `? :`, no `??`, no `-Parallel`). `Set-StrictMode` is on so
# typos surface as errors rather than silently producing $null.

Set-StrictMode -Version 2.0

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# --- WinRT async plumbing -------------------------------------------------
#
# Windows PowerShell cannot await a WinRT IAsyncOperation directly. The canonical
# workaround is to reflect the generic AsTask extension and block on the Task.

$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Invoke-WinRtAsync {
  <#
    .SYNOPSIS
      Block until a WinRT IAsyncOperation completes and return its result.
  #>
  param(
    [Parameter(Mandatory = $true)] $Operation,
    [Parameter(Mandatory = $true)] [Type] $ResultType,
    [int] $TimeoutMs = 10000
  )

  $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
  $task = $asTask.Invoke($null, @($Operation))
  if (-not $task.Wait($TimeoutMs)) {
    throw "WinRT operation timed out after ${TimeoutMs}ms"
  }
  return $task.Result
}

# --- SMTC types -----------------------------------------------------------

$script:SmtcManagerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$script:MediaPropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

function Get-SmtcManager {
  <#
    .SYNOPSIS
      Request a session manager. Called per snapshot, which is cheap and avoids the
      stale-COM-context problem the Python bridge works around.
  #>
  return Invoke-WinRtAsync -Operation ($script:SmtcManagerType::RequestAsync()) `
    -ResultType $script:SmtcManagerType
}

function Get-StreamContentType {
  <#
    .SYNOPSIS
      Sniff an image's real type from its magic bytes.

      smtc-bridge hardcodes `image/jpeg` for every thumbnail, which is wrong
      whenever a player supplies PNG or WebP — Spotify commonly returns PNG. The
      bytes are checked instead so the data URL declares the truth.
  #>
  param([Parameter(Mandatory = $true)] [byte[]] $Bytes)

  if ($Bytes.Length -ge 8 -and
      $Bytes[0] -eq 0x89 -and $Bytes[1] -eq 0x50 -and $Bytes[2] -eq 0x4E -and $Bytes[3] -eq 0x47) {
    return 'image/png'
  }
  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xD8 -and $Bytes[2] -eq 0xFF) {
    return 'image/jpeg'
  }
  if ($Bytes.Length -ge 12 -and
      $Bytes[0] -eq 0x52 -and $Bytes[1] -eq 0x49 -and $Bytes[2] -eq 0x46 -and $Bytes[3] -eq 0x46 -and
      $Bytes[8] -eq 0x57 -and $Bytes[9] -eq 0x45 -and $Bytes[10] -eq 0x42 -and $Bytes[11] -eq 0x50) {
    return 'image/webp'
  }
  if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0x42 -and $Bytes[1] -eq 0x4D) {
    return 'image/bmp'
  }
  if ($Bytes.Length -ge 6 -and $Bytes[0] -eq 0x47 -and $Bytes[1] -eq 0x49 -and $Bytes[2] -eq 0x46) {
    return 'image/gif'
  }
  return 'image/jpeg'
}

# Resolved once: the overload of AsStreamForRead that takes an IRandomAccessStream.
$script:AsStreamForReadMethod = $null

function Get-AsStreamForReadMethod {
  <#
    .SYNOPSIS
      Find System.IO.WindowsRuntimeStreamExtensions.AsStreamForRead(IRandomAccessStream).

    .NOTES
      This indirection is required. Windows PowerShell projects the WinRT stream
      returned by OpenReadAsync as a bare System.__ComObject — its Size and
      ContentType are invisible, casting to IRandomAccessStreamWithContentType
      fails, and DataReader exposes only FromBuffer, so CreateDataReader is
      unavailable. AsStreamForRead accepts the COM object and hands back a real
      .NET Stream, which is the only route to the bytes from here.
  #>
  if ($null -ne $script:AsStreamForReadMethod) { return $script:AsStreamForReadMethod }

  $extensions = [System.IO.WindowsRuntimeStreamExtensions]
  $candidates = @($extensions.GetMethods() | Where-Object {
      $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
    })
  foreach ($m in $candidates) {
    $p = $m.GetParameters()[0].ParameterType
    if ($p.Name -eq 'IRandomAccessStream' -or $p.FullName -like '*IRandomAccessStream*') {
      $script:AsStreamForReadMethod = $m
      return $m
    }
  }
  # Fall back to the first overload; there are only two, and the other takes a
  # buffer size we do not need.
  if ($candidates.Count -gt 0) {
    $script:AsStreamForReadMethod = $candidates[0]
    return $candidates[0]
  }
  return $null
}

function Get-ThumbnailDataUrl {
  <#
    .SYNOPSIS
      Read a thumbnail stream reference into a `data:` URL, or $null.

      The size is capped so one enormous artwork can never balloon a snapshot that
      Chorus then re-serialises on every poll.
  #>
  param(
    $ThumbnailReference,
    [int] $MaxBytes = 2097152
  )

  if ($null -eq $ThumbnailReference) { return $null }

  try {
    $randomAccessStream = Invoke-WinRtAsync -Operation ($ThumbnailReference.OpenReadAsync()) `
      -ResultType ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $randomAccessStream) { return $null }

    $asStream = Get-AsStreamForReadMethod
    if ($null -eq $asStream) { return $null }

    $stream = $asStream.Invoke($null, @($randomAccessStream))
    if ($null -eq $stream -or -not $stream.CanRead) { return $null }

    # Length is not always known for a COM-backed stream, so read into a buffer
    # and enforce the cap as we go.
    $buffer = New-Object System.IO.MemoryStream
    $chunk = New-Object byte[] 65536
    $total = 0
    while ($true) {
      $read = $stream.Read($chunk, 0, $chunk.Length)
      if ($read -le 0) { break }
      $total += $read
      if ($total -gt $MaxBytes) { return $null }
      $buffer.Write($chunk, 0, $read)
    }
    $bytes = $buffer.ToArray()
    if ($bytes.Length -le 0) { return $null }

    $mime = Get-StreamContentType -Bytes $bytes
    return "data:$mime;base64,$([Convert]::ToBase64String($bytes))"
  } catch {
    # Artwork is optional: never let it fail a snapshot.
    return $null
  } finally {
    if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
    if ($null -ne $buffer) { try { $buffer.Dispose() } catch { } }
  }
}

function To-Int {
  <#
    .SYNOPSIS
      Best-effort integer for a WinRT enum or number.

      WinRT enums arrive projected in ways that vary by session and Windows build:
      some expose `.value__`, some do not. A [int] cast handles both, and anything
      unreadable becomes 0 rather than throwing — a wrong enum value is far less bad
      than losing every session in the snapshot.
  #>
  param($Value)
  if ($null -eq $Value) { return 0 }
  try { return [int]$Value } catch { return 0 }
}

function Get-PlaybackStatusName {
  param([int] $Value)
  switch ($Value) {
    0 { 'CLOSED' }
    1 { 'OPENED' }
    2 { 'CHANGING' }
    3 { 'STOPPED' }
    4 { 'PLAYING' }
    5 { 'PAUSED' }
    default { "UNKNOWN($Value)" }
  }
}

function Get-SmtcSessionSnapshot {
  <#
    .SYNOPSIS
      Normalise one SMTC session into a plain hashtable.

      Field names and units match smtc-bridge exactly, including its quirks:
      timeline values are millisecond OFFSETS (not wall-clock), `LastUpdatedTime`
      is the only absolute time, and `Thumbnail` is a full data URL.
  #>
  param([Parameter(Mandatory = $true)] $Session)

  $media = $null
  try {
    $media = Invoke-WinRtAsync -Operation ($Session.TryGetMediaPropertiesAsync()) -ResultType $script:MediaPropsType
  } catch {
    $media = $null
  }

  $playback = $null
  try { $playback = $Session.GetPlaybackInfo() } catch { $playback = $null }

  $timeline = $null
  try { $timeline = $Session.GetTimelineProperties() } catch { $timeline = $null }

  # Title/Artist fall back to "Unknown" like smtc-bridge, but empty strings are
  # friendlier to the matcher, so they are normalised to ''.
  $title = ''
  $artist = ''
  $album = ''
  $albumArtist = ''
  $subtitle = ''
  $trackNumber = 0
  $albumTrackCount = 0
  $genres = @()
  $thumbnail = $null

  if ($null -ne $media) {
    if ($null -ne $media.Title) { $title = [string]$media.Title }
    if ($null -ne $media.Artist) { $artist = [string]$media.Artist }
    if ($null -ne $media.AlbumTitle) { $album = [string]$media.AlbumTitle }
    if ($null -ne $media.AlbumArtist) { $albumArtist = [string]$media.AlbumArtist }
    if ($null -ne $media.Subtitle) { $subtitle = [string]$media.Subtitle }
    $trackNumber = [int]$media.TrackNumber
    $albumTrackCount = [int]$media.AlbumTrackCount
    if ($null -ne $media.Genres) { $genres = @($media.Genres) }
    $thumbnail = Get-ThumbnailDataUrl -ThumbnailReference $media.Thumbnail
  }

  $playbackStatus = 0
  $playbackType = 0
  # $null, matching smtc-bridge: its `if (raw_playback and ...)` guard yields null
  # rather than a number when no rate is reported. Chorus defaults it to 1 itself.
  $playbackRate = $null
  $isShuffleActive = $false
  $autoRepeatMode = 0
  if ($null -ne $playback) {
    # Cast the enum to int rather than reading `.value__`.
    #
    # `.value__` is not reliably available: a Chrome session running alongside
    # Spotify threw "The property 'value__' cannot be found on this object", and
    # because that aborted the whole snapshot, Chorus saw ZERO sessions while two
    # were live. A PowerShell [int] cast works whether or not the projected enum
    # exposes the backing field.
    $playbackStatus = To-Int $playback.PlaybackStatus
    $playbackType = To-Int $playback.PlaybackType
    if ($null -ne $playback.PlaybackRate) { $playbackRate = [double]$playback.PlaybackRate }
    if ($null -ne $playback.IsShuffleActive) { $isShuffleActive = [bool]$playback.IsShuffleActive }
    $autoRepeatMode = To-Int $playback.AutoRepeatMode
  }

  $positionMs = 0; $startMs = 0; $endMs = 0; $minSeekMs = 0; $maxSeekMs = 0; $lastUpdated = $null
  if ($null -ne $timeline) {
    if ($null -ne $timeline.Position) { $positionMs = [int][Math]::Round($timeline.Position.TotalMilliseconds) }
    if ($null -ne $timeline.StartTime) { $startMs = [int][Math]::Round($timeline.StartTime.TotalMilliseconds) }
    if ($null -ne $timeline.EndTime) { $endMs = [int][Math]::Round($timeline.EndTime.TotalMilliseconds) }
    if ($null -ne $timeline.MinSeekTime) { $minSeekMs = [int][Math]::Round($timeline.MinSeekTime.TotalMilliseconds) }
    if ($null -ne $timeline.MaxSeekTime) { $maxSeekMs = [int][Math]::Round($timeline.MaxSeekTime.TotalMilliseconds) }
    if ($null -ne $timeline.LastUpdatedTime) {
      # Round-trip ("o") keeps the offset and is parseable by Date.parse in Node.
      $lastUpdated = ([DateTimeOffset]$timeline.LastUpdatedTime).ToString('o')
    }
  }

  return @{
    source_app_id = [string]$Session.SourceAppUserModelId
    media_properties = @{
      Title = $title
      Artist = $artist
      AlbumTitle = $album
      AlbumArtist = $albumArtist
      Subtitle = $subtitle
      TrackNumber = $trackNumber
      AlbumTrackCount = $albumTrackCount
      Genres = $genres
      Thumbnail = $thumbnail
    }
    playback_info = @{
      PlaybackStatus = $playbackStatus
      PlaybackType = $playbackType
      PlaybackRate = $playbackRate
      IsShuffleActive = $isShuffleActive
      AutoRepeatMode = $autoRepeatMode
    }
    timeline_properties = @{
      Position = $positionMs
      StartTime = $startMs
      EndTime = $endMs
      MinSeekTime = $minSeekMs
      MaxSeekTime = $maxSeekMs
      LastUpdatedTime = $lastUpdated
    }
  }
}

function Get-SmtcSnapshot {
  <#
    .SYNOPSIS
      The whole `/now-playing` payload.

    .PARAMETER IncludeThumbnail
      Base64 artwork is large. Callers that only need metadata (the control panel
      polling fast, for instance) can skip it.
  #>
  param(
    [switch] $IncludeThumbnail,
    [string] $AppVersion = '1.0.0'
  )

  $manager = Get-SmtcManager
  $sessions = @()
  $currentId = $null

  if ($null -ne $manager) {
    try {
      $current = $manager.GetCurrentSession()
      if ($null -ne $current) { $currentId = [string]$current.SourceAppUserModelId }
    } catch {
      $currentId = $null
    }

    foreach ($s in $manager.GetSessions()) {
      # One unreadable session must never empty the whole snapshot. A single bad
      # app (a browser playing video, say) previously threw and left Chorus with NO
      # sessions while several were live, which looks exactly like "no music".
      try {
        $snapshot = Get-SmtcSessionSnapshot -Session $s
        if (-not $IncludeThumbnail) {
          $snapshot.media_properties.Thumbnail = $null
        }
        $sessions += $snapshot
      } catch {
        # Skip this session, keep the rest.
      }
    }
  }

  return @{
    app_version = $AppVersion
    os = 'Windows'
    current_session_id = $currentId
    sessions = $sessions
  }
}
