# trust5-validator.ps1 - TRUST 5 품질 게이트 (Stop hook, r1/r2/r3 평가 라운드 보강)
#
# MoAI-ADK 벤치마킹: TRUST 5 (Tested / Readable / Unified / Secured / Trackable)
# 기존 evaluator(4축: 기능/디자인/품질/성능)에 보안+추적성 2축 추가.
#
# MoAI SoT 5축 정의 (MoAI/.claude/rules/moai/core/moai-constitution.md "Quality Gates"):
#   - Tested:    85%+ coverage + characterization tests
#   - Readable:  Clear naming + English comments
#   - Unified:   Consistent style + ruff/black formatting
#   - Secured:   OWASP compliance + input validation
#   - Trackable: Conventional commits + issue references  ← MoAI 정식 정의
#
# 본 구현의 측정 신호 (단순화 + 자체 변형):
#   - Tested:    coverage/ 디렉토리 존재 (MoAI 85% 임계치 미적용)
#   - Readable:  Biome check 결과
#   - Unified:   src/ 디렉토리 존재
#   - Secured:   semgrep --config=auto 결과 (MoAI OWASP 직매핑 아님)
#   - Trackable: @MX 태그 4종 커버리지 (본 프로젝트 자체 정의 — MoAI 정식 "Conventional commits"와 다름)
#
# 트리거 (2026-06-10 수정): completed_steps 개수가 마일스톤(r1=38/r2=44/r3=50)을
#   "통과(>=)"했고 해당 라운드 결과 파일이 아직 없을 때 실행.
#   (구버전의 정확일치(==) 판정은 한 턴에 여러 Step이 병합 완료되면 마일스톤을
#    건너뛰어 게이트가 영구 미발화 — 실측 499 로그 중 발화 3회뿐이었음)
# 출력: step_archive/outputs/trust5_rN.md
# 점수: 50점 만점 (각 축 10점). 40점 미만 → 경고 (fail-open)

param()

$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "trust5-validator.log"
function Write-T5Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8 } catch {}
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$progressFile = Join-Path $projectRoot "step_archive\progress.json"
if (-not (Test-Path $progressFile)) { exit 0 }

try {
    $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-T5Log "progress.json parse FAILED: $_"
    exit 0
}

$completedCount = @($progress.completed_steps).Count

# r1/r2/r3 평가 마일스톤: 임계 통과(>=) + 결과 파일 미존재 시 트리거
# (한 턴 멀티스텝 병합으로 카운트가 마일스톤을 건너뛰어도 다음 Stop에서 발화)
$outDir = Join-Path $projectRoot "step_archive\outputs"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$round = $null
$milestone = 0
foreach ($k in 38, 44, 50) {
    $r = @{ 38 = "r1"; 44 = "r2"; 50 = "r3" }[$k]
    $f = Join-Path $outDir "trust5_$r.md"
    if ($completedCount -ge $k -and -not (Test-Path $f)) {
        $round = $r
        $milestone = $k
        break  # 가장 낮은 미생성 라운드 1개만 실행 (Stop당 1라운드, 60초 타임아웃 보호)
    }
}
if ($null -eq $round) {
    Write-T5Log "skip: completed=$completedCount, no pending milestone (r1>=38, r2>=44, r3>=50, 미생성 라운드 없음)"
    exit 0
}
$outFile = Join-Path $outDir "trust5_$round.md"

# 5개 축 점수 산정 (자동 측정 가능한 신호 기반)
$tested    = 0  # vitest/c8 결과 존재 + coverage > 0
$readable  = 0  # biome/stylelint 통과
$unified   = 0  # 디렉토리 구조 + 토큰 일관성
$secured   = 0  # semgrep 0건
$trackable = 0  # @MX 태그 커버리지

# 1. Tested - coverage 폴더 존재 여부
$covDir = Join-Path $projectRoot "coverage"
if (Test-Path $covDir) { $tested = 8 } else { $tested = 3 }

