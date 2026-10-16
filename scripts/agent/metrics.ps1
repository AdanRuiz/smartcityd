<#
.SYNOPSIS
  Metrics of the unattended agent, computed only from GitHub: its PRs (agent/*
  branches) and the run log issue (label agent:bitacora).

.DESCRIPTION
  Prints a Markdown summary. With -Publish it also rewrites the metrics section of
  the log issue body (editing a body sends no notification). Grouping by prompt
  version tells whether a prompt change helped. See docs/operacion/agente.md.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\agent\metrics.ps1 -Days 7
#>
param(
  [int]$Days = 30,
  [string]$Repo,
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'common.ps1')

$Utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$LabelLog = 'agent:bitacora'
$StartMarker = '<!-- metrics:start -->'
$EndMarker = '<!-- metrics:end -->'

if (-not $Repo) {
  $url = [string](Exec { git -C (Join-Path $PSScriptRoot '..\..') remote get-url origin })
  if ($url.Trim() -notmatch 'github\.com[:/](.+?)(\.git)?$') { throw "origin is not a GitHub URL: $url" }
  $Repo = $Matches[1]
}
$Since = [DateTime]::UtcNow.AddDays(-$Days)

function U([string]$s) { return [regex]::Unescape($s) }  # non-ASCII text, e.g. U('M\u00e9tricas')
function ToUtc($s) { if ($s) { return [DateTimeOffset]::Parse([string]$s).UtcDateTime } else { return $null } }
function Median($xs) {
  $a = @($xs | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ } | Sort-Object)
  if ($a.Count -eq 0) { return $null }
  $m = [int][math]::Floor($a.Count / 2)
  if ($a.Count % 2) { return $a[$m] } else { return ($a[$m - 1] + $a[$m]) / 2 }
}
function Sum($xs) { $a = @($xs | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ }); if ($a.Count) { return ($a | Measure-Object -Sum).Sum } else { return $null } }
function Pct($n, $d) { if ($d -gt 0) { return '{0:N0} %' -f (100.0 * $n / $d) } else { return '-' } }
function Num($x, [string]$f = '{0:N1}') { if ($null -eq $x) { return '-' } else { return $f -f $x } }
function Get-PromptVersion([string]$Text) { if ($Text -match 'prompts `([^`]+)`') { return $Matches[1] } else { return U('sin versi\u00f3n') } }

function Get-CiState($Rollup) {
  $checks = @($Rollup)
  if ($checks.Count -eq 0) { return 'none' }
  $red = 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'
  foreach ($c in $checks) {
    $result = Get-Prop $c 'conclusion'; if (-not $result) { $result = Get-Prop $c 'state' }
    if ($red -contains [string]$result) { return 'red' }
  }
  foreach ($c in $checks) {
    $status = Get-Prop $c 'status'
    if ($status -and $status -ne 'COMPLETED') { return 'pending' }
  }
  return 'green'
}

# --- PRs opened by the agent ---------------------------------------------------
$prs = @((Get-GhJson { gh pr list --repo $Repo --state all --limit 300 --json number,headRefName,state,isDraft,createdAt,mergedAt,additions,deletions,body,statusCheckRollup }) |
  ForEach-Object { $_ } |
  Where-Object { $_.headRefName -like 'agent/*' -and (ToUtc $_.createdAt) -ge $Since } |
  ForEach-Object {
    $created = ToUtc $_.createdAt
    $merged = ToUtc (Get-Prop $_ 'mergedAt')
    [pscustomobject]@{
      kind = if ($_.headRefName -like 'agent/issue-*') { 'issue' } else { 'roadmap' }
      prompt = Get-PromptVersion ([string](Get-Prop $_ 'body'))
      state = [string]$_.state
      draft = [bool]$_.isDraft
      hours = if ($merged) { ($merged - $created).TotalHours } else { $null }
      lines = [int]$_.additions + [int]$_.deletions
      ci = Get-CiState (Get-Prop $_ 'statusCheckRollup')
    }
  })

function Get-PrRow([string]$Name, $Items) {
  $items = @($Items | Where-Object { $null -ne $_ })
  $merged = @($items | Where-Object { $_.state -eq 'MERGED' }).Count
  $closed = @($items | Where-Object { $_.state -eq 'CLOSED' }).Count
  return "| $Name | $($items.Count) | $merged | $closed | $(@($items | Where-Object { $_.state -eq 'OPEN' }).Count) | " +
    "$(Pct $merged ($merged + $closed)) | $(Num (Median ($items | ForEach-Object { $_.hours }))) | " +
    "$(@($items | Where-Object { $_.draft }).Count) | $(@($items | Where-Object { $_.ci -eq 'red' }).Count) | " +
    "$(Num (Median ($items | ForEach-Object { $_.lines })) '{0:N0}') |"
}

# --- Sessions, from the run log comments --------------------------------------
$logIssue = @((Get-GhJson { gh issue list --repo $Repo --label $LabelLog --state open --limit 1 --json number }) | ForEach-Object { $_ })
$sessions = New-Object System.Collections.ArrayList
$failedRuns = 0
$logNumber = $null
if ($logIssue.Count -gt 0) {
  $logNumber = [string]$logIssue[0].number
  $view = @(Get-GhJson { gh issue view $logNumber --repo $Repo --json comments })[0]
  foreach ($c in @($view.comments)) {
    $body = [string]$c.body
    if ($body -notmatch '^### Corrida (\S+)' -or $Matches[1] -like 'prueba-*' -or (ToUtc $c.createdAt) -lt $Since) { continue }
    $prompt = Get-PromptVersion $body
    if ($body -like '*La corrida fallo:*') { $failedRuns++ }
    $header = $null
    foreach ($line in ($body -split "`r?`n")) {
      if ($line -notlike '|*') { $header = $null; continue }
      $cells = @(($line.Trim().Trim('|') -split '(?<!\\)\|') | ForEach-Object { $_.Trim() })
      if ($null -eq $header) { if ($cells[0] -eq 'Tarea') { $header = $cells }; continue }
      if ($cells[0] -like '---*') { continue }
      $row = @{}; for ($i = 0; $i -lt [math]::Min($header.Count, $cells.Count); $i++) { $row[$header[$i]] = $cells[$i] }
      $num = { param($v) if ($v -match '^-?[0-9]+([.,][0-9]+)?$') { [double]($v -replace ',', '.') } else { $null } }
      [void]$sessions.Add([pscustomobject]@{
        prompt = $prompt
        blocked = [string]$row['Resultado'] -like 'Bloqueado*'
        turns = & $num $row['Turnos']; minutes = & $num $row['Min']
        denials = & $num $row['Denegaciones']; usd = & $num $row['USD eq. API']
      })
    }
  }
}

function Get-SessionRow([string]$Name, $Items) {
  $items = @($Items | Where-Object { $null -ne $_ })
  $blocked = @($items | Where-Object { $_.blocked }).Count
  return "| $Name | $($items.Count) | $blocked ($(Pct $blocked $items.Count)) | $(Num (Median ($items | ForEach-Object { $_.turns })) '{0:N0}') | " +
    "$(Num (Median ($items | ForEach-Object { $_.minutes }))) | $(Num (Sum ($items | ForEach-Object { $_.minutes }))) | " +
    "$(Num (Sum ($items | ForEach-Object { $_.denials })) '{0:N0}') | $(Num (Sum ($items | ForEach-Object { $_.usd })) '{0:N2}') |"
}

# --- Report -------------------------------------------------------------------
$out = @(
  $StartMarker,
  (U "## M\u00e9tricas (\u00faltimos $Days d\u00edas)"),
  '',
  "_Actualizado el $((Get-Date).ToString('yyyy-MM-dd HH:mm')) por ``scripts/agent/metrics.ps1``._",
  '',
  '### PRs del agente',
  '',
  (U '| Grupo | PRs | Mezclados | Cerrados sin mezclar | Abiertos | Tasa de merge | Horas a merge (mediana) | Borradores | CI rojo | L\u00edneas (mediana) |'),
  '|---|---|---|---|---|---|---|---|---|---|',
  (Get-PrRow 'Todos' $prs),
  (Get-PrRow 'Issues' ($prs | Where-Object { $_.kind -eq 'issue' })),
  (Get-PrRow 'Roadmap' ($prs | Where-Object { $_.kind -eq 'roadmap' }))
)
foreach ($v in @($prs | ForEach-Object { $_.prompt } | Sort-Object -Unique)) {
  $out += Get-PrRow "prompts ``$v``" ($prs | Where-Object { $_.prompt -eq $v })
}
$out += '', (U '### Sesiones (desde los comentarios de esta bit\u00e1cora)'), ''
$out += '| Grupo | Tareas | Bloqueadas | Turnos (mediana) | Min (mediana) | Min (total) | Denegaciones | USD eq. API |'
$out += '|---|---|---|---|---|---|---|---|'
$out += Get-SessionRow 'Todas' $sessions
foreach ($v in @($sessions | ForEach-Object { $_.prompt } | Sort-Object -Unique)) {
  $out += Get-SessionRow "prompts ``$v``" ($sessions | Where-Object { $_.prompt -eq $v })
}
$out += '', (U "Corridas fallidas: $failedRuns. **Tasa de merge** = mezclados / (mezclados + cerrados sin mezclar). **CI rojo**: estado del CI en el \u00faltimo commit del PR."), $EndMarker
$report = $out -join "`n"
Write-Output $report

if ($Publish) {
  if (-not $logNumber) { Write-Host 'No open run log issue; nothing to publish.'; return }
  $current = [string](@(Get-GhJson { gh issue view $logNumber --repo $Repo --json body })[0].body)
  $pattern = '(?s)' + [regex]::Escape($StartMarker) + '.*?' + [regex]::Escape($EndMarker)
  $new = if ($current -match $pattern) { [regex]::Replace($current, $pattern, { param($m) $report }) } else { $current.TrimEnd() + "`n`n" + $report }
  $file = Join-Path ([IO.Path]::GetTempPath()) "smartcity-metrics-$PID.md"
  [IO.File]::WriteAllText($file, $new, $Utf8)
  Exec { gh issue edit $logNumber --repo $Repo --body-file $file 2>&1 } | Out-Host
  Remove-Item $file -Force
}
