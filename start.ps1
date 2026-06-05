# Launches the overlay with the local Electron binary. No npm.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $root "electron\electron.exe"
$app  = Join-Path $root "app"

if (-not (Test-Path $exe)) {
  Write-Host "Electron is not installed yet." -ForegroundColor Yellow
  Write-Host "Run  .\download-electron.ps1  (or setup.bat) first — it downloads and checksum-verifies the official binary."
  exit 1
}

& $exe $app
