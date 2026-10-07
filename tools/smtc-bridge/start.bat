@echo off
REM Chorus built-in SMTC bridge.
REM
REM Serves Windows SMTC as the same REST API that nuttylmao/smtc-bridge exposes,
REM so Chorus can be pointed at either one.
REM
REM Default port is 5010, NOT 5000 - the stock SMTC-Bridge usually owns 5000, and
REM running both at once is the whole point of having an alternative.
REM
REM Leave this window open while it runs; Ctrl+C stops it.

setlocal
cd /d "%~dp0"

set PORT=%1
if "%PORT%"=="" set PORT=5010

echo.
echo   Chorus built-in SMTC bridge
echo   http://127.0.0.1:%PORT%/now-playing
echo.
echo   Point Chorus at it with:  Source ^> smtc-bridge address
echo   Or run once and print JSON:  server.bat --once
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port %PORT% %2 %3 %4

echo.
echo   Bridge stopped.
pause
