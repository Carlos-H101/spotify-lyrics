@echo off
REM Double-click once to download + verify the official Electron binary.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-electron.ps1"
pause
