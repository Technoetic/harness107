# step-progress-loader.ps1 - Step 진행 상태 로드 (SessionStart)
# 새 세션 시작 시 이전 진행 상태를 로드하여 컨텍스트에 주입
param()

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$stepArchive = Join-Path $projectRoot "step_archive"
$progressFile = Join-Path $stepArchive "progress.json"

# F7 fix (2026-06-10): progress.json 쓰기를 writer와 동일 규약으로 통일 —
# 동일 mutex + temp 파일 + BOM 제거 + 원자적 rename (구버전은 BOM 포함·비원자·무락이라
# 병렬 훅과의 torn-write 가능성이 있었음)
function Write-ProgressAtomic($obj) {
    $mutex = New-Object System.Threading.Mutex($false, "Global\step-progress-writer-mutex")
    $acquired = $false
    try { $acquired = $mutex.WaitOne(5000) } catch {}
    try {
        $json = $obj | ConvertTo-Json -Depth 32
        if ([string]::IsNullOrWhiteSpace($json) -or $json -eq 'null') { return }
        $tempFile = "$progressFile.tmp.$PID"
        $json | Out-File -FilePath $tempFile -Encoding UTF8 -Force
        $bytes = [System.IO.File]::ReadAllBytes($tempFile)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            [System.IO.File]::WriteAllBytes($tempFile, $bytes[3..($bytes.Length - 1)])
        }
        Move-Item -Path $tempFile -Destination $progressFile -Force
    } catch {
        Write-Host "WARNING: progress.json write failed: $_"
    } finally {
        if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
}

Write-Host "=== Step Progress Loader ==="

if (-not (Test-Path $progressFile)) {
    Write-Host "No progress file found. Starting fresh."
    Write-Host "Next step: step001"

    # F1 guard (2026-06-10): 직전 런의 stall 상태 파일이 남아 있으면 SoT 불일치 경고 후 리셋
    $staleStates = @(Get-ChildItem -Path $PSScriptRoot -Filter "step-auto-continue*.state" -ErrorAction SilentlyContinue)
    if ($staleStates.Count -gt 0) {
        Write-Host "WARNING: progress.json absent but stale auto-continue state found (previous run remnant). Resetting state files."
        $staleStates | Remove-Item -ErrorAction SilentlyContinue
    }

    # total_steps 동적 계산 (F5 fix: flat + archived/ 이중 스캔, 파일명 unique 기준 —
    # 구버전 flat 전용 스캔은 archived/ 배치에서 0을 반환해 fallback 107 우연 일치에 의존했음)
    $stepFiles = @(Get-ChildItem -Path $stepArchive -Filter "step???.md" -ErrorAction SilentlyContinue)
    $archivedInit = Join-Path $stepArchive "archived"
    if (Test-Path $archivedInit) {
        $stepFiles += @(Get-ChildItem -Path $archivedInit -Filter "step???.md" -ErrorAction SilentlyContinue)
    }
    $detected = @($stepFiles | ForEach-Object { $_.Name } | Sort-Object -Unique).Count
    $totalStepsDetected = if ($detected -gt 0) { $detected } else { 50 }
    Write-Host "Detected total_steps from filesystem: $totalStepsDetected"

    # 초기 progress.json 생성 (MoAI-ADK 벤치마킹 필드 포함)
    $initial = @{
        last_updated = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
        current_step = 1
        total_steps = $totalStepsDetected
        completed_steps = @()
        failed_steps = @()
        skipped_steps = @()
        session_history = @()
        eval_rounds = @{
            r1 = @{ step = 49;  result = $null; score = $null }
            r2 = @{ step = 69;  result = $null; score = $null }
            r3 = @{ step = 104; result = $null; score = $null }
        }
        trust5_results = @{
            r1 = $null
            r2 = $null
            r3 = $null
        }
        moai_features = @{
            spec_generated_count = 0
            mx_tag_warnings = 0
            lsp_autofixes = 0
        }
        metrics = @{
            total_sessions = 0
            total_duration_minutes = 0
            steps_per_session_avg = 0
        }
    }

    Write-ProgressAtomic $initial
    exit 0
}

# 기존 progress.json이 있어도 total_steps가 실제 파일 수와 다르면 경고
$existingProgress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
# stepNNN.md 개수: flat + archived/ 둘 다 스캔 후 파일명 기준 unique (재가동 시 archived/ 이동 대응)
$stepFiles = @(Get-ChildItem -Path $stepArchive -Filter "step???.md" -ErrorAction SilentlyContinue)
$archivedDir2 = Join-Path $stepArchive "archived"
if (Test-Path $archivedDir2) {
    $stepFiles += @(Get-ChildItem -Path $archivedDir2 -Filter "step???.md" -ErrorAction SilentlyContinue)
}
$actualTotal = @($stepFiles | ForEach-Object { $_.Name } | Sort-Object -Unique).Count
$needsRewrite = $false
if ($actualTotal -gt 0 -and $actualTotal -ne [int]$existingProgress.total_steps) {
    Write-Host "WARNING: total_steps mismatch (progress.json=$($existingProgress.total_steps), filesystem=$actualTotal). Auto-correcting."
    $existingProgress.total_steps = $actualTotal
    $needsRewrite = $true
}

