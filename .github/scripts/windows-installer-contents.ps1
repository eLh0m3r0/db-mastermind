# Lists what a Windows installer carries (NSIS installers open as archives in 7-Zip), to see which app packages it has.
param([string]$Setup)
Write-Host "Contents of $Setup"
& 7z l $Setup | Select-String -Pattern '\.7z|\.nsis|PLUGINSDIR|app-|\.exe' | ForEach-Object { $_.Line }
# The compression methods of each app package (an old Nsis7z can't undo filters newer 7-Zip adds).
$tmp = Join-Path $env:RUNNER_TEMP ([IO.Path]::GetFileNameWithoutExtension($Setup))
& 7z x $Setup "-o$tmp" '$PLUGINSDIR\app-*.7z' -y | Out-Null
Get-ChildItem "$tmp\`$PLUGINSDIR\app-*.7z" | ForEach-Object {
  Write-Host "Methods in $($_.Name):"
  & 7z l -slt $_.FullName | Select-String '^Method = ' | Group-Object Line | ForEach-Object { Write-Host "  $($_.Count) x $($_.Name)" }
}
