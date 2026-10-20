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
#
# Tested with agy 1.1.28: `*` is not a wildcard (`command(git log)` matches only that exact
# line), `command(regex:...)` is, and deny wins over allow. A loose `.*` would also let
# chained commands through (`pnpm test; gh pr create`), so an allowed command may only be
# followed by plain words or quoted strings with no expansion: no ; & | $ ` % < > ( ) { }.
# A message with parentheses goes in quotes, as in git commit -m "Relay (RELAY-4)".
$AgyArg = '("[^"`$%]*"|''[^'']*''|[^\s"''`$%;&|<>(){}]+)'
# agy is a Go binary: RE2 rejects `\ `, so spaces in the prefix become ` +`.
function New-AgyAllowRule([string]$Prefix) { return 'command(regex:^{0}( +{1})*$)' -f ([regex]::Escape($Prefix) -replace '\\ ', ' +'), $AgyArg }
$AgyAllow = @(
  'pnpm', 'node',
  'git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git rm', 'git mv', 'git restore',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'sort', 'diff', 'mkdir'
) | ForEach-Object { New-AgyAllowRule $_ }
# agy matches a regex against the whole command line, so every deny rule ends in .*
# (a rule ending in \b never matched `pnpm add left-pad`).
$AgyDeny = @(
  'command(regex:^git +(push|remote|config)( .*)?$)',
  'command(regex:^pnpm +(add|remove|rm|up|update|dlx|publish|exec)( .*)?$)',
  'command(regex:^(pnpm|node) .*(deploy|wrangler|--remote).*$)',
  'command(regex:^(gh|npx|curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|powershell|pwsh|cmd)(\.exe)?( .*)?$)'
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
