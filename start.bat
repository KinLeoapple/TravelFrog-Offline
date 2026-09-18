@echo off
rem Travel Frog China offline edition - double-click launcher
rem Auto-installs dependencies on first run, then starts the game window.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, please wait a few minutes...
  call npm install
)
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
