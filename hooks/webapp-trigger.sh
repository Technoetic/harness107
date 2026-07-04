#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# webapp-trigger.sh — UserPromptSubmit hook (macOS/Linux)
# Mirrors webapp-trigger.ps1 — detects webapp tutorial trigger, bootstraps step_archive/,
# writes TOPIC.md, resets progress.json, emits a system-reminder forcing step001 entry.

set -u

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
STEP_ARCHIVE="$PROJECT_ROOT/step_archive"
ARCHIVED_DIR="$STEP_ARCHIVE/archived"
TOPIC_DIR="$STEP_ARCHIVE/TOPIC"
PROGRESS_FILE="$STEP_ARCHIVE/progress.json"
TOPIC_FILE="$TOPIC_DIR/TOPIC.md"
ASSET_STEPS="$PLUGIN_ROOT/assets/steps"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/webapp-trigger.log"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

RAW="$(cat || true)"
[ -z "$RAW" ] && exit 0

# extract "prompt" field from stdin JSON without jq dependency: fall back to python3 if present
PROMPT=""
if command -v python3 >/dev/null 2>&1; then
  PROMPT="$(printf '%s' "$RAW" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("prompt",""))' 2>/dev/null || true)"
elif command -v jq >/dev/null 2>&1; then
  PROMPT="$(printf '%s' "$RAW" | jq -r '.prompt // ""' 2>/dev/null || true)"
else
  # crude grep fallback
  PROMPT="$(printf '%s' "$RAW" | grep -oE '"prompt"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"(.*)"/\1/')"
fi
[ -z "$PROMPT" ] && exit 0

# trigger patterns (POSIX ERE)
PATTERNS=(
  '튜토리얼.*(생성|만들어|제작)'
  '인터랙티브.*필수.*초보자'
  '@step_archive/archived/step001\.md'
  '^/webapp[[:space:]]+'
  'webapp[[:space:]]+생성'
  '웹앱.*튜토리얼'
  '인터렉티브.*필수'
  '(대시보드|웹앱|웹[[:space:]]*앱|웹[[:space:]]*페이지|web[[:space:]]*app).*(튜토리얼|초보자|인터랙티브|인터렉티브)'
)
MATCHED=0
for p in "${PATTERNS[@]}"; do
  if printf '%s' "$PROMPT" | grep -Eq "$p"; then MATCHED=1; break; fi
done
[ "$MATCHED" = "0" ] && exit 0
log "TRIGGER matched"

# [수정 H-2] 이미 진행 중이면 재부트스트랩하지 않는다 (progress.json 파괴 방지)
if [ -f "$PROGRESS_FILE" ]; then
  log "progress.json already exists — skip bootstrap"
  cat <<'RM'
<harness107-trigger>
이미 harness107 자율주행이 진행 중입니다 (step_archive/progress.json 존재).
기존 진행 상태 보존을 위해 재부트스트랩하지 않습니다.
처음부터 다시 시작하려면 /harness-reset 을 먼저 실행하세요.
그 외에는 progress.json의 current_step 부터 이어서 실행하세요.
</harness107-trigger>
RM
  exit 0
fi

mkdir -p "$STEP_ARCHIVE" "$ARCHIVED_DIR" "$TOPIC_DIR"

# copy step001~107 if missing
if [ -d "$ASSET_STEPS" ]; then
  for src in "$ASSET_STEPS"/step*.md; do
    [ -e "$src" ] || continue
    base="$(basename "$src")"
    dst="$ARCHIVED_DIR/$base"
    [ ! -e "$dst" ] && cp "$src" "$dst"
  done
fi

# H4 수정: html-bundler를 프로젝트로 복사 (step081/038에서 실행 가능하게)
TOOLS_DIR="$STEP_ARCHIVE/tools"
mkdir -p "$TOOLS_DIR"
HOOK_DIR="$(dirname "${BASH_SOURCE[0]}")"
for b in html-bundler.ps1 html-bundler.sh; do
  [ -f "$HOOK_DIR/$b" ] && cp "$HOOK_DIR/$b" "$TOOLS_DIR/$b"
done

# TOPIC.md
TODAY="$(date '+%Y-%m-%d')"
{
  echo "---"
  echo "created: $TODAY"
  echo "session_prompt: |"
  printf '%s\n' "$PROMPT" | sed 's/^/  /'
  echo "---"
  echo
  echo "# 튜토리얼 주제"
  echo
  echo "본 TOPIC.md는 webapp-trigger hook이 자동 생성했다."
  echo "step001 진입 시 session_prompt를 읽어 topic/audience/interactive/real_world_apps/constraints를 추출한다."
  echo
  echo "- raw_prompt: 위 session_prompt 블록 참조"
  echo
  echo "## 결정/사유 (NEW-WORK-규칙 3번)"
  echo
  echo "- 자동 추출 항목이 모호하면 step001이 즉시 결정·기록 후 진행 (질문 금지)"
} >"$TOPIC_FILE"
log "TOPIC.md written"

# progress.json
NOW="$(date '+%Y-%m-%dT%H:%M:%S')"
cat >"$PROGRESS_FILE" <<JSON
{
  "current_step": 1,
  "completed_steps": [],
  "skipped_steps": [],
  "failed_steps": [],
  "total_steps": 107,
  "metrics": { "total_duration_minutes": 0, "total_sessions": 0, "steps_per_session_avg": 0 },
  "trust5_results": { "r1": null, "r2": null, "r3": null },
  "eval_rounds": {
    "r1": { "step": 49,  "result": null, "score": null },
    "r2": { "step": 69,  "result": null, "score": null },
    "r3": { "step": 104, "result": null, "score": null }
  },
  "session_history": [],
  "last_updated": "$NOW"
}
JSON
log "progress.json initialized"

# system-reminder
cat <<'REMINDER'
<harness107-trigger>
WEBAPP TUTORIAL TRIGGER DETECTED

Bootstrap complete:
  - step_archive/ ready
  - step_archive/TOPIC/TOPIC.md written with the user prompt
  - step_archive/progress.json initialized (current_step=1, total=107)
  - step_archive/archived/step001.md ~ step107.md available

ABSOLUTE OVERRIDE:
  Before addressing anything else, IMMEDIATELY:
    1. Read step_archive/archived/step001.md
    2. Execute its instructions in full (including TOPIC pickup from TOPIC.md)
    3. On completion report 'Step 001/107 완료' and Read step002.md
    4. Continue without user confirmation through step107

Do NOT ask the user any clarifying questions.
Do NOT pause for confirmation.
Do NOT end the turn until you literally cannot continue.
</harness107-trigger>
REMINDER
exit 0
