@echo off
REM Double-click to launch the overlay. Launches Electron directly (no PowerShell).
if not exist "%~dp0electron\electron.exe" (
  echo Electron is not installed yet. Run setup.bat first.
  pause
  exit /b 1
)
start "" "%~dp0electron\electron.exe" "%~dp0app"
