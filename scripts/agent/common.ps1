# Helpers shared by run.ps1 and metrics.ps1. Dot-source it. ASCII only (see run.ps1).

function Exec([scriptblock]$Block, [switch]$AllowFail) {
  # Native stderr must not become a terminating error under 5.1.
  $ErrorActionPreference = 'Continue'
  # Merged stderr arrives as ErrorRecords; print them as plain lines.
  & $Block | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } }
  if (-not $AllowFail -and $LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Block" }
}

# gh prints JSON over several lines; 5.1's ConvertFrom-Json also emits arrays as one object.
function Get-GhJson([scriptblock]$Block) {
  $text = (Exec $Block) -join "`n"
  return , @($text | ConvertFrom-Json)
}

# Non-ASCII text in these ASCII-only scripts, e.g. U('M\u00e9tricas').
function U([string]$s) { return [regex]::Unescape($s) }

# Property access that tolerates missing members under Set-StrictMode.
function Get-Prop($Obj, [string]$Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($p) { return $p.Value } else { return $null }
}

# Weekly sprint of docs/backlog/producto.md: ISO week, Monday to Sunday, named like 2026-W43.
# Computed by hand because Windows PowerShell 5.1 (.NET Framework) has no ISOWeek class.
function Get-SprintWeek([datetime]$Day = (Get-Date)) {
  $d = $Day.Date
  $offset = ([int]$d.DayOfWeek + 6) % 7          # Monday = 0
  $monday = $d.AddDays(-$offset)
  $thursday = $monday.AddDays(3)                 # the ISO year is the year of its Thursday
  $week = [math]::Floor(($thursday.DayOfYear - 1) / 7) + 1
  return [pscustomobject]@{
    name = '{0}-W{1:00}' -f $thursday.Year, $week
    monday = $monday
    sunday = $monday.AddDays(6)
  }
}

# --- Gemini agent: Antigravity CLI (agy) ---------------------------------------
# agy has no flag or variable for another config dir, so the agent's rules live in the
# user's own settings.json. install.ps1 -Engine gemini adds them (and -Uninstall removes
# them); run.ps1 refuses to start without them. Same lists as $ClaudeSettings in run.ps1.
$AgyAllow = @(
  'command(pnpm *)', 'command(node *)',
  'command(git status*)', 'command(git diff*)', 'command(git log*)', 'command(git show*)',
  'command(git add *)', 'command(git commit *)', 'command(git rm *)', 'command(git mv *)', 'command(git restore *)',
  'command(ls*)', 'command(cat *)', 'command(head *)', 'command(tail *)', 'command(wc *)',
  'command(grep *)', 'command(find *)', 'command(sort *)', 'command(diff *)', 'command(mkdir *)'
)
$AgyDeny = @(
  'command(git push*)', 'command(git remote*)', 'command(git config*)', 'command(gh)', 'command(gh *)',
  'command(pnpm *deploy*)', 'command(pnpm *wrangler*)', 'command(pnpm *--remote*)',
  'command(node *deploy*)', 'command(node *wrangler*)', 'command(node *--remote*)',
  'command(pnpm add*)', 'command(pnpm remove*)', 'command(pnpm up*)', 'command(pnpm update*)',
  'command(pnpm dlx*)', 'command(pnpm publish*)', 'command(npx *)', 'command(curl *)', 'command(wget *)',
  'command(Invoke-WebRequest*)', 'command(Invoke-RestMethod*)', 'command(iwr *)', 'command(irm *)'
)

function Get-AgySettingsPath {
  return Join-Path (Join-Path (Join-Path $env:USERPROFILE '.gemini') 'antigravity-cli') 'settings.json'
}

# Throws unless agy is set up for the agent: Google account (no API key provider),
# no blanket auto-approval, and every allow and deny rule above present.
function Assert-AgySettings {
  $f = Get-AgySettingsPath
  if (-not (Test-Path $f)) { throw "No existe $f. Abre ``agy`` una vez, inicia sesion con Google y corre install.ps1 -Engine gemini." }
  $cfg = [IO.File]::ReadAllText($f, (New-Object System.Text.UTF8Encoding $false)) | ConvertFrom-Json
  if ((Get-Prop $cfg 'modelProvider') -eq 'gemini') { throw 'agy usa modelProvider "gemini" (API key); el agente solo usa la cuenta de Google.' }
  if ((Get-Prop $cfg 'toolPermission') -eq 'always-proceed') { throw 'agy tiene toolPermission "always-proceed", que aprobaria todo; el agente no corre asi.' }
  $perm = Get-Prop $cfg 'permissions'
  $allow = @(Get-Prop $perm 'allow')
  $deny = @(Get-Prop $perm 'deny')
  $missing = @($AgyAllow | Where-Object { $allow -notcontains $_ }) + @($AgyDeny | Where-Object { $deny -notcontains $_ })
  if ($missing.Count -gt 0) { throw "Faltan $($missing.Count) reglas del agente en $f; corre install.ps1 -Engine gemini." }
}
