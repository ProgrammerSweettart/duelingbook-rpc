# Windows autostart. Untested by the author — reports welcome.
# Registers a logon task that runs the service hidden. Run in PowerShell from the project folder:
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1
$ErrorActionPreference = 'Stop'
$dir  = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
Write-Host "node:    $node"
Write-Host "project: $dir"
if (-not (Test-Path "$dir\node_modules\@xhayper\discord-rpc")) {
  Write-Host "installing dependencies..."
  Push-Location $dir; npm install --omit=dev --no-audit --no-fund; Pop-Location
}
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\server.js`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'duelingbook-rpc' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'duelingbook-rpc'
Start-Sleep -Seconds 2
try { Invoke-RestMethod http://127.0.0.1:41337/ | Write-Host } catch { Write-Warning "service not responding yet: $_" }
Write-Host "remove with: Unregister-ScheduledTask -TaskName duelingbook-rpc -Confirm:`$false"
