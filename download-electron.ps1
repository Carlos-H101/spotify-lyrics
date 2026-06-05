# Downloads the official Electron prebuilt binary and verifies its SHA256
# against Electron's published checksums. No npm, no package manager involved.
#
#   .\download-electron.ps1            # latest stable
#   .\download-electron.ps1 -Version 42.3.3
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $root "electron"

if (-not $Version) {
  Write-Host "Looking up the latest stable Electron release..."
  $rel = Invoke-RestMethod "https://api.github.com/repos/electron/electron/releases/latest" `
    -Headers @{ "User-Agent" = "lyrics-overlay-setup" }
  $Version = $rel.tag_name.TrimStart("v")
}

$zip  = "electron-v$Version-win32-x64.zip"
$base = "https://github.com/electron/electron/releases/download/v$Version"
$tmp  = Join-Path $env:TEMP $zip

Write-Host "Downloading $zip ..."
Invoke-WebRequest "$base/$zip" -OutFile $tmp

Write-Host "Downloading SHASUMS256.txt ..."
$raw = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
# Invoke-WebRequest may hand back the body as a byte[]; normalize to text.
$sums = if ($raw -is [byte[]]) { [Text.Encoding]::UTF8.GetString($raw) } else { [string]$raw }

$line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zip) } | Select-Object -First 1)
if (-not $line) { throw "Could not find $zip in the published checksums." }
$expected = ($line.Trim() -split "\s+")[0].ToLower()
$actual   = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()

if ($expected -ne $actual) {
  Remove-Item $tmp -Force
  throw "CHECKSUM MISMATCH. expected=$expected actual=$actual  (download discarded)"
}
Write-Host "Checksum verified: $actual" -ForegroundColor Green

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Write-Host "Extracting to $dest ..."
Expand-Archive $tmp -DestinationPath $dest
Remove-Item $tmp -Force

Write-Host "Electron $Version is ready." -ForegroundColor Green
Write-Host "Next: run .\start.ps1 (or start.bat) to launch the overlay."
