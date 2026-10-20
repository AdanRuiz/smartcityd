<#
.SYNOPSIS
  Unattended development agent. Fixes open GitHub issues labeled `agent`, then
  implements the next item of the product backlog (issues labeled `backlog`,
  weekly sprint = milestone), opening one PR per task.

.DESCRIPTION
  Runs Claude Code headless (`claude -p`) on the user's subscription, inside an
  isolated clone under %LOCALAPPDATA%\smartcity-agent. The model only edits and
  commits; this script (read from the user's checkout, never from the clone)
  checks protected paths, runs build/lint/typecheck/test, pushes the branch and
  opens the PR. Nothing is ever merged or deployed. See docs/operacion/agente.md.

  With -Engine gemini it is a second, parallel agent: Gemini CLI signed in with
  the user's Google account (never an API key), its own clone and state under
  %LOCALAPPDATA%\smartcity-agent-gemini, only backlog issues labeled `gemini`
  and no bugs. Claude skips those issues, so the two never take the same item.

  ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#>
param(
  [ValidateSet('claude', 'gemini')]
  [string]$Engine = 'claude',
  [int]$MaxIssues = 3,
  [int]$TaskTimeoutMinutes = 45,
  # Pinned so a CLI update cannot silently change the model behind the PRs.
  # Empty means the engine default: claude-opus-5-5 or gemini-2.5-pro.
  [string]$Model = '',
  [Alias('SkipRoadmap')]
  [switch]$SkipBacklog,
  # Agent items proposed for a new weekly milestone; the maintainer adjusts them on Monday.
  [int]$SprintSize = 8,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8

$SourceRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$IsGemini = $Engine -eq 'gemini'
if (-not $Model) { $Model = if ($IsGemini) { 'gemini-2.5-pro' } else { 'claude-opus-5-5' } }
$StateDir = Join-Path $env:LOCALAPPDATA $(if ($IsGemini) { 'smartcity-agent-gemini' } else { 'smartcity-agent' })
# Gemini CLI reads its settings and Google sign-in from here instead of the user's ~/.gemini.
$GeminiHome = Join-Path $StateDir 'home'
$Clone = Join-Path $StateDir 'repo'
$BinDir = Join-Path $StateDir 'bin'
$LogDir = Join-Path $StateDir 'logs'
$RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
. (Join-Path $PSScriptRoot 'common.ps1')

# Last commit that touched the prompts, so metrics.ps1 can compare prompt versions.
$PromptFiles = @('scripts/agent/prompt-issue.md', 'scripts/agent/prompt-backlog.md')
$PromptVersion = [string](Exec { git -C $SourceRepo log -1 --format=%h -- @PromptFiles } -AllowFail)
if (-not $PromptVersion) { $PromptVersion = 'sin-version' }
if (Exec { git -C $SourceRepo status --porcelain -- @PromptFiles } -AllowFail) { $PromptVersion += '+local' }
$CliVersion = 'desconocida'
try {
  $CliVersion = if ($IsGemini) { ([string](Exec { gemini.cmd --version } -AllowFail)).Trim() }
    else { ([string](Exec { claude.cmd --version } -AllowFail) -split ' ')[0] }
} catch { }

$LabelTodo = 'agent'
$LabelBlocked = 'agent:bloqueado'
# Any open issue with this label pauses the agent, so it can be stopped from GitHub (even a phone).
$LabelPause = 'agent:pausa'
# A pinned open issue with this label gets one comment per run that did something.
$LabelLog = 'agent:bitacora'
# Product backlog (docs/backlog/producto.md): one issue per item; `humano` items are never taken.
$LabelBacklog = 'backlog'
$LabelHuman = 'humano'
# Backlog items for the Gemini agent; the Claude agent takes every other one.
$LabelGemini = 'gemini'
$BranchPrefix = if ($IsGemini) { 'agent/gemini-' } else { 'agent/backlog-' }
$BacklogDoc = 'docs\backlog\producto.md'
$Runs = New-Object System.Collections.ArrayList
$RunError = $null
$StopRun = $false
$Slug = $null
$LastStats = $null
$LastPrUrl = ''
# Paths the agent must never change; a PR touching them is not opened.
$ProtectedPaths = '^(\.github/|scripts/agent/|LICENSE$|pnpm-lock\.yaml$|.*\.env|.*\.dev\.vars$)'
$PrFooter = "Generado sin supervision por ``scripts/agent/run.ps1`` ($RunId, prompts ``$PromptVersion``, modelo ``$Model``, $Engine ``$CliVersion``). Revisar antes de mezclar.`n`n" +
  [char]::ConvertFromUtf32(0x1F916) + $(if ($IsGemini) { ' Generado con [Gemini CLI](https://github.com/google-gemini/gemini-cli)' } else { ' Generated with [Claude Code](https://claude.com/claude-code)' })

# Same allow and deny lists as $ClaudeSettings, as a Gemini CLI policy. It is loaded with
# --admin-policy, the top tier, so neither the user's nor the workspace's policies can widen it.
# Headless mode denies whatever is not allowed here (`ask_user` counts as deny).
$GeminiPolicy = @'
[[rule]]
toolName = ["read_file", "read_many_files", "list_directory", "glob", "grep_search", "write_file", "replace", "write_todos"]
decision = "allow"
priority = 100

[[rule]]
toolName = "run_shell_command"
commandPrefix = ["pnpm", "node", "git status", "git diff", "git log", "git show", "git add", "git commit", "git rm", "git mv", "git restore", "ls", "cat", "head", "tail", "wc", "grep", "find", "sort", "diff", "mkdir"]
decision = "allow"
priority = 100

[[rule]]
toolName = "run_shell_command"
commandPrefix = ["git push", "git remote", "git config", "gh", "pnpm add", "pnpm remove", "pnpm up", "pnpm update", "pnpm dlx", "pnpm publish", "npx", "curl", "wget", "powershell", "pwsh"]
decision = "deny"
priority = 900
denyMessage = "Prohibido para el agente sin supervision (scripts/agent/run.ps1)."

[[rule]]
toolName = "run_shell_command"
commandRegex = "^(pnpm|node)\\b.*(deploy|wrangler|--remote)"
decision = "deny"
priority = 900
denyMessage = "Desplegar esta prohibido para el agente."

[[rule]]
toolName = ["web_fetch", "google_web_search", "activate_skill"]
decision = "deny"
priority = 900
'@

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
      # Deploy rules cover only pnpm and node, the allowed commands that can launch
      # wrangler (a bare `wrangler` is not allowed, so it is already denied). A
      # `*wrangler*` rule matched the whole command line, so it also blocked
      # `git add wrangler.toml` and commit messages (issue #4).
      'Bash(pnpm *deploy*)', 'Bash(pnpm *wrangler*)', 'Bash(pnpm *--remote*)',
      'Bash(node *deploy*)', 'Bash(node *wrangler*)', 'Bash(node *--remote*)',
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
$TransientText = 'usage limit|rate limit|limit reached|overloaded|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket hang up|RESOURCE_EXHAUSTED|quota|UNAVAILABLE'

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

# Same contract as Invoke-Claude, for Gemini CLI signed in with Google (oauth-personal).
function Invoke-Gemini([string]$Prompt, [string]$Tag) {
  $promptFile = Join-Path $StateDir "prompt-$RunId.md"
  $policyFile = Join-Path $StateDir 'gemini-policy.toml'
  $outFile = Join-Path $LogDir "$RunId-$Tag-gemini.json"
  $errFile = Join-Path $LogDir "$RunId-$Tag-gemini.err"
  [IO.File]::WriteAllText($promptFile, $Prompt, $Utf8)
  [IO.File]::WriteAllText($policyFile, $GeminiPolicy, $Utf8)

  $exe = Get-Command gemini.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  # The prompt arrives on stdin; -p only switches to headless mode and is appended to it.
  $argLine = "-p `"Sigue las instrucciones de arriba.`" --model $Model --output-format json --approval-mode auto_edit --skip-trust --admin-policy `"$policyFile`""
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $exe.Source -ArgumentList $argLine -WorkingDirectory $Clone `
    -RedirectStandardInput $promptFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
    -NoNewWindow -PassThru
  $null = $p.Handle
  if (-not $p.WaitForExit($TaskTimeoutMinutes * 60000)) {
    Write-Host "Gemini exceeded $TaskTimeoutMinutes min; killing it."
    Exec { taskkill /PID $p.Id /T /F 2>&1 } -AllowFail | Out-Host
    return @{ status = 'error'; text = "la sesion excedio $TaskTimeoutMinutes min; conviene partir la tarea" }
  }
  $raw = [IO.File]::ReadAllText($outFile, $Utf8)
  $stderr = if (Test-Path $errFile) { [IO.File]::ReadAllText($errFile, $Utf8).Trim() } else { '' }
  # Warnings may precede the JSON object on stdout.
  $start = $raw.IndexOf('{')
  try { $json = if ($start -ge 0) { $raw.Substring($start) | ConvertFrom-Json } else { $null } } catch { $json = $null }
  if ($null -eq $json) {
    $why = (($stderr -split "`r?`n") | Where-Object { $_ } | Select-Object -First 1)
    Write-Host "Unreadable Gemini output. stdout: $raw stderr: $stderr"
    $kind = if ("$raw $stderr" -match $TransientText) { 'transient' } else { 'error' }
    return @{ status = $kind; text = "la CLI de Gemini no respondio: $why" }
  }
  $stats = Get-Prop $json 'stats'
  $models = Get-Prop $stats 'models'
  $requests = 0
  if ($models) { foreach ($m in $models.PSObject.Properties) { $requests += [int](Get-Prop (Get-Prop $m.Value 'api') 'totalRequests') } }
  $script:LastStats = @{
    turns = $requests
    minutes = [math]::Round($clock.Elapsed.TotalMinutes, 1)
    denials = [int](Get-Prop (Get-Prop (Get-Prop $stats 'tools') 'totalDecisions') 'reject')
    usd = $null
    model = if ($models) { @($models.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ' } else { '' }
  }
  $err = Get-Prop $json 'error'
  if ($err -or $p.ExitCode -ne 0) {
    $msg = if ($err) { "$(Get-Prop $err 'type') $(Get-Prop $err 'message')".Trim() } else { "codigo de salida $($p.ExitCode)" }
    Write-Host "Gemini reported an error: $msg"
    $transient = "$msg $stderr" -match $TransientText
    return @{ status = $(if ($transient) { 'transient' } else { 'error' }); text = "error de Gemini: $msg" }
  }
  return @{ status = 'ok'; text = [string](Get-Prop $json 'response') }
}

function Invoke-Agent([string]$Prompt, [string]$Tag) {
  if ($IsGemini) { return Invoke-Gemini $Prompt $Tag } else { return Invoke-Claude $Prompt $Tag }
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

  $session = Invoke-Agent $Prompt ($Branch -replace '^agent/', '')
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
  # Too big for one session: the agent proposes smaller items instead (backlog only; commits are ignored).
  if ($first -like 'PARTIR:*') { return "split: $($first.Substring(7).Trim())`n`n$rest" }
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
    'split:*' { 'Partido en items nuevos: ' + (($Outcome.Substring(6).Trim() -split "`r?`n")[0]) }
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
  $lines = @("### Corrida $RunId - prompts ``$PromptVersion`` - modelo ``$used`` - $Engine ``$CliVersion``", '')
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

# --- Product backlog (docs/backlog/producto.md) ---------------------------------

# "Fase actual" and "Adelanto permitido" from the backlog doc on origin/main; $null if absent.
function Get-PhaseConfig {
  $f = Join-Path $Clone $BacklogDoc
  if (-not (Test-Path $f)) { return $null }
  $t = [IO.File]::ReadAllText($f, $Utf8)
  if ($t -notmatch '\*\*Fase actual:\*\*\s*(\d+)') { return $null }
  $current = [int]$Matches[1]
  $ahead = if ($t -match '\*\*Adelanto permitido:\*\*\s*Fase\s*(\d+)') { [int]$Matches[1] } else { $null }
  return [pscustomobject]@{ current = $current; ahead = $ahead }
}

function Get-BacklogIssues {
  return @((Get-GhJson { gh issue list --repo $Slug --label $LabelBacklog --state open --limit 300 --json number,title,body,labels,milestone }) | ForEach-Object { $_ })
}

function Get-LabelNames($Issue) { return @($Issue.labels | ForEach-Object { $_.name }) }

function Get-MilestoneTitle($Issue) {
  $m = Get-Prop $Issue 'milestone'
  if ($m) { return [string](Get-Prop $m 'title') } else { return '' }
}

# Order of producto.md: the week's milestone by issue number; then the current phase, then the
# phase ahead, by priority and number. Never `humano`, blocked items or a phase further away.
# Only the items of one engine (-For), see $LabelGemini.
function Get-BacklogQueue($Issues, $Phase, [string]$Sprint, [string]$For = $Engine) {
  $prio = @{ must = 0; should = 1; could = 2 }
  $rows = foreach ($i in $Issues) {
    $names = Get-LabelNames $i
    if ($names -contains $LabelHuman -or $names -contains $LabelBlocked) { continue }
    # Each engine has its own items: `gemini` ones for Gemini, all the others for Claude.
    if (($For -eq 'gemini') -ne ($names -contains $LabelGemini)) { continue }
    $inSprint = (Get-MilestoneTitle $i) -eq $Sprint
    $rank = if ($names -contains "fase-$($Phase.current)") { 0 } elseif ($Phase.ahead -and $names -contains "fase-$($Phase.ahead)") { 1 } else { -1 }
    if (-not $inSprint -and $rank -lt 0) { continue }
    $p = 3
    foreach ($k in $prio.Keys) { if ($names -contains $k) { $p = $prio[$k] } }
    $key = if ($inSprint) { '0-0-0-{0:D6}' -f [int]$i.number } else { '1-{0}-{1}-{2:D6}' -f $rank, $p, [int]$i.number }
    [pscustomobject]@{ key = $key; issue = $i }
  }
  return @($rows | Sort-Object key | ForEach-Object { $_.issue })
}

# Creates the week's milestone if missing and proposes the first agent items for it.
# Planning stays human: the maintainer moves issues in or out and writes the goal.
function Initialize-Sprint($Week, $Phase) {
  $recent = @((Get-GhJson { gh api "repos/$Slug/milestones?state=all&sort=due_on&direction=desc&per_page=100" }) | ForEach-Object { $_ })
  if (@($recent | Where-Object { $_.title -eq $Week.name }).Count -gt 0) { return }
  if ($DryRun) { Write-Host "[dry-run] would create milestone $($Week.name) and propose $SprintSize items"; return }
  $due = $Week.sunday.AddHours(23).AddMinutes(59).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $desc = "Sprint del $($Week.monday.ToString('yyyy-MM-dd')) al $($Week.sunday.ToString('yyyy-MM-dd')). " +
    (U "Objetivo: lo escribe el mantenedor en la planeaci\u00f3n del lunes. ``run.ps1`` propuso los siguientes \u00edtems de cada agente; aj\u00fastalos.")
  # Both agents may try at the same time; only the one that creates it proposes items.
  Exec { gh api "repos/$Slug/milestones" -f "title=$($Week.name)" -f "due_on=$due" -f "description=$desc" 2>&1 } -AllowFail | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "Milestone $($Week.name) not created (probably the other agent did)."; return }
  $all = Get-BacklogIssues
  $proposal = @(Get-BacklogQueue $all $Phase $Week.name 'claude' | Select-Object -First $SprintSize) +
    @(Get-BacklogQueue $all $Phase $Week.name 'gemini' | Select-Object -First ([math]::Ceiling($SprintSize / 2)))
  foreach ($i in $proposal) { Exec { gh issue edit $i.number --repo $Slug --milestone $Week.name 2>&1 } | Out-Host }
  Write-Host "Created milestone $($Week.name) with $($proposal.Count) proposed items."
}

# Highest PB-n in issue titles (any state) and in the backlog doc, plus one.
function Get-NextPbNumber {
  $max = 0
  $titles = @((Get-GhJson { gh issue list --repo $Slug --label $LabelBacklog --state all --limit 1000 --json title }) | ForEach-Object { $_.title })
  $doc = Join-Path $Clone $BacklogDoc
  $text = ($titles -join "`n") + "`n" + $(if (Test-Path $doc) { [IO.File]::ReadAllText($doc, $Utf8) } else { '' })
  foreach ($m in [regex]::Matches($text, 'PB-(\d+)')) { $max = [math]::Max($max, [int]$m.Groups[1].Value) }
  return $max + 1
}

# PARTIR: the agent's "- <title> | <acceptance>" lines become new backlog issues, in order,
# with the same labels and milestone; the original is closed pointing to them.
# Returns $false when the answer does not have 2 to 6 parts (then it counts as blocked).
function Split-BacklogIssue($Issue, [string]$Outcome) {
  $lines = $Outcome.Substring(6).Trim() -split "`r?`n"
  $parts = @($lines | Where-Object { $_ -match '^\s*[-*]\s+\S' } | ForEach-Object { ($_ -replace '^\s*[-*]\s+', '').Trim() })
  if ($parts.Count -lt 2 -or $parts.Count -gt 6) { return $false }
  $dot = U '\u00b7'
  $origPb = if ($Issue.title -match '^(PB-\d+)') { $Matches[1] } else { "#$($Issue.number)" }
  $reqs = if ([string]$Issue.body -match '(?m)^- \*\*Requisitos:\*\*.*$') { $Matches[0] } else { '' }
  $labels = @(Get-LabelNames $Issue | Where-Object { $_ -ne $LabelBlocked })
  $milestone = Get-MilestoneTitle $Issue
  $n = Get-NextPbNumber
  $created = @()
  foreach ($part in $parts) {
    $title, $accept = $part -split '\s+\|\s+', 2
    $body = @(("**PB-$n** del [product backlog](https://github.com/$Slug/blob/main/docs/backlog/producto.md). " +
      (U "Parte de $origPb (#$($Issue.number)), propuesta por el agente al partirlo.")), '')
    if ($reqs) { $body += $reqs, '' }
    if ($accept) { $body += (U "**Aceptaci\u00f3n y notas:** ") + $accept }
    $ghArgs = @('issue', 'create', '--repo', $Slug, '--title', "PB-$n $dot $($title.Trim())", '--body-file', (Write-TempFile ($body -join "`n")))
    foreach ($l in $labels) { $ghArgs += '--label', $l }
    if ($milestone) { $ghArgs += '--milestone', $milestone }
    $url = [string](Exec { gh @ghArgs 2>&1 } | Where-Object { "$_" -match '^https://' } | Select-Object -Last 1)
    $created += "- PB-$n $dot $($title.Trim()): $($url.Trim())"
    $n++
  }
  $note = (U "El agente lo parti\u00f3 porque no cabe en una sesi\u00f3n: ") + ($lines[0]) + "`n`n" + ($created -join "`n") + "`n`n---`n$PrFooter"
  Exec { gh issue comment $Issue.number --repo $Slug --body-file (Write-TempFile $note) 2>&1 } | Out-Host
  Exec { gh issue close $Issue.number --repo $Slug --reason 'not planned' 2>&1 } | Out-Host
  return $true
}

New-Item -ItemType Directory -Force $LogDir, $BinDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir "$RunId.log") | Out-Null
$mutex = New-Object System.Threading.Mutex($false, $(if ($IsGemini) { 'Local\smartcity-agent-gemini' } else { 'Local\smartcity-agent' }))
if (-not $mutex.WaitOne(0)) { Write-Host 'Another run is in progress.'; Stop-Transcript | Out-Null; exit 0 }

