<#
.SYNOPSIS
  Registers (or removes) the Windows scheduled task that runs scripts/agent/run.ps1
  a few minutes after the current user logs on and then every hour while the
  session is open, so a merged PR is followed by the next task. Idle runs only
  query git and GitHub; they do not use Claude quota. No admin rights needed.
  With -Engine gemini it registers the second agent (Gemini through the
  Antigravity CLI, agy, with a Google account) as its own task,
  smartcity-agent-gemini, 5 minutes later by default, and adds the agent's
  allow and deny rules to agy's settings.json (a backup is kept next to it).
  -Uninstall removes the task and, for gemini, those rules.
  With -Engine openrouter it registers smartcity-agent-openrouter (Claude Code
  through OpenRouter with the user's OPENROUTER_API_KEY), 13 minutes later by
  default; it works Gemini's items and never runs at the same time as Gemini.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Uninstall
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Engine gemini
  powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Engine openrouter
#>
param(
  [ValidateSet('claude', 'gemini', 'openrouter')]
  [string]$Engine = 'claude',
  [switch]$Uninstall,
  # Default: 3 for Claude, 8 for Gemini, 13 for OpenRouter, so they do not clone and install at the same moment.
  [int]$DelayMinutes = -1,
  [int]$EveryMinutes = 60
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'common.ps1')
$TaskName = if ($Engine -eq 'claude') { 'smartcity-agent' } else { "smartcity-agent-$Engine" }
if ($DelayMinutes -lt 0) { $DelayMinutes = @{ claude = 3; gemini = 8; openrouter = 13 }[$Engine] }

# Adds (or with -Remove takes out) the agent's rules in agy's settings.json, keeping a backup.
function Update-AgyRules([switch]$Remove) {
  $f = Get-AgySettingsPath
  if (-not (Test-Path $f)) { throw "No existe $f. Abre ``agy`` una vez e inicia sesion con Google." }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $text = [IO.File]::ReadAllText($f, $utf8)
  $cfg = $text | ConvertFrom-Json
  if (-not (Get-Prop $cfg 'permissions')) { $cfg | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{}) }
  foreach ($list in 'allow', 'deny') {
    $rules = if ($list -eq 'allow') { $AgyAllow } else { $AgyDeny }
    $current = @(Get-Prop $cfg.permissions $list | Where-Object { $null -ne $_ })
    $next = if ($Remove) { @($current | Where-Object { $rules -notcontains $_ }) } else { @($current + @($rules | Where-Object { $current -notcontains $_ })) }
    if ($cfg.permissions.PSObject.Properties[$list]) { $cfg.permissions.$list = $next } else { $cfg.permissions | Add-Member -NotePropertyName $list -NotePropertyValue $next }
  }
  $backup = "$f.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  [IO.File]::WriteAllText($backup, $text, $utf8)
  [IO.File]::WriteAllText($f, ($cfg | ConvertTo-Json -Depth 32), $utf8)
  Write-Host "$(if ($Remove) { 'Removed' } else { 'Added' }) the agent rules in $f (backup: $backup)."
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
  if ($Engine -eq 'gemini') { Update-AgyRules -Remove }
  return
}
if ($Engine -eq 'gemini') {
  Update-AgyRules
  Assert-AgySettings
}
# The scheduled task only sees the key if it is a user or system (not session) variable.
if ($Engine -eq 'openrouter' -and -not ([Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User') -or [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'Machine'))) {
  throw 'Define OPENROUTER_API_KEY as a user or system variable first. See docs/operacion/agente.md.'
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
