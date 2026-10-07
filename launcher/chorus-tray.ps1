# Chorus - system tray helper.
#
# Owns the tray icon and supervises the Node server as a hidden child process.
# Started by launcher\chorus-hidden.vbs (at sign-in) or by start.bat (manually).
#
# Tray menu:
#   Open control panel   - opens http://127.0.0.1:<port>/control
#   Open OBS lyrics page - opens the overlay URL
#   View server console  - opens the live log in Notepad (the "console")
#   Open data folder     - config, cache and history
#   Restart server
#   Quit Chorus          - stops the server and removes the icon
#
# If an instance is already running (a .chorus.pid file whose process exists),
# this helper only shows an icon for it instead of starting a second server.

param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 0,
  [switch]$NoServer
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------- configuration

if (-not $Root -or -not (Test-Path $Root)) {
  $Root = Split-Path -Parent $PSScriptRoot
}

# The data folder must match the app's, or the tray would read a different config and
# write a different log. CHORUS_DATA_DIR is authoritative when the app set it; otherwise
# an existing data/ beside the app wins (portable installs), then %LOCALAPPDATA%.
$dataDir = $env:CHORUS_DATA_DIR
if (-not $dataDir) {
  $portable = Join-Path $Root 'data'
  if (Test-Path $portable) {
    $dataDir = $portable
  } elseif ($env:LOCALAPPDATA) {
    $dataDir = Join-Path $env:LOCALAPPDATA 'Chorus\data'
  } else {
    $dataDir = $portable
  }
}
$logDir = Join-Path $dataDir 'logs'
$logFile = Join-Path $logDir 'chorus.log'
$pidFile = Join-Path $dataDir '.chorus.pid'
$configFile = Join-Path $dataDir 'config.json'

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# UTF-8 without a BOM: `Add-Content -Encoding UTF8` writes a BOM on Windows
# PowerShell 5.1, which turns the log into mojibake next to node's output.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-ConfiguredPort {
  param([int]$Explicit)
  if ($Explicit -gt 0) { return $Explicit }
  if (Test-Path $configFile) {
    try {
      $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
      if ($cfg.server.port) { return [int]$cfg.server.port }
    } catch {
      # A malformed config is the server's problem to report; fall through.
    }
  }
  return 6727
}

$script:Port = Get-ConfiguredPort -Explicit $Port
$script:BaseUrl = "http://127.0.0.1:$script:Port"
$script:ServerProcess = $null
$script:OwnsServer = $false

function Write-Log {
  param([string]$Message)
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  # Keep wrapper lines ASCII so the file stays one encoding alongside node output.
  $safe = $Message -replace '[^\x20-\x7E]', '-'
  try { [System.IO.File]::AppendAllText($logFile, "[$stamp] [tray] $safe`r`n", $script:Utf8NoBom) } catch { }
}

# ------------------------------------------------------------------ tray icon

function Get-IconFromExecutable {
  <#
    .SYNOPSIS
      Pull the icon straight out of the running executable.

    .NOTES
      This is the reliable path for an installed build: the app's `assets/` folder is
      not on disk (it is embedded in the executable), but the executable itself carries
      the Chorus icon, so extracting it always works.

      The node.exe case is rejected: before the icon is stamped, a development build
      would otherwise show Node's own icon in the tray.
  #>
  try {
    $exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    if (-not $exe) { return $null }

    $base = [System.IO.Path]::GetFileNameWithoutExtension($exe)
    if ($base -ieq 'node' -or $base -ieq 'powershell' -or $base -ieq 'pwsh') { return $null }

    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
    if ($icon) { return $icon }
  } catch {
    # Fall through to the next strategy.
  }
  return $null
}

