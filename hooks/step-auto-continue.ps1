# step-auto-continue.ps1 - Step 미완료 시 Stop을 차단하고 자동 재개 (Stop 훅)
#
# 전략 (공식 스펙 기준, docs.claude.com/en/docs/claude-code/hooks):
#   - JSON decision="block" + exit 0: Claude가 대화를 계속한다 (정식 메커니즘)
#   - 폴백으로 exit 2 + stderr도 함께 작동 (이중 보장)
#   - stop_hook_active=true 시 즉시 exit 0 (무한 루프 방지 - 공식 권장)
#   - 모든 실행을 로그로 기록해 진단 가능하게 함

param()

$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "step-auto-continue.log"
# 진짜 Stop 이벤트 추적용 별도 파일 (로그 잠금 문제와 무관하게 기록)
try {
    $beaconFile = Join-Path $PSScriptRoot "step-auto-continue.beacon"
    "$(Get-Date -Format 'HH:mm:ss') invoked pid=$PID" | Out-File -FilePath $beaconFile -Append -Encoding UTF8
} catch {}

function Write-HookLog($msg) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$timestamp] $msg" -Encoding UTF8
}

Write-HookLog "=== invoked ==="

# stdin JSON 파싱
$inputJson = $null
$rawInput = ""
try {
    # UTF-8 명시 read (PS 5.1 default 코드페이지로 한글 mojibake 방지)
    $stdinStream = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
    $rawInput = $stdinStream.ReadToEnd()
    $stdinStream.Close()
    if ($rawInput) {
        $inputJson = $rawInput | ConvertFrom-Json
        Write-HookLog "stdin parsed: stop_hook_active=$($inputJson.stop_hook_active) has_last_msg=$([bool]$inputJson.last_assistant_message)"
    } else {
        Write-HookLog "stdin EMPTY"
    }
} catch {
    Write-HookLog "stdin parse FAILED: $_"
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$progressFile = Join-Path $projectRoot "step_archive\progress.json"

if (-not (Test-Path $progressFile)) {
    Write-HookLog "progress.json missing -> exit 0"
    exit 0
}

try {
    $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-HookLog "progress.json parse FAILED: $_ -> exit 0"
    exit 0
}

# NOTE: writer-merge 블록 제거됨 (B-P2-1 fix).
# step-progress-writer.ps1이 progress.json의 단일 writer다.
# 이 hook은 read-only로만 progress를 사용한다.

$total = [int]$progress.total_steps
$current = [int]$progress.current_step
$completedCount = @($progress.completed_steps).Count

# M08 fix (2026-06-10): Stop 훅 5개는 병렬 기동되므로 이 시점의 progress.json은
# step-progress-writer가 갱신하기 전의 stale 상태일 수 있다 (직전 완료 step 재실행 지시 버그).
# 보정: transcript의 assistant 텍스트에서 "Step NNN/MMM 완료" 최대값을 직접 파싱해
# current를 max(파일값, 최대완료+1)로 끌어올린다. (read-only — progress.json은 쓰지 않음.
# tool_result에 인용된 예시 문자열 오탐을 막기 위해 assistant 텍스트 블록만 스캔)
if ($inputJson -and $inputJson.transcript_path -and (Test-Path $inputJson.transcript_path)) {
    try {
        $maxDone = 0
        foreach ($line in [System.IO.File]::ReadLines($inputJson.transcript_path)) {
            if (-not $line -or $line.IndexOf('"assistant"') -lt 0) { continue }
            try {
                $entry = $line | ConvertFrom-Json
                if ($entry.type -ne 'assistant' -or -not $entry.message.content) { continue }
                foreach ($block in $entry.message.content) {
                    if ($block.type -ne 'text' -or -not $block.text) { continue }
                    # 2026-06-10 회귀 수정: writer와 동일한 줄 단위 인용 가드 + 줄머리 anchoring.
                    # (가드 없는 자유 매칭은 본문에 인용된 예시 문자열을 완료 보고로 오인 —
                    #  실제로 감사 보고 요약의 인용구가 23/107 오판을 유발했음)
                    foreach ($tLine in ($block.text -split "`n")) {
                        if (-not $tLine) { continue }
                        if ($tLine -match '`' -or $tLine -match '^\s*>' -or $tLine -match '예\s*[:)]') { continue }
                        $m = [regex]::Match($tLine, '^\s*[✅→\-\*\s]*Step\s+(\d{1,3})\s*/\s*(\d{1,3})\s*완료', 'IgnoreCase')
                        if ($m.Success) {
                            $n = [int]$m.Groups[1].Value
                            if ([int]$m.Groups[2].Value -eq $total -and $n -ge 1 -and $n -le $total -and $n -gt $maxDone) { $maxDone = $n }
                        }
                    }
                }
            } catch {}
        }
        if ($maxDone -gt 0) {
            if ($maxDone -ge $completedCount) { $completedCount = $maxDone }
            if (($maxDone + 1) -gt $current) { $current = [Math]::Min($maxDone + 1, $total + 1) }
            Write-HookLog "transcript correction: maxDone=$maxDone -> current=$current completed=$completedCount"
        }
    } catch {
        Write-HookLog "transcript scan FAILED (non-fatal): $_"
    }
}

# 모든 Step 완료 -> 정상 종료 허용 (진짜 종료 조건)
if ($completedCount -ge $total -or $current -gt $total) {
    Write-HookLog "all $total steps completed ($completedCount/$total, current=$current) -> exit 0 (DONE)"
    exit 0
}

# stop_hook_active=true는 "직전 Stop 훅이 block해서 새 턴이 시작된 뒤 그 턴이 끝났다"는 뜻.
# 이 경우에도 Step이 미완료이면 계속 block해야 한다 (Claude Code 공식 동작).
# 진짜 무한 루프 방지는: progress.json이 진행되지 않으면 추가로 블록 안 함.
# F8 fix (2026-06-10): stall 상태 파일을 세션별로 분리 — 동시 다중 세션에서 카운터
# 교차 오염 방지. session_id 없으면 레거시 단일 파일 사용. 7일 지난 세션 파일은 청소.
$sessionId = ""
if ($inputJson -and $inputJson.session_id) { $sessionId = ([string]$inputJson.session_id) -replace '[^a-zA-Z0-9-]', '' }
$stateFile = if ($sessionId) { Join-Path $PSScriptRoot "step-auto-continue.$sessionId.state" }
             else            { Join-Path $PSScriptRoot "step-auto-continue.state" }
try {
    Get-ChildItem -Path $PSScriptRoot -Filter "step-auto-continue.*.state" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
        Remove-Item -ErrorAction SilentlyContinue
} catch {}
$prevState = ""
$prevStall = 0
if (Test-Path $stateFile) {
    try {
        $raw = (Get-Content $stateFile -Raw -Encoding UTF8).Trim()
        # 형식: "completed=N;current=M|stall=K" (하위호환: |stall= 없으면 0)
        if ($raw -match '^(.*?)\|stall=(\d+)$') {
            $prevState = $Matches[1]
            $prevStall = [int]$Matches[2]
        } else {
            $prevState = $raw
        }
    } catch {}
}
$currState = "completed=$completedCount;current=$current"

# B-FIX(2026-06-05): 1회 stall로 즉시 release하면, 도구 호출 XML이 한 번만 깨져도
# (검증 스킬 본문 직렬화 깨짐 등) 멈춤이 확정된다. 연속 STALL_LIMIT회 진전 없을
# 때만 포기하도록 완화. 그 전까지는 계속 block하여 자동 재시도 기회를 준다.
# @MX:NOTE: STALL_LIMIT=3 — XML 깨짐은 일회성 생성 오류이므로 2~3회 재시도면 회복.
$STALL_LIMIT = 3
if ($inputJson -and $inputJson.stop_hook_active -eq $true -and $prevState -eq $currState) {
    $newStall = $prevStall + 1
    if ($newStall -ge $STALL_LIMIT) {
        # 연속 STALL_LIMIT회 진전 없음 -> 진짜 막힘, 포기 (무한 루프 방지)
        Write-HookLog "stop_hook_active=true AND no progress x$newStall (limit=$STALL_LIMIT) -> exit 0 (release)"
        Set-Content -Path $stateFile -Value "$currState|stall=0" -Encoding UTF8
        exit 0
    }
    # 아직 한도 미만 -> stall 카운터만 올리고 계속 block (아래로 진행)
    Write-HookLog "stop_hook_active=true, no progress x$newStall (<$STALL_LIMIT) -> RETRY block"
    Set-Content -Path $stateFile -Value "$currState|stall=$newStall" -Encoding UTF8
} else {
    # 진전이 있었거나 첫 stop -> stall 리셋
    Set-Content -Path $stateFile -Value "$currState|stall=0" -Encoding UTF8
}

# 마지막 assistant 메시지에서 "질문/확인 대기 패턴" 감지
$lastMsg = ""
if ($inputJson -and $inputJson.last_assistant_message) {
    $lastMsg = [string]$inputJson.last_assistant_message
}

$questionPatterns = @(
    '\?\s*$',
    '할까요',
    '하시겠',
    '선택해\s*주',
    '알려\s*주',
    '옵션\s*[0-9①-⑩]',
    '어느\s*방향',
    '어떻게\s*할',
    '진행할지',
    '확인\s*부탁',
    '어떤\s*것',
    '원하시',
    '먼저\s*.+\s*할까',
    'Would you like',
    'Should I',
    'Let me know',
    'Please confirm',
    'Please choose',
    'Do you want',
    # 턴 종료 예고/마감 인사 패턴 (이것이 자연 종료를 유발함 — 진짜 원인)
    '다음\s*턴에서',
    '다음\s*턴에',
    '자동\s*재개',
    '자연스러운\s*종료',
    '종료점',
    '이번\s*턴은\s*여기',
    '이번\s*턴\s*마무리',
    '이번\s*턴\s*(요약|정리|성과|누적)',
    '컨텍스트\s*(여유|압박|한계)',
    'Stop\s*훅이',
    '재개할\s*것',
    '재개합니다',
    # 자기 제한 문구 — 의미 없는 인위적 중단 유발
    '한\s*턴\s*한도',
    '한도\s*도달',
    '한도에\s*근접',
    '(3\s*[-~]\s*5|3~5)\s*Step\s*(한도|제한|도달)',
    '종료합니다\s*$',
    '종료합니다\.$',
    '한\s*턴\s*규칙',
    '턴\s*한계'
)

$hasQuestion = $false
foreach ($p in $questionPatterns) {
    if ($lastMsg -match $p) {
        $hasQuestion = $true
        Write-HookLog "QUESTION PATTERN matched: $p"
        break
    }
}

$nextStep = $current
$nextStepStr = "{0:D3}" -f $nextStep
# step 파일 실제 경로 해석: archived/ 우선, 없으면 flat (재가동 시 archived/ 이동 대응)
$stepFile = "step_archive/step$nextStepStr.md"
$archivedCandidate = Join-Path $projectRoot "step_archive\archived\step$nextStepStr.md"
$flatCandidate = Join-Path $projectRoot "step_archive\step$nextStepStr.md"
if (Test-Path $archivedCandidate) {
    $stepFile = "step_archive/archived/step$nextStepStr.md"
} elseif (Test-Path $flatCandidate) {
    $stepFile = "step_archive/step$nextStepStr.md"
}

# 출력은 1~2줄로 최소화한다 (긴 reason 주입이 컨텍스트를 키워 tool-call 직렬화 오류를 유발).
# B-FIX(2026-06-05): 멈춤의 근본 원인은 검증 스킬(evaluator/verify/check)의 긴 본문을
# 도구 호출 파라미터 안에 직렬화하다 XML이 깨지는 것. reason에 회피 지침 1줄 추가.
$guard = "DO NOT paste verification/CoVE text into tool-call parameters — write findings to a .md file, keep tool args minimal."
if ($hasQuestion) {
    $reason = "[HARNESS] $completedCount/$total done. No user-facing questions. Resume now: read+execute $stepFile, report 'Step $nextStepStr/$total 완료', continue. $guard (User direct requests still take priority.)"
} else {
    $reason = "[HARNESS] $completedCount/$total done. Next: read+execute $stepFile, report 'Step $nextStepStr/$total 완료', then auto-advance. Only stop after step $total. $guard (User direct requests still take priority.)"
}

# B-P2-2 fix: 공식 스펙은 단일 채널만 허용.
# stdout JSON + exit 0 (decision=block) 방식으로 통일한다.
# 이중 출력은 Claude Code가 exit 0을 "no block"으로 해석할 위험을 만든다.
$jsonOut = @{
    decision = "block"
    reason   = $reason
} | ConvertTo-Json -Compress -Depth 3

Write-HookLog "emitting decision=block for step$nextStepStr (question=$hasQuestion)"

[Console]::Out.WriteLine($jsonOut)
exit 0
