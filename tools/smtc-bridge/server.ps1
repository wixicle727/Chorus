# Chorus built-in SMTC bridge - HTTP server.
#
# Serves the same two endpoints as nuttylmao/smtc-bridge, from Windows SMTC
# directly, so Chorus can be pointed at either one:
#
#   GET /now-playing   the full snapshot
#   GET /sessions      the same payload (JSON, unlike smtc-bridge's HTML view)
#   GET /health        liveness and reader stats
#
# Why a raw TcpListener rather than System.Net.HttpListener
# --------------------------------------------------------
# HttpListener sits on HTTP.SYS, which needs a URL reservation for anything
# beyond a default localhost prefix and behaves differently under a restricted
# token. A plain TCP socket has none of that: no admin rights, no `netsh http
# add urlacl`, and it works when the HTTP Server service is disabled. The tiny
# amount of HTTP/1.1 framing below is the entire cost.
#
# Written for Windows PowerShell 5.1 - no ternary operators, no `??`.

[CmdletBinding()]
param(
  [int] $Port = 5010,
  [string] $HostName = '127.0.0.1',
  [double] $PollMs = 500,
  [switch] $Once,
  [switch] $Quiet,
  [switch] $NoThumbnails,
  [string] $DebugLog = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# WinRT projections are registered per architecture. A 32-bit PowerShell on 64-bit
# Windows cannot bind them, so the bridge would fail with "class not registered"
# rather than anything useful. Re-launch itself through Sysnative when that happens;
# this matters for the auto-start entry, whose bitness depends on how it was written.
if (-not [Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem) {
  $sysnative = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path $sysnative) {
    $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Port', $Port)
    $wasBound = $PSBoundParameters
    foreach ($name in @('HostName', 'PollMs')) {
      if ($wasBound.ContainsKey($name)) { $relaunch += @("-$name", [string]$wasBound[$name]) }
    }
    foreach ($flag in @('Once', 'Quiet', 'NoThumbnails')) {
      if ($wasBound.ContainsKey($flag)) { $relaunch += "-$flag" }
    }
    if ($DebugLog) { $relaunch += @('-DebugLog', $DebugLog) }
    Start-Process -FilePath $sysnative -ArgumentList $relaunch -NoNewWindow -Wait
    exit $LASTEXITCODE
  }
}

. (Join-Path $PSScriptRoot 'smtc.ps1')

function Write-Log {
  param([string] $Message)
  if ($Quiet) { return }
  $stamp = (Get-Date).ToString('HH:mm:ss')
  Write-Host "[$stamp] $Message"
}

# --- version, read from the project's package.json so the two never drift ----

$script:AppVersion = '1.0.0'
try {
  # Resolve from this script's own location rather than the current directory, so
  # the bridge works when launched from anywhere (a shortcut, a scheduler, or
  # another process's working directory).
  $projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $pkgPath = Join-Path $projectRoot 'package.json'
  if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if ($pkg.version) { $script:AppVersion = [string]$pkg.version }
  }
} catch {
  # A missing or malformed package.json must not stop the bridge.
}

# --- snapshot cache ---------------------------------------------------------
#
# SMTC is polled on a fixed interval and every HTTP request is answered from the
# latest snapshot. Two reasons: the artwork base64 is expensive to rebuild (the
# Python bridge re-encodes it per request and relies on a 0.5s throttle), and a
# burst of requests must not each trigger a WinRT round trip.

$script:Latest = $null
$script:LastPollTicks = [DateTime]::UtcNow.Ticks
$script:Stats = @{ polls = 0; errors = 0; requests = 0; lastError = $null; startedAt = (Get-Date).ToString('o') }

