# step-obedience-guard.ps1 - 매 user prompt마다 미완료 step 리마인더 주입
# UserPromptSubmit hook으로 사용.
# 미완료 step이 있으면 다음 step 경로를 컨텍스트에 주입해 하네스 복귀를 유도한다.
# 단, 사용자의 명시적 직접 요청은 우선한다 (2026-06-10 A5-07 방향 확정:
# CLAUDE.md ABSOLUTE OVERRIDE에 동일한 예외 조항을 명문화 — 실사용 패턴 근거).

param()

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$stepArchive = Join-Path $projectRoot "step_archive"
$archivedDir = Join-Path $stepArchive "archived"
$progressFile = Join-Path $stepArchive "progress.json"

if (-not (Test-Path $progressFile)) { exit 0 }

try {
    $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    exit 0
}

$totalSteps = [int]$progress.total_steps
$completed = @($progress.completed_steps)
$completedCount = $completed.Count

# 모든 step 완료 → 신규 요청 자유 처리
if ($completedCount -ge $totalSteps) { exit 0 }

# 다음 실행해야 할 step 번호 결정
$nextStep = $null
for ($i = 1; $i -le $totalSteps; $i++) {
    if ($completed -notcontains $i) { $nextStep = $i; break }
}
if ($null -eq $nextStep) { exit 0 }

$nextStepFmt = "step$('{0:D3}' -f $nextStep)"
# F9 fix (2026-06-10): archived/ 우선, flat 폴백 이중 해석 (auto-continue와 동일 규약)
$nextStepRel = $null
if (Test-Path (Join-Path $archivedDir "$nextStepFmt.md")) {
    $nextStepRel = "step_archive/archived/$nextStepFmt.md"
} elseif (Test-Path (Join-Path $stepArchive "$nextStepFmt.md")) {
    $nextStepRel = "step_archive/$nextStepFmt.md"
}

# 어느 쪽에도 파일이 존재하지 않으면 silent skip
if (-not $nextStepRel) { exit 0 }

# Claude Code는 stdout을 system-reminder로 모델 컨텍스트에 주입한다.
# stderr 사용 시 hook error로 차단되므로 stdout만 사용.
Write-Output "[HARNESS] $completedCount/$totalSteps done. Next: $nextStepRel (read+execute, no user confirmation). User direct requests still take priority."

exit 0
