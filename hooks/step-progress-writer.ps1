# step-progress-writer.ps1 - Step 완료 상태 자동 기록 (Stop 훅)
# 전략: 매 턴 끝에 transcript 전체를 스캔해 모든 "Step NNN 완료" 패턴을 추출.
# 멱등 동작: 이미 completed_steps에 있으면 스킵. 누락된 과거 완료도 자동 복구.
param()

$harnessRaw = ""
$harnessEvent = $null
try {
    $harnessReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
    $harnessRaw = $harnessReader.ReadToEnd()
    $harnessReader.Close()
    if ($harnessRaw) { $harnessEvent = $harnessRaw | ConvertFrom-Json -ErrorAction Stop }
} catch {}


$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "step-progress-writer.log"
function Write-WriterLog($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8 } catch {}
}
Write-WriterLog "=== invoked ==="
$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } elseif ($harnessEvent.cwd) { [string]$harnessEvent.cwd } else { (Get-Location).Path }
$stepArchive = Join-Path $projectRoot "step_archive"
$progressFile = Join-Path $stepArchive "progress.json"

# stdin 이벤트 JSON — UTF-8 명시 read (PS 5.1 default는 시스템 코드페이지로 한글 mojibake 위험)
$inputJson = $null
try {
    $stdinStream = [System.IO.StringReader]::new($harnessRaw)
    $raw = $harnessRaw
    $stdinStream.Close()
    if ($raw) { $inputJson = $raw | ConvertFrom-Json }
} catch {
    Write-WriterLog "stdin parse FAILED: $_"
}

if (-not (Test-Path $progressFile)) { exit 0 }

# B-P2-1/6/7 fix: Mutex 락으로 progress.json 동시 쓰기 방지
$mutex = New-Object System.Threading.Mutex($false, "Global\step-progress-writer-mutex")
$mutexAcquired = $false
try { $mutexAcquired = $mutex.WaitOne(5000) } catch { $mutexAcquired = $false }
if (-not $mutexAcquired) {
    Write-WriterLog "mutex acquire FAILED (timeout 5s) -> exit 0"
    exit 0
}

# B-P2-3 fix: 빈 파일/잘린 파일 재시도 (TOCTOU)
$progress = $null
for ($i = 0; $i -lt 3; $i++) {
    try {
        $rawProgress = Get-Content $progressFile -Raw -Encoding UTF8
        if ($rawProgress -and $rawProgress.Trim().Length -gt 0) {
            $progress = $rawProgress | ConvertFrom-Json
            if ($null -ne $progress) { break }
        }
    } catch {
        Write-WriterLog "progress.json read attempt $($i+1) FAILED: $_"
    }
    Start-Sleep -Milliseconds 50
}

# B-P2-6 fix: $null 가드 — null이면 절대 직렬화하지 않음
if ($null -eq $progress) {
    Write-WriterLog "progress.json read failed after 3 retries -> exit 0 (preserve existing file)"
    try { $mutex.ReleaseMutex() } catch {}
    exit 0
}

# 1) 누적 응답 수집 (last_assistant_message + 전체 transcript 스캔)
$response = ""
if ($inputJson -and $inputJson.last_assistant_message) {
    $response += "`n" + $inputJson.last_assistant_message
}

if ($inputJson -and $inputJson.transcript_path -and (Test-Path $inputJson.transcript_path)) {
    try {
        # transcript 전체를 스캔 (JSONL). 파일이 클 수 있으나 Step당 KB 단위라 수용 가능
        $allLines = Get-Content $inputJson.transcript_path -Encoding UTF8
        foreach ($line in $allLines) {
            if (-not $line) { continue }
            try {
                $entry = $line | ConvertFrom-Json
                if ($entry.type -eq 'assistant' -and $entry.message.content) {
                    foreach ($block in $entry.message.content) {
                        if ($block.type -eq 'text' -and $block.text) {
                            $response += "`n" + $block.text
                        }
                    }
                }
            } catch {}
        }
    } catch {}
}

# 2) Step 완료 패턴 매칭 - 엄격한 명시 완료 보고만 허용
#    total_steps 범위를 벗어난 숫자는 무시 (본문 언급 오탐 방지)
#    F4 fix (2026-06-10): 줄 단위 스캔 + 인용 가드 — 백틱/인용부호(>)/예시(예:) 줄은 제외하고
#    줄 머리에 anchoring하여, 모델이 문서 예시 문자열("✅ Step 023/107 완료" 등)을 본문에
#    인용했을 때의 위양성 완료 처리를 차단한다.
$totalSteps = [int]$progress.total_steps
$foundSteps = New-Object System.Collections.Generic.HashSet[int]

