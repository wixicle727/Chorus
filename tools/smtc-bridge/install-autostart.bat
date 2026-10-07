@echo off
REM Chorus built-in SMTC bridge - auto-start control.
REM
REM   install-autostart.bat              show the current status
REM   install-autostart.bat enable       start the bridge at Windows sign-in
REM   install-autostart.bat disable      stop starting it at sign-in
REM   install-autostart.bat enable 5020  register on a different port
REM
REM Registers under HKCU, so no administrator rights are needed. This is separate
REM from Chorus's own auto-start entry: either can be set up without the other.

setlocal
cd /d "%~dp0"

set ACTION=%1
if "%ACTION%"=="" set ACTION=Status
set PORT=%2
if "%PORT%"=="" set PORT=5010

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Action %ACTION% -Port %PORT% %3 %4 %5

echo.
pause
