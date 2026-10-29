# Lists what a Windows installer carries (NSIS installers open as archives in 7-Zip), to see which app packages it has.
param([string]$Setup)
Write-Host "Contents of $Setup"
& 7z l $Setup | Select-String -Pattern '\.7z|\.nsis|PLUGINSDIR|app-|\.exe' | ForEach-Object { $_.Line }