# 패턴 A: "Step NNN/MMM 완료" - 슬래시 + 총수 필수 (가장 엄격)
$patternA = '^\s*[✅→\-\*\s]*Step\s+(\d{1,3})\s*/\s*(\d{1,3})\s*완료'
# 패턴 B: "Step NNN 완료" (총수 없는 약식 보고)
$patternB = '^\s*[✅→\-\*\s]*Step\s+(\d{1,3})\s+완료'

$inFence = $false
foreach ($respLine in ($response -split "`n")) {
    if ($null -eq $respLine) { continue }
    # H3 수정: 코드펜스(```/~~~) 블록 추적 — 펜스 안의 "Step NNN/107 완료" 예시는
    # 완료 신호로 인정하지 않는다 (백틱이 같은 줄에 없어도 차단).
    if ($respLine -match '^\s*(```|~~~)') { $inFence = -not $inFence; continue }
    if ($inFence) { continue }
    if (-not $respLine) { continue }
    # 인용/예시 컨텍스트 가드: 코드 인용(백틱), 마크다운 인용(>), 예시 표기 줄은 스킵
    if ($respLine -match '`' -or $respLine -match '^\s*>' -or $respLine -match '예\s*[:)]' -or $respLine -match '예시') { continue }
    $mA = [regex]::Match($respLine, $patternA, 'IgnoreCase')
    if ($mA.Success) {
        $stepNum = [int]$mA.Groups[1].Value
        $declaredTotal = [int]$mA.Groups[2].Value
        if ($stepNum -ge 1 -and $stepNum -le $totalSteps -and $declaredTotal -eq $totalSteps) {
            [void]$foundSteps.Add($stepNum)
        }
        continue
    }
    $mB = [regex]::Match($respLine, $patternB, 'IgnoreCase')
    if ($mB.Success) {
        $stepNum = [int]$mB.Groups[1].Value
        if ($stepNum -ge 1 -and $stepNum -le $totalSteps) {
            [void]$foundSteps.Add($stepNum)
        }
    }
}

# 3) 실존 Step 파일 검증: stepNNN.md 파일이 실제 존재해야 완료로 인정
#    (대화 본문 오탐, 테스트 주입 문자열 차단)
#    경로 견고화: step_archive/stepNNN.md 또는 step_archive/archived/stepNNN.md 둘 중 하나면 인정
#    (하네스 재가동 시 step 파일이 archived/ 로 이동된 케이스 대응 — 다른 세션 재발 방지)
$archivedDirW = Join-Path $stepArchive "archived"
$validSteps = New-Object System.Collections.Generic.HashSet[int]
foreach ($s in $foundSteps) {
    $stepFileFlat = Join-Path $stepArchive ("step{0:D3}.md" -f $s)
    $stepFileArch = Join-Path $archivedDirW ("step{0:D3}.md" -f $s)
    if ((Test-Path $stepFileFlat) -or (Test-Path $stepFileArch)) {
        [void]$validSteps.Add($s)
    }
}

# 4) 기존 completed_steps와 병합
$existing = New-Object System.Collections.Generic.HashSet[int]
foreach ($s in @($progress.completed_steps)) { [void]$existing.Add([int]$s) }

$completedNew = @()
foreach ($s in $validSteps) {
    if (-not $existing.Contains($s)) { $completedNew += $s }
}

if ($completedNew.Count -gt 0) {
    $allCompleted = @($existing) + $completedNew | Sort-Object -Unique
    $progress.completed_steps = @($allCompleted)

    # F3 fix (2026-06-10): next-step 결정을 loader/obedience-guard와 동일한 first-gap
    # 규칙으로 통일 (구버전 max+1 방식은 완료 누락(gap) 발생 시 훅 3곳이 서로 다른
    # step을 지시하는 분기를 만들었음)
    $nextGap = $null
    for ($i = 1; $i -le [int]$progress.total_steps; $i++) {
        if ($allCompleted -notcontains $i) { $nextGap = $i; break }
    }
    if ($null -ne $nextGap) {
        $progress.current_step = $nextGap
    } else {
        $progress.current_step = [int]$progress.total_steps
    }

    Write-WriterLog "Newly completed: $($completedNew -join ', ')"
    Write-WriterLog "Total: $($progress.completed_steps.Count)/$($progress.total_steps) (next=first-gap=$($progress.current_step))"
}

