# step-auto-continue.ps1 — Stop hook
# 미완료 step이 남아 있으면 {"decision":"block", reason} JSON을 stdout에 출력하여
# Claude Code가 대화를 자동으로 계속하도록 강제한다. (공식 hooks 스펙)
#
# 무한 루프 방지: stop_hook_active=true && 직전 차단 이후 진행 0 → release.

param()
$ErrorActionPreference = "Continue"

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$progressFile = Join-Path $projectRoot "step_archive\progress.json"
$logFile = Join-Path $PSScriptRoot "step-auto-continue.log"
$stateFile = Join-Path $PSScriptRoot "step-auto-continue.state"

function Log($m) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try { Add-Content -Path $logFile -Value "[$ts] $m" -Encoding UTF8 } catch {}
}
Log "invoked"

# stdin
$raw = ""; $j = $null
try {
  $r = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $raw = $r.ReadToEnd(); $r.Close()
  if ($raw) { $j = $raw | ConvertFrom-Json }
} catch { Log "stdin parse failed: $_" }

if (-not (Test-Path $progressFile)) { Log "no progress.json -> exit 0"; exit 0 }
try {
  $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch { Log "progress parse failed"; exit 0 }

$total = [int]$progress.total_steps
$current = [int]$progress.current_step
$completedCount = @($progress.completed_steps).Count

if ($completedCount -ge $total -or $current -gt $total) {
  Log "ALL DONE ($completedCount/$total) -> release"
  exit 0
}

$prevState = ""
if (Test-Path $stateFile) { try { $prevState = (Get-Content $stateFile -Raw -Encoding UTF8).Trim() } catch {} }
$currState = "completed=$completedCount;current=$current"

if ($j -and $j.stop_hook_active -eq $true -and $prevState -eq $currState) {
  Log "no progress under stop_hook_active=true -> release"
  Set-Content -Path $stateFile -Value $currState -Encoding UTF8
  exit 0
}
Set-Content -Path $stateFile -Value $currState -Encoding UTF8

$lastMsg = ""
if ($j -and $j.last_assistant_message) { $lastMsg = [string]$j.last_assistant_message }

$questionPatterns = @(
  '\?\s*$','할까요','하시겠','선택해\s*주','알려\s*주','옵션\s*[0-9①-⑩]',
  '어느\s*방향','어떻게\s*할','진행할지','확인\s*부탁','어떤\s*것','원하시',
  '먼저\s*.+\s*할까','Would you like','Should I','Let me know','Please confirm',
  'Please choose','Do you want',
  '다음\s*턴에서','다음\s*턴에','자동\s*재개','자연스러운\s*종료','종료점',
  '이번\s*턴은\s*여기','이번\s*턴\s*마무리','이번\s*턴\s*(요약|정리|성과|누적)',
  '컨텍스트\s*(여유|압박|한계)','Stop\s*훅이','재개할\s*것','재개합니다',
  '한\s*턴\s*한도','한도\s*도달','한도에\s*근접',
  '(3\s*[-~]\s*5|3~5)\s*Step\s*(한도|제한|도달)',
  '종료합니다\s*$','종료합니다\.$','한\s*턴\s*규칙','턴\s*한계'
)
$hasQuestion = $false
foreach ($p in $questionPatterns) {
  if ($lastMsg -match $p) { $hasQuestion = $true; break }
}

$nextStepStr = "{0:D3}" -f $current
$totalStr = "{0:D3}" -f $total
$stepFile = "step_archive/archived/step$nextStepStr.md"

if ($hasQuestion) {
  $reason = @"
[HARNESS107 AUTO-RESUME - VIOLATION DETECTED]

Your last message contained a question, confirmation request, or self-termination phrase.
This breaks the mandatory auto-execution contract (Step 001~$totalStr must run without user confirmation).

RULE: Never ask the user to choose, confirm, approve, or redirect.
      If you hit a fatal error, log it in the step result file and move on.
      Only stop after Step $total completes.

Progress: $completedCount/$total completed.
Next step (MUST execute immediately, no questions): step$nextStepStr ($stepFile)

DO:
1. Read $stepFile.
2. Execute its instructions.
3. Report "Step $nextStepStr/$total 완료".
4. Move to step$('{0:D3}' -f ($current + 1)) without confirmation.

DO NOT:
- Ask "진행할까요?" / "계속할까요?" / anything similar.
- Offer options or alternatives to the user.
- Pause for approval.
- End turn with "다음 턴에서 자동 재개합니다" - just proceed inline.

Resume Step $nextStepStr NOW.
"@
} else {
  $reason = @"
[HARNESS107 AUTO-RESUME]
Progress: $completedCount/$total completed.
Next step to execute: step$nextStepStr ($stepFile)

MANDATORY:
1. Read $stepFile (Read tool, single file).
2. Execute its instructions immediately.
3. On completion, report "Step $nextStepStr/$total 완료" then auto-advance.
4. Continue without user confirmation through step$totalStr.

Never ask the user questions. Only stop after Step $total completes.
Do NOT end a turn with "다음 턴에서 자동 재개" - keep executing in the current turn until you run out of immediate work.
Begin step$nextStepStr NOW unless the user explicitly redirected.
"@
}

$jsonOut = @{ decision = "block"; reason = $reason } | ConvertTo-Json -Compress -Depth 3
Log "block step$nextStepStr (question=$hasQuestion)"
[Console]::Out.WriteLine($jsonOut)
exit 0
