# Runs OUTSIDE the Claude app container (via Task Scheduler) to materialize the
# toolchain on the real filesystem. The Claude desktop app is MSIX-packaged, so
# AppData writes from its child processes are virtualized into
# Packages\Claude_pzs8sxrjxfjjc\LocalCache — this copies them out to the real
# %LOCALAPPDATA% and fixes the real user PATH.

$ErrorActionPreference = 'Continue'
$source = "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\nodejs"
$dest = "$env:LOCALAPPDATA\nodejs"
$log = "$env:LOCALAPPDATA\avorant-fix-log.txt"

"started $(Get-Date -Format o)" | Out-File $log -Encoding ascii

robocopy $source $dest /E /NFL /NDL /NJH /NJS | Out-Null
"robocopy exit: $LASTEXITCODE" | Out-File $log -Append -Encoding ascii

$p = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($p -notlike '*\nodejs*') {
  [Environment]::SetEnvironmentVariable('Path', "$dest;$p", 'User')
  "PATH updated" | Out-File $log -Append -Encoding ascii
} else {
  "PATH already ok" | Out-File $log -Append -Encoding ascii
}

"node exists: $(Test-Path "$dest\node.exe")" | Out-File $log -Append -Encoding ascii
"codex exists: $(Test-Path "$dest\codex.cmd")" | Out-File $log -Append -Encoding ascii
"claude exists: $(Test-Path "$dest\claude.cmd")" | Out-File $log -Append -Encoding ascii
"done $(Get-Date -Format o)" | Out-File $log -Append -Encoding ascii