function New-ChorusIcon {
  # Strategies, best first:
  #   1. the brand .ico on disk (a source checkout, or the unpacked build)
  #   2. the icon embedded in the executable (an installed build)
  #   3. drawn at runtime (last resort, so a tray icon always appears)
  #
  # Each step is guarded because a failure here previously killed the whole helper
  # silently: the process exited without ever creating the NotifyIcon, so no tray icon
  # appeared and nothing was logged.

  $assetRoots = @()
  if ($Root) { $assetRoots += (Join-Path $Root 'assets') }
  $assetRoots += (Join-Path (Split-Path -Parent $PSScriptRoot) 'assets')
  $assetRoots += (Join-Path $PSScriptRoot 'assets')

  foreach ($assets in $assetRoots) {
    if (-not $assets) { continue }
    try {
      if (-not (Test-Path $assets)) { continue }

      $icoPath = Join-Path $assets 'chorus.ico'
      if (Test-Path $icoPath) {
        return (New-Object System.Drawing.Icon($icoPath))
      }
      $pngPath = Join-Path $assets 'chorus-32.png'
      if (Test-Path $pngPath) {
        $fromPng = New-Object System.Drawing.Bitmap($pngPath)
        $handle = $fromPng.GetHicon()
        $icon = [System.Drawing.Icon]::FromHandle($handle).Clone()
        $fromPng.Dispose()
        return $icon
      }
    } catch {
      # Try the next location.
    }
  }

  $fromExe = Get-IconFromExecutable
  if ($fromExe) { return $fromExe }

  # Fallback: drawn at runtime, so a source checkout with no assets/ still works.
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  # Rounded dark tile with the three-line lyric mark.
  $tile = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 23, 23, 27))
  $g.FillEllipse($tile, 1, 1, $size - 2, $size - 2)

  $idle = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 150, 160, 174))
  $active = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 76, 194, 255))
  $g.FillRectangle($idle, 9, 9, 14, 3)
  $g.FillRectangle($active, 6, 15, 20, 4)
  $g.FillRectangle($idle, 9, 22, 14, 3)

  $g.Dispose(); $tile.Dispose(); $idle.Dispose(); $active.Dispose()

  $handle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  # Clone so the icon survives the handle being released.
  $clone = $icon.Clone()
  $bmp.Dispose()
  return $clone
}

$notify = New-Object System.Windows.Forms.NotifyIcon
# Guarded: a failure building the icon used to terminate the whole helper silently, so
# no tray icon appeared and nothing was written to the log.
try {
  $notify.Icon = New-ChorusIcon
} catch {
  Write-Log "could not build the tray icon: $($_.Exception.Message)"
}
$notify.Text = "Chorus - lyrics for OBS"

# ------------------------------------------------------------------- the server

function Test-ServerUp {
  try {
    $null = Invoke-WebRequest -Uri "$script:BaseUrl/api/health" -TimeoutSec 2 -UseBasicParsing
    return $true
  } catch {
    return $false
  }
}

function Find-RunningServer {
  # Prefer the pid file: it lets this helper adopt a server it did not start.
  if (Test-Path $pidFile) {
    try {
      $recorded = [int](Get-Content $pidFile -Raw).Trim()
      $proc = Get-Process -Id $recorded -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'node') { return $proc }
    } catch { }
  }
  return $null
}

function Start-ChorusServer {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue)
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show(
      "Node.js was not found on your PATH.`n`nInstall Node.js 22 or newer, then restart Chorus.",
      'Chorus', 'OK', 'Error') | Out-Null
    return $false
  }

  # Rotate the log so it cannot grow without bound.
  if (Test-Path $logFile) {
    $sizeMb = (Get-Item $logFile).Length / 1MB
    if ($sizeMb -gt 5) {
      $old = "$logFile.1"
      Remove-Item $old -ErrorAction SilentlyContinue
      Move-Item $logFile $old -ErrorAction SilentlyContinue
    }
  }

  Add-Content -Path $logFile -Value "" -Encoding UTF8
  Write-Log "starting server on port $script:Port"

  # -WindowStyle Hidden plus CreateNoWindow keeps the console fully hidden.
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'launcher\chorus-console.ps1'), '-Port', $script:Port)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  if (-not (Test-Path $psi.FileName)) { $psi.FileName = 'powershell.exe' }
  $psi.Arguments = ($args | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false

  try {
    $script:ServerProcess = [System.Diagnostics.Process]::Start($psi)
    $script:OwnsServer = $true
    Write-Log "server started (wrapper pid $($script:ServerProcess.Id))"
    return $true
  } catch {
    Write-Log "failed to start server: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show(
      "Chorus could not start its server.`n`n$($_.Exception.Message)",
      'Chorus', 'OK', 'Error') | Out-Null
    return $false
  }
}

