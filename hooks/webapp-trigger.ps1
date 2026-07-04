# webapp-trigger.ps1 — UserPromptSubmit hook
# 사용자 prompt가 "웹앱 튜토리얼 생성" 트리거 패턴이면:
#   1) step_archive/ 부트스트랩 (없으면 생성, step001~107 복사)
#   2) TOPIC/TOPIC.md 작성 (사용자 prompt 원문 보존)
#   3) progress.json 초기화 (current_step=1)
#   4) stdout으로 system-reminder 주입 → step001 즉시 진입 강제

param()
$ErrorActionPreference = "Continue"

$pluginRoot  = Split-Path $PSScriptRoot -Parent
$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$stepArchive = Join-Path $projectRoot "step_archive"
$archivedDir = Join-Path $stepArchive "archived"
$topicDir    = Join-Path $stepArchive "TOPIC"
$progressFile= Join-Path $stepArchive "progress.json"
$topicFile   = Join-Path $topicDir "TOPIC.md"
$assetSteps  = Join-Path $pluginRoot "assets\steps"
$logFile     = Join-Path $PSScriptRoot "webapp-trigger.log"

function Write-Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try { Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8 } catch {}
}

# stdin JSON 수신
$raw = ""
try {
  $r = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $raw = $r.ReadToEnd(); $r.Close()
} catch { Write-Log "stdin read failed: $_"; exit 0 }

if (-not $raw) { exit 0 }
try { $j = $raw | ConvertFrom-Json } catch { exit 0 }

$prompt = [string]$j.prompt
if (-not $prompt) { exit 0 }

# 트리거 패턴 — /webapp 명시 트리거 + 자연어(대시보드/웹앱/튜토리얼 생성 요청).
# (H1 수정: README가 광고하는 "...대시보드를 만들어줘" 자연어 진입을 실제로 지원)
$triggers = @(
  '튜토리얼.*(생성|만들어|제작)',
  '인터랙티브.*필수.*초보자',
  '@step_archive/archived/step001\.md',
  '^/webapp\s+',
  'webapp\s+생성',
  '웹앱.*튜토리얼',
  '인터렉티브.*필수',
  '대시보드.*(만들어|만들|생성|제작|구현)',
  '(웹앱|웹\s*앱|웹\s*페이지|web\s*app).*(만들어|만들|생성|제작|구현)'
)
$matched = $false
foreach ($p in $triggers) {
  if ($prompt -match $p) { $matched = $true; break }
}
if (-not $matched) { exit 0 }

Write-Log "TRIGGER matched. prompt head: $($prompt.Substring(0,[Math]::Min(80,$prompt.Length)))"

# 1) step_archive 부트스트랩
if (-not (Test-Path $stepArchive)) { New-Item -ItemType Directory -Path $stepArchive -Force | Out-Null }
if (-not (Test-Path $archivedDir)) { New-Item -ItemType Directory -Path $archivedDir -Force | Out-Null }
if (-not (Test-Path $topicDir))    { New-Item -ItemType Directory -Path $topicDir -Force | Out-Null }

# step001~107 복사 (없는 것만)
if (Test-Path $assetSteps) {
  Get-ChildItem $assetSteps -Filter "step*.md" | ForEach-Object {
    $dst = Join-Path $archivedDir $_.Name
    if (-not (Test-Path $dst)) { Copy-Item $_.FullName $dst -Force }
  }
}

# H4 수정: html-bundler를 프로젝트로 복사해 step081/038에서 실행 가능하게 한다.
# (플러그인 hooks/는 ${CLAUDE_PLUGIN_ROOT} 밖이라 step 본문의 상대경로로 도달 불가)
$toolsDir = Join-Path $stepArchive "tools"
if (-not (Test-Path $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null }
foreach ($b in @("html-bundler.ps1", "html-bundler.sh")) {
  $bSrc = Join-Path $PSScriptRoot $b
  if (Test-Path $bSrc) { Copy-Item $bSrc (Join-Path $toolsDir $b) -Force }
}

# 2) TOPIC.md 작성 (덮어쓰기 — 신규 요청은 신규 주제)
$today = Get-Date -Format "yyyy-MM-dd"
$topicBody = @"
---
created: $today
session_prompt: |
$(($prompt -split "`n" | ForEach-Object { "  $_" }) -join "`n")
---

# 튜토리얼 주제

본 TOPIC.md는 webapp-trigger hook이 자동 생성했다.
step001이 진입 시 본 파일의 session_prompt를 읽어 topic/audience/interactive/real_world_apps/constraints를 추출한다.

- raw_prompt: 위 session_prompt 블록 참조

## 결정/사유 (NEW-WORK-규칙 3번)

- 자동 추출 항목이 모호하면 step001이 즉시 결정·기록 후 진행 (질문 금지)
"@
$topicBody | Out-File -FilePath $topicFile -Encoding UTF8 -Force
# BOM 제거
$bytes = [System.IO.File]::ReadAllBytes($topicFile)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  [System.IO.File]::WriteAllBytes($topicFile, $bytes[3..($bytes.Length-1)])
}
Write-Log "TOPIC.md written"

# 3) progress.json 초기화
$progress = @{
  current_step = 1
  completed_steps = @()
  skipped_steps = @()
  failed_steps = @()
  total_steps = 107
  metrics = @{ total_duration_minutes = 0; total_sessions = 0; steps_per_session_avg = 0 }
  trust5_results = @{ r1 = $null; r2 = $null; r3 = $null }
  eval_rounds = @{
    r1 = @{ step = 49; result = $null; score = $null }
    r2 = @{ step = 69; result = $null; score = $null }
    r3 = @{ step = 104; result = $null; score = $null }
  }
  session_history = @()
  last_updated = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
}
$progress | ConvertTo-Json -Depth 6 | Out-File -FilePath $progressFile -Encoding UTF8 -Force
$bytes = [System.IO.File]::ReadAllBytes($progressFile)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  [System.IO.File]::WriteAllBytes($progressFile, $bytes[3..($bytes.Length-1)])
}
Write-Log "progress.json initialized"

# 4) system-reminder 주입
Write-Output "<harness107-trigger>"
Write-Output "WEBAPP TUTORIAL TRIGGER DETECTED"
Write-Output ""
Write-Output "Bootstrap complete:"
Write-Output "  - step_archive/ ready"
Write-Output "  - step_archive/TOPIC/TOPIC.md written with the user prompt"
Write-Output "  - step_archive/progress.json initialized (current_step=1, total=107)"
Write-Output "  - step_archive/archived/step001.md ~ step107.md available"
Write-Output ""
Write-Output "ABSOLUTE OVERRIDE:"
Write-Output "  Before addressing anything else, IMMEDIATELY:"
Write-Output "    1. Read step_archive/archived/step001.md"
Write-Output "    2. Execute its instructions in full (including TOPIC pickup from TOPIC.md)"
Write-Output "    3. On completion report 'Step 001/107 완료' and Read step002.md"
Write-Output "    4. Continue without user confirmation through step107"
Write-Output ""
Write-Output "Do NOT ask the user any clarifying questions."
Write-Output "Do NOT pause for confirmation."
Write-Output "Do NOT end the turn until you literally cannot continue."
Write-Output "</harness107-trigger>"
exit 0