function Update-Snapshot {
  param([switch] $Force)
  # Compare UTC TICKS, not parsed DateTimes.
  #
  # The previous version stored an ISO string and did `[DateTime]::UtcNow -
  # [DateTime]::Parse(...)`. Parse honours the string's `+08:00` offset and returns
  # a Local-kind value, so subtracting it from a Utc-kind one was off by the whole
  # UTC offset (-8h here). `since` was therefore hugely negative, the throttle never
  # released, and the snapshot never refreshed after the first one.
  $since = ([DateTime]::UtcNow.Ticks - $script:LastPollTicks) / [TimeSpan]::TicksPerMillisecond
  if (-not $Force -and $null -ne $script:Latest -and $since -lt $PollMs) { return }
  try {
    $script:Latest = Get-SmtcSnapshot -IncludeThumbnail:(-not $NoThumbnails) -AppVersion $script:AppVersion
    $script:Stats.polls = $script:Stats.polls + 1
    $script:Stats.lastError = $null
  } catch {
    $script:Stats.errors = $script:Stats.errors + 1
    $script:Stats.lastError = $_.Exception.Message
    if ($null -eq $script:Latest) {
      # Never served a snapshot yet: surface an empty one rather than throwing at
      # the client, so Chorus reports "no sessions" instead of "bridge down".
      $script:Latest = @{
        app_version = $script:AppVersion
        os = 'Windows'
        current_session_id = $null
        sessions = @()
      }
    }
  }
  $script:LastPollTicks = [DateTime]::UtcNow.Ticks
}

function ConvertTo-JsonCompact {
  param($Value, [int] $Depth = 12)
  # -Compress keeps the payload small; -Depth must exceed the object nesting.
  return ($Value | ConvertTo-Json -Depth $Depth -Compress)
}

# --- HTTP ------------------------------------------------------------------

function Get-RouteForPath {
  param([string] $Path)
  $p = $Path.Trim().ToLowerInvariant()
  if ($p -eq '/' -or $p -eq '/now-playing' -or $p -eq '/sessions') { return 'now-playing' }
  if ($p -eq '/health') { return 'health' }
  return 'not-found'
}

function Send-HttpResponse {
  param(
    [Parameter(Mandatory = $true)] $Stream,
    [int] $StatusCode = 200,
    [string] $StatusText = 'OK',
    [string] $Body = '',
    [string] $ContentType = 'application/json; charset=utf-8'
  )

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $head = New-Object System.Text.StringBuilder
  [void]$head.Append("HTTP/1.1 $StatusCode $StatusText`r`n")
  [void]$head.Append("Content-Type: $ContentType`r`n")
  [void]$head.Append("Content-Length: $($bytes.Length)`r`n")
  [void]$head.Append("Connection: close`r`n")
  # The Python bridge allows any origin; Chorus does not need it, but leaving it
  # on means the overlay and panel can talk to this directly too.
  [void]$head.Append("Access-Control-Allow-Origin: *`r`n")
  [void]$head.Append("Cache-Control: no-store`r`n")
  [void]$head.Append("`r`n")

  $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head.ToString())
  $Stream.Write($headBytes, 0, $headBytes.Length)
  if ($bytes.Length -gt 0) { $Stream.Write($bytes, 0, $bytes.Length) }
  $Stream.Flush()
}

function Handle-Client {
  param([Parameter(Mandatory = $true)] $Client)

  try {
    $stream = $Client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)

    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) { return }

    $parts = $requestLine.Split(' ')
    $method = $parts[0]
    $rawPath = '/'
    if ($parts.Length -ge 2) { $rawPath = $parts[1] }
    # Ignore any query string.
    $queryAt = $rawPath.IndexOf('?')
    if ($queryAt -ge 0) { $rawPath = $rawPath.Substring(0, $queryAt) }

    # Drain headers so the client's write completes.
    while ($true) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrEmpty($line)) { break }
    }

    $script:Stats.requests = $script:Stats.requests + 1

    if ($method -ne 'GET' -and $method -ne 'HEAD') {
      Send-HttpResponse -Stream $stream -StatusCode 405 -StatusText 'Method Not Allowed' `
        -Body '{"error":"only GET is supported"}'
      return
    }

    switch (Get-RouteForPath -Path $rawPath) {
      'now-playing' {
        Update-Snapshot
        Send-HttpResponse -Stream $stream -Body (ConvertTo-JsonCompact $script:Latest)
      }
      'health' {
        $health = @{
          ok = $true
          app_version = $script:AppVersion
          port = $Port
          pollMs = $PollMs
          sessions = @($script:Latest.sessions).Count
          stats = $script:Stats
        }
        Send-HttpResponse -Stream $stream -Body (ConvertTo-JsonCompact $health)
      }
      default {
        Send-HttpResponse -Stream $stream -StatusCode 404 -StatusText 'Not Found' `
          -Body '{"error":"not found","routes":["/now-playing","/sessions","/health"]}'
      }
    }
  } catch {
    # A single malformed request must not take the server down.
  } finally {
    try { $Client.Close() } catch { }
  }
}

