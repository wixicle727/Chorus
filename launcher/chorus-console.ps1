# Chorus - server wrapper.
#
# Runs the Node server with its output redirected to data\logs\chorus.log, so the
# tray's "View server console" shows the real thing. Intended to be launched
# hidden by chorus-tray.ps1; run it directly to watch the server in a window.

param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 0,
  [switch]$OpenPanel
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $Root)) { $Root = Split-Path -Parent $PSScriptRoot }
$logDir = Join-Path $Root 'data\logs'
$logFile = Join-Path $logDir 'chorus.log'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# UTF-8 WITHOUT a byte-order mark. `Add-Content -Encoding UTF8` on Windows
# PowerShell 5.1 emits a BOM, which turns the log into mojibake.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log {
  param([string]$Message)
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $safe = $Message -replace '[^\x20-\x7E]', '-'
  try { [System.IO.File]::AppendAllText($logFile, "[$stamp] [wrapper] $safe`r`n", $utf8NoBom) } catch { }
}

Write-Log 'Chorus server wrapper starting'

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Log 'ERROR node.exe not found on PATH'
  exit 1
}

# The server writes the log itself, in UTF-8, via --log-file.
#
# Its output is deliberately NOT piped through PowerShell: Windows PowerShell 5.1
# decodes a redirected pipe using the ANSI codepage, so the banner's box-drawing
# characters arrive as mojibake. Letting node own the file keeps one encoding.
$nodeArgs = @(
  (Join-Path $Root 'src\index.js'),
  '--background',              # no browser, no console dependency
  '--quiet',                   # compact log header instead of the banner art
  '--log-file', $logFile
)
if ($Port -gt 0) { $nodeArgs += @('--port', $Port) }

& $node.Source @nodeArgs
$code = $LASTEXITCODE

Write-Log "server exited with code $code"

if ($OpenPanel -and $code -ne 0) {
  Write-Host ""
  Write-Host "  Chorus server exited with code $code. See $logFile" -ForegroundColor Red
  Read-Host "  Press Enter to close"
}

exit $code