function Stop-ChorusServer {
  # Stop the node process rather than the wrapper, so the port is actually freed.
  $target = Find-RunningServer
  if (-not $target -and $script:ServerProcess) { $target = $script:ServerProcess }
  if ($target) {
    Write-Log "stopping server pid $($target.Id)"
    try { Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  # Also clear any orphaned node process listening on our port.
  try {
    $conns = Get-NetTCPConnection -LocalPort $script:Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
  } catch { }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  $script:ServerProcess = $null
  $script:OwnsServer = $false
}

function Restart-ChorusServer {
  Stop-ChorusServer
  Start-Sleep -Milliseconds 600
  Start-ChorusServer | Out-Null
  Update-TrayText
}

function Update-TrayText {
  $state = if (Test-ServerUp) { "running on port $script:Port" } else { 'not responding' }
  # NotifyIcon.Text is capped at 63 characters.
  $text = "Chorus - $state"
  if ($text.Length -gt 62) { $text = $text.Substring(0, 62) }
  $notify.Text = $text
}

if (-not $NoServer) {
  if (Test-ServerUp) {
    # Another instance already serves this port; adopt it rather than double-start.
    Write-Log "a server is already listening on port $script:Port; adopting it"
    $existing = Find-RunningServer
    if ($existing) { $script:ServerProcess = $existing }
  } else {
    Start-ChorusServer | Out-Null
    Start-Sleep -Milliseconds 800
  }
}

# ------------------------------------------------------------------ tray menu

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openPanel = $menu.Items.Add('Open control panel')
$openPanel.add_Click({ Start-Process "$script:BaseUrl/control" })

$openOverlay = $menu.Items.Add('Open OBS lyrics page')
$openOverlay.add_Click({ Start-Process "$script:BaseUrl/overlay" })

$openConsole = $menu.Items.Add('View server console')
$openConsole.add_Click({
    if (-not (Test-Path $logFile)) {
      New-Item -ItemType File -Force -Path $logFile | Out-Null
    }
    # Notepad tails nothing, so open at the end of the file.
    Start-Process notepad.exe -ArgumentList "`"$logFile`""
  })

$openData = $menu.Items.Add('Open data folder')
$openData.add_Click({ Start-Process explorer.exe -ArgumentList "`"$(Join-Path $Root 'data')`"" })

$restart = $menu.Items.Add('Restart server')
$restart.add_Click({ Restart-ChorusServer })

$null = $menu.Items.Add('-')

$quit = $menu.Items.Add('Quit Chorus')
$quit.add_Click({
    Write-Log 'quit requested from tray'
    Stop-ChorusServer
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
  })

$notify.ContextMenuStrip = $menu
# Double-clicking the icon opens the panel, the usual tray convention.
$notify.add_DoubleClick({ Start-Process "$script:BaseUrl/control" })

try {
  $notify.Visible = $true
  Write-Log 'tray icon shown'
} catch {
  Write-Log "could not show tray icon: $($_.Exception.Message)"
}

Update-TrayText

# Refresh the tooltip occasionally so it reflects reality.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.add_Tick({ Update-TrayText })
$timer.Start()

# A hidden form is what keeps the message loop alive for the NotifyIcon.
$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)

$timer.Stop()
$notify.Visible = $false
$notify.Dispose()
Write-Log 'tray helper exiting'
