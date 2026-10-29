# Installs DB Mastermind silently with the given installer and checks the result (see windows-install-check.yml).
param([string]$Setup)
Write-Host "Installer: $Setup"
Start-Process $Setup -ArgumentList '/S' -Wait
$dir = "$env:LOCALAPPDATA\Programs\DB Mastermind"
Write-Host "--- $dir"
Get-ChildItem $dir -ErrorAction SilentlyContinue | Format-Table Name, Length
Write-Host '--- Programs'
Get-ChildItem "$env:LOCALAPPDATA\Programs" | Format-Table Name
$exe = Join-Path $dir 'DB Mastermind.exe'
$shell = New-Object -ComObject WScript.Shell
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:USERPROFILE\Desktop" -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
  Where-Object Name -like '*Mastermind*' |
  ForEach-Object { $l = $shell.CreateShortcut($_.FullName); Write-Host "Shortcut $($_.FullName) -> $($l.TargetPath) (exists: $(Test-Path $l.TargetPath))" }
if (-not (Test-Path $exe)) { throw "Missing $exe" }
$machine = (Get-Item $exe).VersionInfo
Write-Host "Exe: $($machine.FileVersion)"
$bytes = [System.IO.File]::ReadAllBytes($exe)
$pe = [BitConverter]::ToInt32($bytes, 0x3C)
$m = [BitConverter]::ToUInt16($bytes, $pe + 4)
Write-Host ("Exe machine: 0x{0:X4} ({1})" -f $m, @{ 0x8664 = 'x64'; 0xAA64 = 'arm64'; 0x14C = 'x86' }[[int]$m])
$p = Start-Process $exe -PassThru
Start-Sleep -Seconds 15
if ($p.HasExited) { throw "The app exited right away with code $($p.ExitCode)" }
Write-Host "Running after 15 s (pid $($p.Id))"
Get-Process 'DB Mastermind' -ErrorAction SilentlyContinue | Stop-Process -Force
