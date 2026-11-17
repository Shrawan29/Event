@echo off
rem Double-click to run Event Arrivals on this computer (no internet needed).
rem Keep this window open while you use it; close it to stop.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node dev\local-server.js --open
pause
