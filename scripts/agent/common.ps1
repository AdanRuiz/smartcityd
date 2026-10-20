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