# 4) 세션 이력 업데이트 (필드 없으면 생성)
if (-not $progress.PSObject.Properties.Name.Contains('session_history')) {
    $progress | Add-Member -NotePropertyName 'session_history' -NotePropertyValue @() -Force
}
$sessions = @($progress.session_history)
if ($sessions.Count -gt 0) {
    $lastSession = $sessions[-1]
    if ($lastSession) {
        $lastSession | Add-Member -NotePropertyName 'ended_at' -NotePropertyValue (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') -Force
        $lastSession | Add-Member -NotePropertyName 'steps_completed' -NotePropertyValue $completedNew.Count -Force
        $sessions[-1] = $lastSession
        $progress.session_history = $sessions
    }
}

# MoAI-ADK 벤치마킹: 보조 산출물 카운트 반영
try {
    $specDir = Join-Path $stepArchive "specs"
    $outDir  = Join-Path $stepArchive "outputs"
    if (Test-Path $specDir) {
        $specCount = (Get-ChildItem -Path $specDir -Filter "SPEC-*.md" -ErrorAction SilentlyContinue).Count
        if (-not $progress.PSObject.Properties.Name.Contains('moai_features')) {
            $progress | Add-Member -NotePropertyName 'moai_features' -NotePropertyValue ([PSCustomObject]@{ spec_generated_count=0; mx_tag_warnings=0; lsp_autofixes=0 }) -Force
        }
        $progress.moai_features.spec_generated_count = $specCount
    }
    # trust5_results 필드는 outputs/ 유무와 무관하게 보장
    if (-not $progress.PSObject.Properties.Name.Contains('trust5_results')) {
        $progress | Add-Member -NotePropertyName 'trust5_results' -NotePropertyValue ([PSCustomObject]@{ r1=$null; r2=$null; r3=$null }) -Force
    }
    if (Test-Path $outDir) {
        foreach ($r in @('r1','r2','r3')) {
            $rf = Join-Path $outDir "trust5_$r.md"
            if (Test-Path $rf) {
                $rc = Get-Content $rf -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                if ($rc -match '\*\*총점\*\*\s*\|\s*\*\*(\d+)/50\*\*') {
                    $progress.trust5_results.$r = [int]$Matches[1]
                }
            }
        }
    }
    # @MX 경고 / LSP 자동수정 카운트 (로그 행 수 기반 근사)
    $mxLog = Join-Path $PSScriptRoot "mx-tag-validator.log"
    if (Test-Path $mxLog) {
        $progress.moai_features.mx_tag_warnings = (Select-String -Path $mxLog -Pattern '@MX-WARN' -ErrorAction SilentlyContinue).Count
    }
    $lspLog = Join-Path $PSScriptRoot "lsp-autofix.log"
    if (Test-Path $lspLog) {
        $progress.moai_features.lsp_autofixes = (Select-String -Path $lspLog -Pattern 'OK:' -ErrorAction SilentlyContinue).Count
    }
} catch {
    Write-WriterLog "moai_features update FAILED: $_"
}

$progress.last_updated = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')

# B-P2-7 fix: 비원자적 truncate 대신 temp 파일 → rename
try {
    $jsonOutput = $progress | ConvertTo-Json -Depth 32 -Compress
    if ([string]::IsNullOrWhiteSpace($jsonOutput) -or $jsonOutput -eq 'null') {
        Write-WriterLog "ERROR: ConvertTo-Json produced null/empty — refusing to write"
    } else {
        $tempFile = "$progressFile.tmp.$PID"
        $jsonOutput | Out-File -FilePath $tempFile -Encoding UTF8 -Force
        # PS 5.1 Out-File은 BOM을 추가하므로 BOM 제거
        $bytes = [System.IO.File]::ReadAllBytes($tempFile)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            $bytes = $bytes[3..($bytes.Length - 1)]
            [System.IO.File]::WriteAllBytes($tempFile, $bytes)
        }
        # 원자적 rename (Windows: Move-Item -Force는 같은 볼륨에서 원자적)
        Move-Item -Path $tempFile -Destination $progressFile -Force
        Write-WriterLog "Progress saved atomically"
        # F1 fix (2026-06-10): 롤링 백업 — 완주 이력이 리셋/삭제로 소실되는 사고 대비
        try { Copy-Item -Path $progressFile -Destination "$progressFile.bak" -Force } catch {}
    }
} catch {
    Write-WriterLog "atomic write FAILED: $_"
}

try { $mutex.ReleaseMutex() } catch {}
$mutex.Dispose()
exit 0
