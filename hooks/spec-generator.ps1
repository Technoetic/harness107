# spec-generator.ps1 - Step별 SPEC-XXX.md 자동 생성 (Stop hook)
#
# MoAI-ADK Plan→Run→Sync 벤치마킹: 각 Step 시작 시 SPEC 자동 생성.
# 주의: 본 구현이 생성하는 SPEC은 MoAI 정식 EARS("When [trigger], [system] shall [response]"
#       키워드 패턴) 가 아니며, WHAT/WHY/WHEN/ACCEPTANCE/REFERENCE 헤더의 단순화 SPEC 템플릿이다.
# Step의 머리말(### Step-Back) + 첫 본문 H2를 추출해 step_archive/specs/SPEC-NNN.md 생성.
#
# 트리거 (2026-06-10 F4 수정): 매 Stop 이벤트에서 "완료된 step 전체 + current_step" 중
# SPEC 미생성분을 일괄 생성 (Stop당 최대 10개 — 15초 훅 타임아웃 보호).
# 구버전은 Stop당 차기 1개만 생성해, 한 턴에 여러 step이 완료되면 중간 step들의
# SPEC이 영구 누락되었다 (직전 완주 런 실측 46/107).

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
$logFile = Join-Path $PSScriptRoot "spec-generator.log"
function Write-SpecLog($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8 } catch {}
}

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } elseif ($harnessEvent.cwd) { [string]$harnessEvent.cwd } else { (Get-Location).Path }
$progressFile = Join-Path $projectRoot "step_archive\progress.json"
$specDir = Join-Path $projectRoot "step_archive\specs"

if (-not (Test-Path $progressFile)) { exit 0 }
if (-not (Test-Path $specDir)) { New-Item -ItemType Directory -Path $specDir -Force | Out-Null }

try {
    $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-SpecLog "progress.json read FAILED: $_"
    exit 0
}

$currentStep = [int]$progress.current_step
$totalSteps = [int]$progress.total_steps
if ($currentStep -lt 1 -or $currentStep -gt $totalSteps) { exit 0 }

# 대상: 완료된 step 전체 + current_step (중복 제거, 오름차순)
$targets = New-Object System.Collections.Generic.SortedSet[int]
foreach ($s in @($progress.completed_steps)) {
    $n = [int]$s
    if ($n -ge 1 -and $n -le $totalSteps) { [void]$targets.Add($n) }
}
[void]$targets.Add($currentStep)

$generated = 0
$MAX_PER_STOP = 10  # 15초 훅 타임아웃 보호

foreach ($t in $targets) {
    if ($generated -ge $MAX_PER_STOP) {
        Write-SpecLog "per-Stop cap ($MAX_PER_STOP) reached — remaining specs deferred to next Stop"
        break
    }
    $stepNum = "{0:D3}" -f $t
    $specFile = Join-Path $specDir "SPEC-$stepNum.md"
    if (Test-Path $specFile) { continue }  # 멱등: 기존 SPEC 보존

    $stepFile = Join-Path $projectRoot "step_archive\archived\step$stepNum.md"
    if (-not (Test-Path $stepFile)) {
        $stepFile = Join-Path $projectRoot "step_archive\step$stepNum.md"
        if (-not (Test-Path $stepFile)) {
            Write-SpecLog "step$stepNum.md not found"
            continue
        }
    }

    # Step 본문에서 핵심 추출
    $stepBody = Get-Content $stepFile -Raw -Encoding UTF8
    $titleMatch = [regex]::Match($stepBody, '(?m)^#\s+(.+)$')
    $title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { "Step $t" }

    # 첫 본문 H2 ~ 두 번째 H2 사이 = 핵심 설명
    $sectionMatch = [regex]::Match($stepBody, '(?ms)^##\s+(?:실행 내용|개요|목적|Step-Back|검증).+?(?=^##\s+|^---|\z)')
    $body = if ($sectionMatch.Success) {
        ($sectionMatch.Value -split "`n" | Select-Object -First 30) -join "`n"
    } else {
        "본문 추출 실패. step$stepNum.md 직접 참조."
    }

    # EARS 형식 SPEC 생성 (백틱은 here-string에서 escape 문자이므로 변수로 주입)
    $fence = [char]0x60 + [char]0x60 + [char]0x60  # ``` 3개
    $prevStepStr = "{0:D3}" -f ($t - 1)
    $spec = @"
# SPEC-$stepNum — $title

자동 생성: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
원본: step_archive/archived/step$stepNum.md

---

## WHAT (무엇을 만드는가)

$title

## WHY (왜 필요한가)

step$stepNum 의 본문 추출 — 다음 Step 진행에 필요한 결과물을 산출하기 위함.

## WHEN (전제 조건)

- 이전 Step ($prevStepStr) 완료
- progress.json 기준 step$stepNum 진행 차례

## ACCEPTANCE (수락 기준)

- 해당 Step의 자체 Self-Calibration 통과
- 결과 파일 step_archive/step${stepNum}_*.md 생성
- 평가 라운드 마일스톤(완료 49/69/104 통과) 시 TRUST 5 게이트 통과

## REFERENCE (원본 본문 발췌)

$fence
$body
$fence

## RUN-COMMAND

Read step_archive/archived/step$stepNum.md → 본문 실행
"@

    $spec | Out-File -FilePath $specFile -Encoding UTF8 -Force
    # BOM 제거
    $bytes = [System.IO.File]::ReadAllBytes($specFile)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        [System.IO.File]::WriteAllBytes($specFile, $bytes[3..($bytes.Length - 1)])
    }
    $generated++
    Write-SpecLog "SPEC-$stepNum generated"
}

if ($generated -eq 0) { Write-SpecLog "no missing SPECs (targets=$($targets.Count))" }
exit 0
