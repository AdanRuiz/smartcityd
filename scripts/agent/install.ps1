<#
.SYNOPSIS
  Registers (or removes) the Windows scheduled task that runs scripts/agent/run.ps1
  a few minutes after the current user logs on. No admin rights needed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Uninstall
#>
param(
  [switch]$Uninstall,
  [int]$DelayMinutes = 3
)

$ErrorActionPreference = 'Stop'
$TaskName = 'smartcity-agent'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
  return
}

$script = Join-Path $PSScriptRoot 'run.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT${DelayMinutes}M"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'SmartCity: unattended Claude Code agent (docs/operacion/agente.md)' -Force | Out-Null
Write-Host "Registered '$TaskName': runs $script $DelayMinutes min after $user logs on."
Write-Host "Run it now with: Start-ScheduledTask -TaskName $TaskName"