# MoAI-ADK 벤치마킹: 누락 필드 자동 추가 (마이그레이션)
if (-not $existingProgress.PSObject.Properties.Name.Contains('trust5_results')) {
    $existingProgress | Add-Member -NotePropertyName 'trust5_results' -NotePropertyValue ([PSCustomObject]@{ r1=$null; r2=$null; r3=$null }) -Force
    $needsRewrite = $true
}
if (-not $existingProgress.PSObject.Properties.Name.Contains('moai_features')) {
    $existingProgress | Add-Member -NotePropertyName 'moai_features' -NotePropertyValue ([PSCustomObject]@{ spec_generated_count=0; mx_tag_warnings=0; lsp_autofixes=0 }) -Force
    $needsRewrite = $true
}
if ($needsRewrite) {
    Write-ProgressAtomic $existingProgress
}

# F7 fix: 인코딩 미지정 재읽기(자기 torn-read 윈도우) 제거 — 이미 파싱된 객체 재사용
$progress = $existingProgress

$completedCount = $progress.completed_steps.Count
$failedCount = $progress.failed_steps.Count
$totalSteps = $progress.total_steps

# F3 fix (2026-06-10): 표시 step도 아래 복종 블록과 동일한 first-gap 규칙으로 계산 —
# 한 SessionStart가 서로 다른 두 step 번호를 출력하던 불일치 제거
$completedArr0 = @($progress.completed_steps)
$currentStep = [int]$progress.total_steps
for ($i = 1; $i -le [int]$progress.total_steps; $i++) {
    if ($completedArr0 -notcontains $i) { $currentStep = $i; break }
}

Write-Host "Progress: $completedCount/$totalSteps completed"
Write-Host "Current step: step$('{0:D3}' -f $currentStep)"
Write-Host "Failed steps: $failedCount"

if ($failedCount -gt 0) {
    Write-Host "Failed step list: $($progress.failed_steps -join ', ')"
}

# 세션 카운터 증가
$progress.metrics.total_sessions = $progress.metrics.total_sessions + 1
$sessionEntry = @{
    session_id = $progress.metrics.total_sessions
    started_at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
    starting_step = $currentStep
}

$sessionList = @($progress.session_history) + @($sessionEntry)
$progress.session_history = $sessionList
$progress.last_updated = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')

Write-ProgressAtomic $progress

Write-Host "Session #$($progress.metrics.total_sessions) started"
Write-Host "=== Ready to resume from step$('{0:D3}' -f $currentStep) ==="

# ── 복종 지시 ──────────────────────────────────────────────────────────────
# 다음 실행해야 할 step 파일 경로를 명확히 못박아 모델에 주입.
# step001.md 끝의 "즉시 다음 step 읽고 실행" 지시를 다른 세션에서도 강제한다.
$archivedDir = Join-Path $stepArchive "archived"
$nextStep = $null
$completedArr = @($progress.completed_steps)
for ($i = 1; $i -le [int]$progress.total_steps; $i++) {
    if ($completedArr -notcontains $i) { $nextStep = $i; break }
}
if ($null -ne $nextStep) {
    $nextStepFmt = "step$('{0:D3}' -f $nextStep)"
    # F9 fix (2026-06-10): archived/ 우선, flat 폴백 이중 해석 (auto-continue와 동일 규약)
    $nextStepRel = $null
    if (Test-Path (Join-Path $archivedDir "$nextStepFmt.md")) {
        $nextStepRel = "step_archive/archived/$nextStepFmt.md"
    } elseif (Test-Path (Join-Path $stepArchive "$nextStepFmt.md")) {
        $nextStepRel = "step_archive/$nextStepFmt.md"
    }
    if ($nextStepRel) {
        Write-Host ""
        Write-Host "=== HARNESS OBEDIENCE ==="
        Write-Host "Your first action this session is to Read $nextStepRel, unless the user sent an explicit direct request (user direct requests take priority — CLAUDE.md ABSOLUTE OVERRIDE exception)."
        Write-Host "Do not greet the user. Do not ask what to do."
        Write-Host "Read $nextStepFmt.md, execute it, then move to the next step."
        Write-Host "Each step file ends with 'Read step(N+1).md immediately upon completion'; obey that chain."
    }
}
exit 0