# --- one-shot mode ---------------------------------------------------------

if ($Once) {
  Update-Snapshot -Force
  Write-Output (ConvertTo-JsonCompact $script:Latest)
  exit 0
}

# --- serve -----------------------------------------------------------------

$listener = $null
try {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($HostName), $Port)
  $listener.Start()
} catch {
  # A second instance is the ordinary cause, and at sign-in it is the *expected*
  # one (auto-start plus a hand launch, or two auto-start entries). Distinguish
  # "already running, nothing to do" from a genuine problem, because the auto-start
  # path is silent and a bare failure would be invisible.
  $alreadyOurs = $false
  try {
    $probe = Invoke-WebRequest "http://${HostName}:${Port}/health" -UseBasicParsing -TimeoutSec 3
    $health = $probe.Content | ConvertFrom-Json
    if ($health.ok -and $health.app_version) { $alreadyOurs = $true }
  } catch {
    $alreadyOurs = $false
  }

  if ($alreadyOurs) {
    Write-Log "another Chorus SMTC bridge is already serving on ${HostName}:${Port} - nothing to do"
    exit 0
  }

  Write-Host ""
  Write-Host "  Could not listen on ${HostName}:${Port}" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Another program is using that port. Start the bridge on a different" -ForegroundColor Yellow
  Write-Host "  one with -Port, or run: install-autostart.bat -Port <n>" -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

Write-Log "Chorus built-in SMTC bridge v$($script:AppVersion)"
Write-Log "listening on http://${HostName}:${Port}/now-playing"
Write-Log "poll interval ${PollMs}ms"
try {
  Update-Snapshot -Force
  $n = @($script:Latest.sessions).Count
  Write-Log "first snapshot ok - $n session(s)"
} catch {
  Write-Log "first snapshot failed: $($_.Exception.Message)"
}

$pending = New-Object System.Collections.ArrayList
$script:LoopCount = 0

try {
  while ($true) {
    $script:LoopCount = $script:LoopCount + 1
    if ($DebugLog) {
      try { Add-Content -Path $DebugLog -Value "loop=$($script:LoopCount) pending=$($pending.Count) polls=$($script:Stats.polls) errors=$($script:Stats.errors) last=$($script:Stats.lastError)" } catch { }
    }

    # Accept everything that is waiting.
    while ($listener.Pending()) {
      $client = $listener.AcceptTcpClient()
      $client.NoDelay = $true
      [void]$pending.Add($client)
    }

    if ($pending.Count -gt 0) {
      foreach ($client in @($pending)) {
        [void]$pending.Remove($client)
        Handle-Client -Client $client
      }
    } else {
      # Nothing to do: refresh the snapshot so requests never pay for a WinRT trip.
      Update-Snapshot
      Start-Sleep -Milliseconds ([Math]::Max(20, [int]($PollMs / 5)))
    }
  }
} finally {
  if ($null -ne $listener) {
    try { $listener.Stop() } catch { }
  }
  foreach ($client in @($pending)) {
    try { $client.Close() } catch { }
  }
  Write-Log "stopped"
}
