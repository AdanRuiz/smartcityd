<#
.SYNOPSIS
  Registers (or removes) the Windows scheduled task that runs scripts/agent/run.ps1
  a few minutes after the current user logs on and then every hour while the
  session is open, so a merged PR is followed by the next task. Idle runs only
  query git and GitHub; they do not use Claude quota. No admin rights needed.
  With -Engine gemini it registers the second agent (Gemini CLI with a Google
  account) as its own task, smartcity-agent-gemini, 5 minutes later by default.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Uninstall
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Engine gemini
#>
param(
  [ValidateSet('claude', 'gemini')]
  [string]$Engine = 'claude',
  [switch]$Uninstall,
  # Default: 3 for Claude, 8 for Gemini, so both do not clone and install at the same moment.
  [int]$DelayMinutes = -1,
  [int]$EveryMinutes = 60
)

$ErrorActionPreference = 'Stop'
$TaskName = if ($Engine -eq 'gemini') { 'smartcity-agent-gemini' } else { 'smartcity-agent' }
if ($DelayMinutes -lt 0) { $DelayMinutes = if ($Engine -eq 'gemini') { 8 } else { 3 } }

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
  return
}

$script = Join-Path $PSScriptRoot 'run.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Engine $Engine"
$every = New-TimeSpan -Minutes $EveryMinutes
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $user
$atLogOn.Delay = "PT${DelayMinutes}M"
# Repeat for as long as the session lasts (no duration = indefinitely).
$atLogOn.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval $every).Repetition
# A logon trigger only starts repeating at the next logon, so a task registered
# mid-session would sit idle until then. This one repeats from now on; the
# Interactive principal keeps it from running while logged off, and
# IgnoreNew drops a run that overlaps another.
$fromNow = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($DelayMinutes) -RepetitionInterval $every
$trigger = @($atLogOn, $fromNow)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "SmartCity: unattended $Engine agent (docs/operacion/agente.md)" -Force | Out-Null
Write-Host "Registered '$TaskName': runs $script in $DelayMinutes min and $DelayMinutes min after $user logs on, then every $EveryMinutes min."
Write-Host "Run it now with: Start-ScheduledTask -TaskName $TaskName"
