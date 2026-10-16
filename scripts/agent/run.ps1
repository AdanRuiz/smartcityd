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

$LabelTodo = 'agent'
$LabelBlocked = 'agent:bloqueado'
# Any open issue with this label pauses the agent, so it can be stopped from GitHub (even a phone).
$LabelPause = 'agent:pausa'
# Paths the agent must never change; a PR touching them is not opened.
$ProtectedPaths = '^(\.github/|scripts/agent/|LICENSE$|pnpm-lock\.yaml$|.*\.env|.*\.dev\.vars$)'
$PrFooter = "Generado sin supervision por ``scripts/agent/run.ps1`` ($RunId). Revisar antes de mezclar.`n`n" +
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

function Exec([scriptblock]$Block, [switch]$AllowFail) {
  # Native stderr must not become a terminating error under 5.1.
  $ErrorActionPreference = 'Continue'
  & $Block
  if (-not $AllowFail -and $LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Block" }
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

function Invoke-Claude([string]$Prompt) {
  $promptFile = Join-Path $StateDir "prompt-$RunId.md"
  $settingsFile = Join-Path $StateDir 'claude-settings.json'
  $outFile = Join-Path $LogDir "$RunId-claude.json"
  $errFile = Join-Path $LogDir "$RunId-claude.err"
  [IO.File]::WriteAllText($promptFile, $Prompt, $Utf8)
  [IO.File]::WriteAllText($settingsFile, ($ClaudeSettings | ConvertTo-Json -Depth 5), $Utf8)

  $exe = Get-Command claude.exe, claude.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  $argLine = "-p --output-format json --permission-mode acceptEdits --no-session-persistence --settings `"$settingsFile`""
  $p = Start-Process -FilePath $exe.Source -ArgumentList $argLine -WorkingDirectory $Clone `
    -RedirectStandardInput $promptFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
    -NoNewWindow -PassThru
  if (-not $p.WaitForExit($TaskTimeoutMinutes * 60000)) {
    Write-Host "Claude exceeded $TaskTimeoutMinutes min; killing it."
    Exec { taskkill /PID $p.Id /T /F 2>&1 } -AllowFail | Out-Host
    return $null
  }
  $raw = [IO.File]::ReadAllText($outFile, $Utf8)
  try { $json = $raw | ConvertFrom-Json } catch { Write-Host "Unreadable Claude output: $raw"; return $null }
  if ($json.is_error) { Write-Host "Claude reported an error: $($json.result)"; return $null }
  return [string]$json.result
}

# gh prints JSON over several lines; 5.1's ConvertFrom-Json also emits arrays as one object.
function Get-GhJson([scriptblock]$Block) {
  $text = (Exec $Block) -join "`n"
  return , @($text | ConvertFrom-Json)
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

# Returns 'pr', 'draft' or 'blocked: <reason>'.
function Invoke-Task([string]$Branch, [string]$Prompt, [string]$Closes) {
  Write-Host "=== $Branch ==="
  Reset-Clone
  Exec { git -C $Clone checkout -B $Branch 2>&1 } | Out-Host
  Exec { pnpm --dir $Clone install --frozen-lockfile 2>&1 } | Out-Host
  if ($DryRun) { Write-Host "[dry-run] would run Claude on $Branch"; return 'dry-run' }

  $result = Invoke-Claude $Prompt
  if ($null -eq $result) { return 'blocked: la sesion de Claude fallo o excedio el tiempo (ver logs locales)' }
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
  Exec { gh @prArgs 2>&1 } | Out-Host
  if ($failed) { return 'draft' } else { return 'pr' }
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
    if ($done -ge $MaxIssues -or (Test-Paused)) { break }
    $branch = "agent/issue-$($issue.number)"
    if (Test-RemoteBranch $branch) { Write-Host "Skipping #$($issue.number): $branch exists."; continue }
    $template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prompt-issue.md'), $Utf8)
    $prompt = "$template`n#$($issue.number): $($issue.title)`n`n$($issue.body)`n"
    $outcome = Invoke-Task $branch $prompt ([string]$issue.number)
    Write-Host "Issue #$($issue.number): $outcome"
    if ($outcome -like 'blocked:*') {
      Exec { gh issue comment $issue.number --repo $Slug --body-file (Write-TempFile "El agente no pudo resolver este issue.`n`n$($outcome.Substring(8).Trim())`n`n---`n$PrFooter") 2>&1 } | Out-Host
      Exec { gh issue edit $issue.number --repo $Slug --remove-label $LabelTodo --add-label $LabelBlocked 2>&1 } | Out-Host
    }
    $done++
  }

  # 2. Roadmap: at most once a day, and never while a previous roadmap PR is unmerged.
  $today = Get-Date -Format 'yyyy-MM-dd'
  $last = if (Test-Path $RoadmapStamp) { (Get-Content $RoadmapStamp -Raw).Trim() } else { '' }
  $openRoadmap = @((Get-GhJson { gh pr list --repo $Slug --state open --limit 100 --json headRefName }) |
    ForEach-Object { $_ } | Where-Object { $_.headRefName -like 'agent/roadmap-*' })
  if ($SkipRoadmap) { Write-Host 'Roadmap skipped by flag.' }
  elseif (Test-Paused) { }
  elseif ($last -eq $today) { Write-Host 'Roadmap already attempted today.' }
  elseif ($openRoadmap.Count -gt 0) { Write-Host "Roadmap PR still open: $($openRoadmap[0].headRefName)." }
  else {
    if (-not $DryRun) { Set-Content -Path $RoadmapStamp -Value $today -Encoding ascii }
    $prompt = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prompt-roadmap.md'), $Utf8)
    $outcome = Invoke-Task "agent/roadmap-$RunId" $prompt ''
    Write-Host "Roadmap: $outcome"
  }
}
catch {
  Write-Host "Run aborted: $_"
  exit 1
}
finally {
  if (Test-Path (Join-Path $Clone '.git')) { try { Reset-Clone } catch { Write-Host "Could not reset the clone: $_" } }
  $mutex.ReleaseMutex()
  Stop-Transcript | Out-Null
}
