# spec-generator.ps1 - Stop hook
# 현재 step의 SPEC-NNN.md 자동 생성 (없으면 only)
param()
$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "spec-generator.log"
function Log($m) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try { Add-Content -Path $logFile -Value "[$ts] $m" -Encoding UTF8 } catch {}
}

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$progressFile = Join-Path $projectRoot "step_archive\progress.json"
$specDir = Join-Path $projectRoot "step_archive\specs"
$archivedDir = Join-Path $projectRoot "step_archive\archived"

if (-not (Test-Path $progressFile)) { exit 0 }
if (-not (Test-Path $specDir)) { New-Item -ItemType Directory -Path $specDir -Force | Out-Null }

try { $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { exit 0 }
$cur = [int]$progress.current_step
$total = [int]$progress.total_steps
if ($cur -lt 1 -or $cur -gt $total) { exit 0 }

$num = "{0:D3}" -f $cur
$specFile = Join-Path $specDir "SPEC-$num.md"
if (Test-Path $specFile) { exit 0 }

$stepFile = Join-Path $archivedDir "step$num.md"
if (-not (Test-Path $stepFile)) { exit 0 }

$body = Get-Content $stepFile -Raw -Encoding UTF8
$title = "Step $cur"
$tm = [regex]::Match($body, '(?m)^#\s+(.+)$')
if ($tm.Success) { $title = $tm.Groups[1].Value.Trim() }

$sm = [regex]::Match($body, '(?ms)^##\s+(?:실행 내용|개요|목적|Step-Back|검증).+?(?=^##\s+|^---|\z)')
$ref = if ($sm.Success) {
  (($sm.Value -split "`n") | Select-Object -First 30) -join "`n"
} else { "본문 추출 실패. step$num.md 직접 참조." }

$fence = "``````"
$prev = "{0:D3}" -f ($cur - 1)
$spec = @"
# SPEC-$num — $title

자동 생성: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
원본: step_archive/archived/step$num.md

---

## WHAT
$title

## WHY
다음 Step 진행에 필요한 결과물 산출.

## WHEN
- 이전 Step ($prev) 완료
- progress.json.current_step == $cur

## ACCEPTANCE
- Self-Calibration 통과
- 결과 파일 step_archive/step${num}_*.md 생성
- 평가 라운드(49/69/104) 도달 시 TRUST 5 게이트 통과

## REFERENCE
$fence
$ref
$fence

## RUN-COMMAND
Read step_archive/archived/step$num.md → 본문 실행
"@

$spec | Out-File -FilePath $specFile -Encoding UTF8 -Force
$bytes = [System.IO.File]::ReadAllBytes($specFile)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  [System.IO.File]::WriteAllBytes($specFile, $bytes[3..($bytes.Length-1)])
}
Log "SPEC-$num generated"
exit 0