try {
  Get-ChildItem $LogDir | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force

  foreach ($cmd in 'git', 'gh', 'corepack') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not in PATH. See docs/operacion/agente.md." }
  }
  if ($IsGemini) {
    if (-not (Get-Command gemini.cmd -ErrorAction SilentlyContinue)) { throw 'gemini is not in PATH.' }
    # Google sign-in only: an API key would be billed. The one-time sign-in is in docs/operacion/agente.md.
    if (-not (Test-Path (Join-Path $GeminiHome '.gemini\oauth_creds.json'))) {
      throw "Gemini no tiene sesion de Google en $GeminiHome. Ver docs/operacion/agente.md, 'Agente Gemini'."
    }
  }
  elseif (-not (Get-Command claude.exe, claude.cmd -ErrorAction SilentlyContinue)) { throw 'claude is not in PATH.' }

  # Subscription auth only: an API key in the environment would bill the API instead.
  Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
  if ($IsGemini) {
    Remove-Item Env:GEMINI_API_KEY, Env:GOOGLE_API_KEY, Env:GOOGLE_GENAI_USE_VERTEXAI, Env:GOOGLE_GENAI_USE_GCA, Env:GOOGLE_CLOUD_ACCESS_TOKEN -ErrorAction SilentlyContinue
    $env:GEMINI_CLI_HOME = $GeminiHome
    $env:GEMINI_DEFAULT_AUTH_TYPE = 'oauth-personal'
  }
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
  # Bugs stay with the Claude agent; the Gemini agent only takes its backlog items.
  if ($IsGemini) { $issues = @() }
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

  # 2. Backlog: one item per run, never while a previous backlog PR is unmerged, so merging it
  # unlocks the next one. A blocked item gets `agent:bloqueado` and the next run takes the next
  # item; a transient failure leaves it untouched for a retry. Older agent/roadmap-* PRs also gate.
  $openBacklog = @((Get-GhJson { gh pr list --repo $Slug --state open --limit 100 --json headRefName }) |
    ForEach-Object { $_ } | Where-Object { $_.headRefName -like "$BranchPrefix*" -or (-not $IsGemini -and $_.headRefName -like 'agent/roadmap-*') })
  if ($SkipBacklog) { Write-Host 'Backlog skipped by flag.' }
  elseif ($StopRun) { Write-Host 'Backlog skipped: a transient error stopped this run.' }
  elseif (Test-Paused) { }
  elseif ($openBacklog.Count -gt 0) { Write-Host "Backlog PR still open: $($openBacklog[0].headRefName)." }
  else {
    Reset-Clone
    $phase = Get-PhaseConfig
    if (-not $phase) { Write-Host "No 'Fase actual' in $BacklogDoc on main; backlog skipped." }
    else {
      $week = Get-SprintWeek
      Initialize-Sprint $week $phase
      # One ls-remote for all branches: a branch means a PR was opened (to retry, delete it).
      $taken = @(Exec { git ls-remote --heads $RemoteUrl "$BranchPrefix*" } | ForEach-Object { ($_ -split 'refs/heads/')[-1] })
      $queue = @(Get-BacklogQueue (Get-BacklogIssues) $phase $week.name | Where-Object { $taken -notcontains "$BranchPrefix$($_.number)" })
      Write-Host "Backlog: phase $($phase.current) (ahead: $($phase.ahead)), sprint $($week.name), $($queue.Count) items for the agent."
      if ($queue.Count -eq 0) { Write-Host 'Nothing for the agent in the sprint, the current phase or the phase ahead.' }
      else {
        $item = $queue[0]
        # The sprint shows what was actually worked on, even when the agent pulled it from the phase.
        if (-not $DryRun -and (Get-MilestoneTitle $item) -ne $week.name) {
          Exec { gh issue edit $item.number --repo $Slug --milestone $week.name 2>&1 } | Out-Host
        }
        $template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prompt-backlog.md'), $Utf8)
        # The commit trailer names the model that actually wrote the code.
        if ($IsGemini) { $template = $template.Replace('Co-Authored-By: Claude <noreply@anthropic.com>', 'Assisted-by: Gemini CLI') }
        $prompt = "$template`n#$($item.number): $($item.title)`n`n$($item.body)`n"
        $outcome = Invoke-Task "$BranchPrefix$($item.number)" $prompt ([string]$item.number)
        Write-Host "Backlog #$($item.number): $outcome"
        Add-RunRow "#$($item.number) $($item.title)" $outcome
        if ($outcome -like 'split:*' -and -not (Split-BacklogIssue $item $outcome)) {
          $outcome = 'blocked: el agente pidio partir el item pero no dio entre 2 y 6 partes.' + "`n`n" + $outcome.Substring(6).Trim()
        }
        if ($outcome -like 'blocked:*') {
          Exec { gh issue comment $item.number --repo $Slug --body-file (Write-TempFile ("El agente no pudo resolver este item.`n`n$($outcome.Substring(8).Trim())`n`n" +
            "Para que lo vuelva a intentar, responde lo que pide y quita la etiqueta ``$LabelBlocked``.`n`n---`n$PrFooter")) 2>&1 } | Out-Host
          Exec { gh issue edit $item.number --repo $Slug --add-label $LabelBlocked 2>&1 } | Out-Host
        }
      }
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
