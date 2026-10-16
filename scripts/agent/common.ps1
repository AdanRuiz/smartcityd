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

# Property access that tolerates missing members under Set-StrictMode.
function Get-Prop($Obj, [string]$Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($p) { return $p.Value } else { return $null }
}
