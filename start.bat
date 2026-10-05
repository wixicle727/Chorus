@echo off
REM Chorus launcher.
REM Starts the engine hidden in the background with a system tray icon, so you
REM can reach the control panel, the log and Quit without keeping a console open.
REM
REM Use this for everyday use. To watch the server output in this window instead,
REM run:  node src\index.js

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install Node.js 20 or newer from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Chorus in the background...
echo   Look for the tray icon near the clock for the control panel and Quit.
echo.

start "" wscript.exe "%~dp0launcher\chorus-hidden.vbs"

echo   Chorus is starting. This window will close in a moment.
timeout /t 3 >nul
