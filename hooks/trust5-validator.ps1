# trust5-validator.ps1 - Stop hook
# TRUST 5 게이트: r1(step49) / r2(step69) / r3(step104) 도달 시 평가
param()
$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "trust5-validator.log"
function Log($m) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try { Add-Content -Path $logFile -Value "[$ts] $m" -Encoding UTF8 } catch {}
}

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$progressFile = Join-Path $projectRoot "step_archive\progress.json"
if (-not (Test-Path $progressFile)) { exit 0 }
try { $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { exit 0 }

$done = @($progress.completed_steps).Count
$rounds = @{ 49='r1'; 69='r2'; 104='r3' }
if (-not $rounds.ContainsKey($done)) { exit 0 }
$round = $rounds[$done]

$outDir = Join-Path $projectRoot "step_archive\outputs"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$outFile = Join-Path $outDir "trust5_$round.md"
if (Test-Path $outFile) { exit 0 }

$srcDir = Join-Path $projectRoot "src"
$covDir = Join-Path $projectRoot "coverage"

$tested = if (Test-Path $covDir) { 8 } else { 3 }

$readable = 5
try {
  Push-Location $projectRoot
  $bo = (& cmd /c "npx biome check --max-diagnostics=0 src 2>&1") -join "`n"
  Pop-Location
  if ($bo -match 'no problems' -or $bo -match '0 errors') { $readable = 9 }
} catch {}

$unified = if (Test-Path $srcDir) { 8 } else { 4 }

$secured = 4
try {
  Push-Location $projectRoot
  $so = (& cmd /c "semgrep --config=auto --quiet --error src 2>&1") -join "`n"
  Pop-Location
  if ($LASTEXITCODE -eq 0 -and -not ($so -match 'finding')) { $secured = 9 }
  elseif ($so -match 'findings: 0') { $secured = 9 }
} catch {}

$trackable = 3
try {
  $mxFiles = 0; $allFiles = 0
  if (Test-Path $srcDir) {
    Get-ChildItem -Path $srcDir -Recurse -Include *.js,*.jsx,*.ts,*.tsx,*.html,*.css -ErrorAction SilentlyContinue | ForEach-Object {
      $allFiles++
      $c = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($c -match '@MX:(NOTE|WARN|ANCHOR|TODO)') { $mxFiles++ }
    }
  }
  if ($allFiles -eq 0) { $trackable = 5 } else { $trackable = [Math]::Round(($mxFiles/$allFiles)*10) }
} catch {}

$total = $tested + $readable + $unified + $secured + $trackable
$verdict = if ($total -ge 40) { 'PASS' } else { 'WARN' }

$rec = @()
if ($tested    -lt 7) { $rec += "- Tested: 단위 테스트 추가 + c8 커버리지 측정" }
if ($readable  -lt 7) { $rec += "- Readable: biome check 0 errors 달성" }
if ($unified   -lt 7) { $rec += "- Unified: src/ 구조화 + 디자인 토큰 단일화" }
if ($secured   -lt 7) { $rec += "- Secured: semgrep findings 0건 달성" }
if ($trackable -lt 7) { $rec += "- Trackable: 모든 신규 소스에 @MX 4종(NOTE/WARN/ANCHOR/TODO) 태그 부착" }

$report = @"
# TRUST 5 게이트 결과 - $round (step$done 도달)

생성: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

| 축 | 점수 | 측정 |
|:---|:---:|:---|
| Tested    | $tested/10    | coverage/ 디렉토리 |
| Readable  | $readable/10  | Biome check |
| Unified   | $unified/10   | src/ 구조 |
| Secured   | $secured/10   | semgrep --config=auto |
| Trackable | $trackable/10 | @MX 4종 커버리지 |
| **총점**  | **$total/50** | — |

## 판정: $verdict

## 보강 권고
$(($rec -join "`n"))
"@

$report | Out-File -FilePath $outFile -Encoding UTF8 -Force
$bytes = [System.IO.File]::ReadAllBytes($outFile)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  [System.IO.File]::WriteAllBytes($outFile, $bytes[3..($bytes.Length-1)])
}
Log "$round = $total/50 ($verdict)"
exit 0