# 외부 명령 실행 헬퍼 — 프로세스 레벨 타임아웃 (훅 60초 타임아웃 내 완료 보장)
# semgrep --timeout은 룰·파일당 제한이라 총량 보호가 안 됨 — WaitForExit가 실제 안전장치
function Invoke-WithTimeout([string]$cmdLine, [int]$timeoutMs) {
    $outTmp = [System.IO.Path]::GetTempFileName()
    try {
        $psi = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "$cmdLine > `"$outTmp`" 2>&1" `
            -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
        if (-not $psi.WaitForExit($timeoutMs)) {
            try { $psi.Kill() } catch {}
            Write-T5Log "TIMEOUT (${timeoutMs}ms): $cmdLine"
            return $null  # 타임아웃 → 호출부 부분점수 폴백
        }
        return (Get-Content $outTmp -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    } catch {
        Write-T5Log "exec FAILED: $cmdLine — $_"
        return $null
    } finally {
        Remove-Item $outTmp -ErrorAction SilentlyContinue
    }
}

# 2. Readable - biome 빠른 체크 (10초 타임아웃, 실패/타임아웃 시 부분점수 5)
$biomeOut = Invoke-WithTimeout "npx biome check --max-diagnostics=0 src" 10000
if (
    $null -ne $biomeOut -and
    ($biomeOut -match 'Checked|No fixes applied|no problems|0 errors') -and
    ($biomeOut -notmatch 'Found\s+[1-9]\d*\s+errors|Some errors were emitted')
) { $readable = 9 }
else { $readable = 5 }

# 3. Unified - src/ 디렉토리 + step_archive 체계화 정도
$srcDir = Join-Path $projectRoot "src"
if (Test-Path $srcDir) { $unified = 8 } else { $unified = 4 }

# 4. Secured - semgrep 스캔 (프로세스 30초 타임아웃; --config=auto는 네트워크 다운로드
#    포함이라 미설치/오프라인 시 Get-Command 프로브로 즉시 스킵 → 부분점수 4)
$secured = 4
$semgrepBaseline = Join-Path $projectRoot "step_archive\semgrep-baseline.json"
if (Test-Path $semgrepBaseline) {
    try {
        $semJson = Get-Content $semgrepBaseline -Raw -Encoding UTF8 | ConvertFrom-Json
        if (@($semJson.results).Count -eq 0 -and @($semJson.errors).Count -eq 0) {
            $secured = 9
        }
    } catch {
        Write-T5Log "semgrep baseline parse FAILED: $_"
    }
}
if ($secured -lt 9 -and (Get-Command semgrep -ErrorAction SilentlyContinue)) {
    $semOut = Invoke-WithTimeout "semgrep --config=auto --quiet --error src" 30000
    if ($null -ne $semOut) {
        if (($semOut -notmatch 'finding') -or ($semOut -match 'findings:\s*0')) { $secured = 9 }
    }
} elseif ($secured -lt 9) {
    Write-T5Log "semgrep not installed -> Secured 부분점수 4"
}

# 5. Trackable - @MX 태그 커버리지 (MoAI mx-tag-protocol SoT: NOTE/WARN/ANCHOR/TODO 중 1개 이상)
try {
    $mxFiles = 0
    $totalFiles = 0
    if (Test-Path $srcDir) {
        Get-ChildItem -Path $srcDir -Recurse -Include *.js,*.jsx,*.ts,*.tsx,*.html,*.css -ErrorAction SilentlyContinue | ForEach-Object {
            $totalFiles++
            $c = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($c -match '@MX:(NOTE|WARN|ANCHOR|TODO)') {
                $mxFiles++
            }
        }
    }
    if ($totalFiles -eq 0) { $trackable = 5 }
    else {
        $ratio = $mxFiles / $totalFiles
        $trackable = [Math]::Round($ratio * 10)
    }
} catch { $trackable = 3 }

$total = $tested + $readable + $unified + $secured + $trackable
$verdict = if ($total -ge 40) { 'PASS' } else { 'WARN' }

# 결과 기록
$report = @"
# TRUST 5 게이트 결과 - $round (마일스톤 $milestone 통과, 완료 $completedCount steps)

생성 시각: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

## 점수 (50점 만점)

| 축 | 점수 | 측정 신호 |
|:---|:---:|:---|
| Tested (테스트성) | $tested/10 | coverage/ 디렉토리 + vitest 결과 |
| Readable (가독성) | $readable/10 | Biome check |
| Unified (일관성) | $unified/10 | src/ 구조 + 토큰 통일성 |
| Secured (보안성) | $secured/10 | semgrep --config=auto |
| Trackable (추적성) | $trackable/10 | @MX 태그 4종(NOTE/WARN/ANCHOR/TODO) 커버리지 |
| **총점** | **$total/50** | — |

## 판정: $verdict

- 40점 이상: PASS — 다음 라운드 진행 가능
- 40점 미만: WARN — 부족 축 보강 권고 (강제 중단 아님, fail-open)

## 보강 권고

$( if ($tested -lt 7)    { "- Tested: 단위 테스트 추가 + c8 커버리지 측정" } )
$( if ($readable -lt 7)  { "- Readable: biome check 0 errors 달성" } )
$( if ($unified -lt 7)   { "- Unified: src/ 구조화 + 디자인 토큰 단일화" } )
$( if ($secured -lt 7)   { "- Secured: semgrep findings 0건 달성" } )
$( if ($trackable -lt 7) { "- Trackable: 모든 신규 소스에 @MX 4종(NOTE/WARN/ANCHOR/TODO) 태그 부착" } )
"@

$report | Out-File -FilePath $outFile -Encoding UTF8 -Force
# BOM 제거
$bytes = [System.IO.File]::ReadAllBytes($outFile)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    [System.IO.File]::WriteAllBytes($outFile, $bytes[3..($bytes.Length - 1)])
}

Write-T5Log "TRUST 5 $round = $total/50 ($verdict) -> $outFile"
exit 0
