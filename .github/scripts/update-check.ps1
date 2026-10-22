# Runs the installed app until electron-updater has downloaded $Latest, quits it normally (the update installs on
# quit) and checks the installed version. Prints the app's updater log on failure.
param([Parameter(Mandatory)] [string] $Latest)
$ErrorActionPreference = 'Stop'
$exe = "$env:LOCALAPPDATA\Programs\DB Mastermind\DB Mastermind.exe"
$log = "$env:APPDATA\DB Mastermind\logs\updater.log"

function Show-Diagnostics {
  Write-Host '--- updater.log ---'
  Get-Content $log -ErrorAction SilentlyContinue
  Write-Host '--- updater cache ---'
  Get-ChildItem "$env:LOCALAPPDATA" -Directory -Filter '*-updater' | ForEach-Object { Get-ChildItem $_.FullName -Recurse | Format-Table FullName, Length, LastWriteTime }
}

Write-Host "Installed: $((Get-Item $exe).VersionInfo.ProductVersion), expecting $Latest"
$app = Start-Process $exe -PassThru
# The download lands in <cache>\pending (installer.exe next to it is the installed version's own installer).
$deadline = (Get-Date).AddMinutes(8)
$found = $null
while ((Get-Date) -lt $deadline -and -not $found) {
  Start-Sleep -Seconds 10
  $found = Get-ChildItem "$env:LOCALAPPDATA" -Directory -Filter '*-updater' | ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'pending') -Filter '*.exe' -ErrorAction SilentlyContinue } | Where-Object { $_.Length -gt 50MB } | Select-Object -First 1
  if ($found -and (Get-Content $log -ErrorAction SilentlyContinue | Select-String 'downloaded;')) { break }
  if ($found) { $found = $null }
}
if (-not $found) { Show-Diagnostics; throw "The update to $Latest was not downloaded" }
Write-Host "Downloaded: $($found.FullName)"

$app.CloseMainWindow() | Out-Null
Start-Sleep -Seconds 5
if (Get-Process -Id $app.Id -ErrorAction SilentlyContinue) { taskkill /PID $app.Id /T | Out-Null }
$deadline = (Get-Date).AddMinutes(4)
do {
  Start-Sleep -Seconds 10
  $v = (Get-Item $exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
  Write-Host "Installed version: $v"
} while ((Get-Date) -lt $deadline -and -not ("$v" -like "$Latest*"))
if (-not ("$v" -like "$Latest*")) { Show-Diagnostics; throw "Expected $Latest after quitting, found $v" }
Show-Diagnostics
Write-Host "Updated to $Latest"
