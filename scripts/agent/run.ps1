<#
.SYNOPSIS
  Unattended development agent. Fixes open GitHub issues labeled `agent`, then
  advances the roadmap by one small increment, opening one PR per task.

.DESCRIPTION
  Runs Claude Code headless (`claude -p`) on the user's subscription, inside an
  isolated clone under %LOCALAPPDATA%\smartcity-agent. The model only edits and
  commits; this script (read from the user's checkout, never from the clone)
  checks protected paths, runs build/lint/typecheck/test, pushes the branch and
  opens the PR. Nothing is ever merged or deployed. See docs/operacion/agente.md.

  ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#>
param(
  [int]$MaxIssues = 3,
  [int]$TaskTimeoutMinutes = 45,
  # Pinned so a Claude Code update cannot silently change the model behind the PRs.
  [string]$Model = 'claude-opus-5-5',
  [switch]$SkipRoadmap,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8

$SourceRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$StateDir = Join-Path $env:LOCALAPPDATA 'smartcity-agent'
$Clone = Join-Path $StateDir 'repo'
$BinDir = Join-Path $StateDir 'bin'
$LogDir = Join-Path $StateDir 'logs'
$RoadmapStamp = Join-Path $StateDir 'roadmap-last.txt'
$RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
. (Join-Path $PSScriptRoot 'common.ps1')

# Last commit that touched the prompts, so metrics.ps1 can compare prompt versions.
$PromptFiles = @('scripts/agent/prompt-issue.md', 'scripts/agent/prompt-roadmap.md')
$PromptVersion = [string](Exec { git -C $SourceRepo log -1 --format=%h -- @PromptFiles } -AllowFail)
if (-not $PromptVersion) { $PromptVersion = 'sin-version' }
if (Exec { git -C $SourceRepo status --porcelain -- @PromptFiles } -AllowFail) { $PromptVersion += '+local' }
$ClaudeVersion = 'desconocida'
try { $ClaudeVersion = ([string](Exec { claude.cmd --version } -AllowFail) -split ' ')[0] } catch { }

$LabelTodo = 'agent'
$LabelBlocked = 'agent:bloqueado'
# Any open issue with this label pauses the agent, so it can be stopped from GitHub (even a phone).
$LabelPause = 'agent:pausa'
# A pinned open issue with this label gets one comment per run that did something.
$LabelLog = 'agent:bitacora'
$Runs = New-Object System.Collections.ArrayList
$RunError = $null
$StopRun = $false
$Slug = $null
$LastStats = $null
$LastPrUrl = ''
# Paths the agent must never change; a PR touching them is not opened.
$ProtectedPaths = '^(\.github/|scripts/agent/|LICENSE$|pnpm-lock\.yaml$|.*\.env|.*\.dev\.vars$)'
$PrFooter = "Generado sin supervision por ``scripts/agent/run.ps1`` ($RunId, prompts ``$PromptVersion``, modelo ``$Model``, claude ``$ClaudeVersion``). Revisar antes de mezclar.`n`n" +
  [char]::ConvertFromUtf32(0x1F916) + ' Generated with [Claude Code](https://claude.com/claude-code)'

# Permissions for the headless session. Everything not allowed is denied, since
# -p mode cannot prompt. Deploys are also blocked by a bogus Cloudflare token.
$ClaudeSettings = @{
  permissions = @{
    allow = @(
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(pnpm *)', 'Bash(node *)',
      'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)',
      'Bash(git add *)', 'Bash(git commit *)', 'Bash(git rm *)', 'Bash(git mv *)', 'Bash(git restore *)',
      'Bash(ls*)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)',
      'Bash(grep *)', 'Bash(find *)', 'Bash(sort *)', 'Bash(diff *)', 'Bash(mkdir *)'
    )
    deny = @(
      'Bash(git push*)', 'Bash(git remote*)', 'Bash(git config*)', 'Bash(gh *)',
      'Bash(*deploy*)', 'Bash(*wrangler*)', 'Bash(*--remote*)',
      'Bash(pnpm add*)', 'Bash(pnpm remove*)', 'Bash(pnpm up*)', 'Bash(pnpm update*)',
      'Bash(pnpm dlx*)', 'Bash(pnpm publish*)', 'Bash(npx *)', 'Bash(curl *)', 'Bash(wget *)',
      'PowerShell', 'WebFetch', 'WebSearch'
    )
  }
}

function Reset-Clone {
  Exec { git -C $Clone fetch --prune origin 2>&1 } | Out-Host
  Exec { git -C $Clone checkout --force --detach origin/main 2>&1 } | Out-Host
  Exec { git -C $Clone clean -fd 2>&1 } | Out-Host
}

function Test-RemoteBranch([string]$Name) {
  return [bool](Exec { git -C $Clone ls-remote --heads origin $Name })
}

function Test-Checks {
  foreach ($step in 'build', 'lint', 'typecheck', 'test') {
    Exec { pnpm --dir $Clone $step 2>&1 } -AllowFail | Out-Host
    if ($LASTEXITCODE -ne 0) { return "pnpm $step" }
  }
  return $null
}

# Errors worth retrying on a later run: quota, rate limits, overload, network.
$TransientStatus = 429, 500, 502, 503, 504, 529
$TransientText = 'usage limit|rate limit|limit reached|overloaded|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket hang up'

# Returns @{ status = 'ok' | 'transient' | 'error'; text = <result or reason> }.
function Invoke-Claude([string]$Prompt, [string]$Tag) {
  $promptFile = Join-Path $StateDir "prompt-$RunId.md"
  $settingsFile = Join-Path $StateDir 'claude-settings.json'
  $outFile = Join-Path $LogDir "$RunId-$Tag-claude.json"
  $errFile = Join-Path $LogDir "$RunId-$Tag-claude.err"
  [IO.File]::WriteAllText($promptFile, $Prompt, $Utf8)
  [IO.File]::WriteAllText($settingsFile, ($ClaudeSettings | ConvertTo-Json -Depth 5), $Utf8)

  $exe = Get-Command claude.exe, claude.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  $argLine = "-p --model $Model --output-format json --permission-mode acceptEdits --no-session-persistence --settings `"$settingsFile`""
  $p = Start-Process -FilePath $exe.Source -ArgumentList $argLine -WorkingDirectory $Clone `
    -RedirectStandardInput $promptFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
    -NoNewWindow -PassThru
  # A timeout is not retried: the same task would likely time out again.
  if (-not $p.WaitForExit($TaskTimeoutMinutes * 60000)) {
    Write-Host "Claude exceeded $TaskTimeoutMinutes min; killing it."
    Exec { taskkill /PID $p.Id /T /F 2>&1 } -AllowFail | Out-Host
    return @{ status = 'error'; text = "la sesion excedio $TaskTimeoutMinutes min; conviene partir la tarea" }
  }
  $raw = [IO.File]::ReadAllText($outFile, $Utf8)
  $stderr = if (Test-Path $errFile) { [IO.File]::ReadAllText($errFile, $Utf8).Trim() } else { '' }
  try { $json = $raw | ConvertFrom-Json } catch { $json = $null }
  if ($null -eq $json) {
    # No JSON at all: the CLI died before answering (crash, network, auth).
    $why = (($stderr -split "`r?`n") | Where-Object { $_ } | Select-Object -First 1)
    Write-Host "Unreadable Claude output. stdout: $raw stderr: $stderr"
    return @{ status = 'transient'; text = "la CLI de Claude no respondio: $why" }
  }
  $script:LastStats = @{
    turns = Get-Prop $json 'num_turns'
    minutes = [math]::Round([double](Get-Prop $json 'duration_ms') / 60000, 1)
    denials = @(Get-Prop $json 'permission_denials').Count
    usd = Get-Prop $json 'total_cost_usd'
    model = ''
  }
  $usage = Get-Prop $json 'modelUsage'
  if ($usage) { $script:LastStats.model = @($usage.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ' }
  $result = [string](Get-Prop $json 'result')
  if (Get-Prop $json 'is_error') {
    $status = Get-Prop $json 'api_error_status'
    Write-Host "Claude reported an error (api_error_status=$status): $result"
    $transient = ($status -and $TransientStatus -contains [int]$status) -or ("$result $stderr" -match $TransientText)
    $reason = if ($status) { "error de la API ($status): $result" } else { $result }
    return @{ status = $(if ($transient) { 'transient' } else { 'error' }); text = $reason }
  }
  return @{ status = 'ok'; text = $result }
}

function Test-Paused {
  $pause = @((Get-GhJson { gh issue list --repo $Slug --label $LabelPause --state open --limit 1 --json number }) | ForEach-Object { $_ })
  if ($pause.Count -gt 0) { Write-Host "Paused by open issue #$($pause[0].number) labeled '$LabelPause'." }
  return $pause.Count -gt 0
}

function Write-TempFile([string]$Text) {
  $f = Join-Path $StateDir "body-$RunId.md"
  [IO.File]::WriteAllText($f, $Text, $Utf8)
  return $f
}

# Returns 'pr', 'draft', 'blocked: <reason>' or 'retry: <reason>' (transient; try again on a later run).
function Invoke-Task([string]$Branch, [string]$Prompt, [string]$Closes) {
  Write-Host "=== $Branch ==="
  $script:LastStats = $null
  $script:LastPrUrl = ''
  Reset-Clone
  Exec { git -C $Clone checkout -B $Branch 2>&1 } | Out-Host
  Exec { pnpm --dir $Clone install --frozen-lockfile 2>&1 } | Out-Host
  if ($DryRun) { Write-Host "[dry-run] would run Claude on $Branch"; return 'dry-run' }

  $session = Invoke-Claude $Prompt ($Branch -replace '^agent/', '')
  if ($session.status -eq 'transient') { return "retry: $($session.text)" }
  if ($session.status -eq 'error') { return "blocked: $($session.text)" }
  $result = $session.text
  $lines = $result.Trim() -split "`r?`n", 2
  $first = $lines[0].Trim()
  $rest = if ($lines.Count -gt 1) { $lines[1].Trim() } else { '' }

  # Uncommitted leftovers are discarded; only commits count.
  Exec { git -C $Clone reset --hard 2>&1 } | Out-Host
  Exec { git -C $Clone clean -fd 2>&1 } | Out-Host
  $commits = [int](Exec { git -C $Clone rev-list --count origin/main..HEAD })
  if ($first -like 'BLOQUEADO:*') { return "blocked: $($first.Substring(10).Trim())`n`n$rest" }
  if ($commits -eq 0) { return "blocked: el agente termino sin commits.`n`n$result" }

  $changed = @(Exec { git -C $Clone diff --name-only origin/main...HEAD })
  $protected = @($changed | Where-Object { $_ -match $ProtectedPaths })
  if ($protected.Count -gt 0) { return "blocked: el cambio toca rutas protegidas: $($protected -join ', ')" }

  $failed = Test-Checks
  $title = if ($first -like 'TITULO:*') { $first.Substring(7).Trim() } else { "Agente: $Branch" }
  $body = if ($first -like 'TITULO:*') { $rest } else { $result }
  if ($failed) { $body = "> **Las verificaciones locales fallaron en ``$failed``.** PR en borrador.`n`n$body" }
  if ($Closes) { $body += "`n`nCloses #$Closes" }
  $body += "`n`n---`n$PrFooter"

  Exec { git -C $Clone push $RemoteUrl "HEAD:refs/heads/$Branch" 2>&1 } | Out-Host
  $prArgs = @('pr', 'create', '--repo', $Slug, '--base', 'main', '--head', $Branch,
    '--title', $title, '--body-file', (Write-TempFile $body))
  if ($failed) { $prArgs += '--draft' }
  $prOut = @(Exec { gh @prArgs 2>&1 })
  $prOut | Out-Host
  $script:LastPrUrl = [string]($prOut | Where-Object { "$_" -match '^https://' } | Select-Object -Last 1)
  if ($failed) { return 'draft' } else { return 'pr' }
}

function Add-RunRow([string]$Task, [string]$Outcome) {
  $text = switch -Wildcard ($Outcome) {
    'pr' { 'PR abierto' }
    'draft' { 'PR en borrador (verificaciones rojas)' }
    'blocked:*' { 'Bloqueado: ' + (($Outcome.Substring(8).Trim() -split "`r?`n")[0]) }
    'retry:*' { 'Reintento: ' + (($Outcome.Substring(6).Trim() -split "`r?`n")[0]) }
    default { $Outcome }
  }
  $s = $LastStats
  [void]$Runs.Add([pscustomobject]@{
    task = $Task; outcome = $text; pr = $LastPrUrl
    turns = if ($s) { $s.turns } else { '-' }
    minutes = if ($s) { $s.minutes } else { '-' }
    denials = if ($s) { $s.denials } else { '-' }
    usd = if ($s -and $null -ne $s.usd) { '{0:N2}' -f [double]$s.usd } else { '-' }
    model = if ($s -and $s.model) { $s.model } else { '-' }
  })
}

function Get-LogIssue {
  $found = @((Get-GhJson { gh issue list --repo $Slug --label $LabelLog --state open --limit 1 --json number }) | ForEach-Object { $_ })
  if ($found.Count -gt 0) { return [string]$found[0].number }
  Exec { gh label create $LabelLog --repo $Slug --color 0e8a16 --description 'Bitacora de corridas del agente' --force 2>&1 } | Out-Host
  $tpl = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'bitacora.md'), $Utf8) -split "`r?`n", 2
  $url = [string](Exec { gh issue create --repo $Slug --title $tpl[0].TrimStart('#', ' ') --label $LabelLog --body-file (Write-TempFile $tpl[1].Trim()) } |
    Where-Object { "$_" -match '^https://' } | Select-Object -Last 1)
  $number = ($url.Trim() -split '/')[-1]
  Exec { gh issue pin $number --repo $Slug 2>&1 } -AllowFail | Out-Host
  return $number
}

# One comment per run that ran a task or failed; quiet runs stay silent.
function Publish-RunLog {
  if ($DryRun -or -not $Slug -or ($Runs.Count -eq 0 -and -not $RunError)) { return }
  $cell = { param($v) ("$v" -replace '\r?\n', ' ' -replace '\|', '\|') }
  $used = @($Runs | ForEach-Object { $_.model } | Where-Object { $_ -and $_ -ne '-' } | Sort-Object -Unique) -join ', '
  if (-not $used) { $used = $Model }
  $lines = @("### Corrida $RunId - prompts ``$PromptVersion`` - modelo ``$used`` - claude ``$ClaudeVersion``", '')
  if ($Runs.Count -gt 0) {
    $lines += '| Tarea | Resultado | PR | Turnos | Min | Denegaciones | USD eq. API |'
    $lines += '|---|---|---|---|---|---|---|'
    foreach ($r in $Runs) {
      $lines += "| $(& $cell $r.task) | $(& $cell $r.outcome) | $($r.pr) | $($r.turns) | $($r.minutes) | $($r.denials) | $($r.usd) |"
    }
  }
  if ($RunError) { $lines += '', "**La corrida fallo:** ``$(& $cell $RunError)``" }
  $lines += '', "Log local: ``%LOCALAPPDATA%\smartcity-agent\logs\$RunId.log``"
  $issue = Get-LogIssue
  Exec { gh issue comment $issue --repo $Slug --body-file (Write-TempFile ($lines -join "`n")) 2>&1 } | Out-Host
}

New-Item -ItemType Directory -Force $LogDir, $BinDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir "$RunId.log") | Out-Null
$mutex = New-Object System.Threading.Mutex($false, 'Local\smartcity-agent')
if (-not $mutex.WaitOne(0)) { Write-Host 'Another run is in progress.'; Stop-Transcript | Out-Null; exit 0 }

try {
  Get-ChildItem $LogDir | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force

  foreach ($cmd in 'git', 'gh', 'corepack') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not in PATH. See docs/operacion/agente.md." }
  }
  if (-not (Get-Command claude.exe, claude.cmd -ErrorAction SilentlyContinue)) { throw 'claude is not in PATH.' }

  # Subscription auth only: an API key in the environment would bill the API instead.
  Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
  $env:CLOUDFLARE_API_TOKEN = 'disabled-for-smartcity-agent'
  $env:GIT_TERMINAL_PROMPT = '0'
  Exec { corepack enable --install-directory $BinDir pnpm 2>&1 } | Out-Host
  $env:Path = "$BinDir;$env:Path"

  $RemoteUrl = [string](Exec { git -C $SourceRepo remote get-url origin })
  $RemoteUrl = $RemoteUrl.Trim()
  if ($RemoteUrl -notmatch 'github\.com[:/](.+?)(\.git)?$') { throw "origin is not a GitHub URL: $RemoteUrl" }
  $Slug = $Matches[1]

  # At logon the network may not be up yet.
  $online = $false
  for ($i = 0; $i -lt 20 -and -not $online; $i++) {
    Exec { git ls-remote --heads $RemoteUrl main 2>&1 } -AllowFail | Out-Null
    if ($LASTEXITCODE -eq 0) { $online = $true } else { Start-Sleep -Seconds 30 }
  }
  if (-not $online) { Write-Host 'No network after 10 min; giving up.'; return }
  Exec { gh auth status 2>&1 } | Out-Host
  if (Test-Paused) { return }

  if (-not (Test-Path (Join-Path $Clone '.git'))) { Exec { git clone $RemoteUrl $Clone 2>&1 } | Out-Host }
  Exec { git -C $Clone remote set-url origin $RemoteUrl }
  Exec { git -C $Clone remote set-url --push origin 'DISABLED-the-agent-cannot-push' }
  $userName = [string](Exec { git -C $SourceRepo config user.name })
  $userEmail = [string](Exec { git -C $SourceRepo config user.email })
  Exec { git -C $Clone config user.name "$($userName.Trim()) (agente)" }
  Exec { git -C $Clone config user.email $userEmail.Trim() }

  if (-not $DryRun) {
    Exec { gh label create $LabelTodo --repo $Slug --color 5319e7 --description 'Delegado al agente sin supervision' --force 2>&1 } | Out-Host
    Exec { gh label create $LabelBlocked --repo $Slug --color b60205 --description 'El agente no pudo resolverlo; necesita una persona' --force 2>&1 } | Out-Host
    Exec { gh label create $LabelPause --repo $Slug --color fbca04 --description 'Un issue abierto con esta etiqueta pausa al agente' --force 2>&1 } | Out-Host
  }

  # 1. Bugs: oldest labeled issue first, skipping those that already have a branch.
  $issues = @((Get-GhJson { gh issue list --repo $Slug --label $LabelTodo --state open --limit 50 --json number,title,body }) |
    ForEach-Object { $_ } | Sort-Object number)
  $done = 0
  foreach ($issue in $issues) {
    if ($StopRun -or $done -ge $MaxIssues -or (Test-Paused)) { break }
    $branch = "agent/issue-$($issue.number)"
    if (Test-RemoteBranch $branch) { Write-Host "Skipping #$($issue.number): $branch exists."; continue }
    $template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prompt-issue.md'), $Utf8)
    $prompt = "$template`n#$($issue.number): $($issue.title)`n`n$($issue.body)`n"
    $outcome = Invoke-Task $branch $prompt ([string]$issue.number)
    Write-Host "Issue #$($issue.number): $outcome"
    Add-RunRow "#$($issue.number) $($issue.title)" $outcome
    if ($outcome -like 'blocked:*') {
      Exec { gh issue comment $issue.number --repo $Slug --body-file (Write-TempFile "El agente no pudo resolver este issue.`n`n$($outcome.Substring(8).Trim())`n`n---`n$PrFooter") 2>&1 } | Out-Host
      Exec { gh issue edit $issue.number --repo $Slug --remove-label $LabelTodo --add-label $LabelBlocked 2>&1 } | Out-Host
    }
    # Quota or network trouble: leave the issue untouched and stop; the next run retries it.
    if ($outcome -like 'retry:*') { $StopRun = $true }
    $done++
  }

  # 2. Roadmap: one attempt per commit of main, never while a previous roadmap PR is unmerged.
  # Merging the PR moves main and unlocks the next task; a blocked attempt waits for main to change.
  $mainSha = ([string](Exec { git ls-remote $RemoteUrl refs/heads/main }) -split '\s+')[0]
  $last = if (Test-Path $RoadmapStamp) { (Get-Content $RoadmapStamp -Raw).Trim() } else { '' }
  $openRoadmap = @((Get-GhJson { gh pr list --repo $Slug --state open --limit 100 --json headRefName }) |
    ForEach-Object { $_ } | Where-Object { $_.headRefName -like 'agent/roadmap-*' })
  if ($SkipRoadmap) { Write-Host 'Roadmap skipped by flag.' }
  elseif ($StopRun) { Write-Host 'Roadmap skipped: a transient error stopped this run.' }
  elseif (Test-Paused) { }
  elseif ($openRoadmap.Count -gt 0) { Write-Host "Roadmap PR still open: $($openRoadmap[0].headRefName)." }
  elseif ($last -eq $mainSha) { Write-Host "Roadmap already attempted on main $($mainSha.Substring(0, 7)); waiting for main to change." }
  else {
    if (-not $DryRun) { Set-Content -Path $RoadmapStamp -Value $mainSha -Encoding ascii }
    $prompt = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prompt-roadmap.md'), $Utf8)
    $outcome = Invoke-Task "agent/roadmap-$RunId" $prompt ''
    Write-Host "Roadmap: $outcome"
    Add-RunRow 'roadmap' $outcome
    # A transient failure does not use up the attempt for this commit of main.
    if ($outcome -like 'retry:*' -and -not $DryRun) {
      if ($last) { Set-Content -Path $RoadmapStamp -Value $last -Encoding ascii } else { Remove-Item $RoadmapStamp -Force }
    }
  }
}
catch {
  Write-Host "Run aborted: $_"
  $RunError = "$_"
  exit 1
}
finally {
  try { Publish-RunLog } catch { Write-Host "Could not publish the run log: $_" }
  if (-not $DryRun -and $Slug -and $Runs.Count -gt 0) {
    try { & (Join-Path $PSScriptRoot 'metrics.ps1') -Repo $Slug -Publish | Out-Host } catch { Write-Host "Could not publish metrics: $_" }
  }
  if (Test-Path (Join-Path $Clone '.git')) { try { Reset-Clone } catch { Write-Host "Could not reset the clone: $_" } }
  $mutex.ReleaseMutex()
  Stop-Transcript | Out-Null
}
