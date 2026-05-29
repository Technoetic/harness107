#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# step-auto-continue.sh — Stop hook (macOS/Linux)
set -u
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
PROGRESS_FILE="$PROJECT_ROOT/step_archive/progress.json"
STATE_FILE="$(dirname "${BASH_SOURCE[0]}")/step-auto-continue.state"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/step-auto-continue.log"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }
log "invoked"

RAW="$(cat || true)"
[ -f "$PROGRESS_FILE" ] || { log "no progress.json"; exit 0; }

if ! command -v python3 >/dev/null 2>&1; then
  log "python3 missing -> release"
  exit 0
fi

# parse
read -r TOTAL CURRENT DONE STOP_ACTIVE LAST_MSG_FILE < <(python3 - <<PY "$PROGRESS_FILE"
import json,sys,os,tempfile
p=json.load(open(sys.argv[1],encoding='utf-8'))
total=int(p.get('total_steps',107))
cur=int(p.get('current_step',1))
done=len(p.get('completed_steps') or [])
raw=os.environ.get('RAW_STDIN','')
stop_active='false'
last=''
if raw:
    try:
        j=json.loads(raw)
        if j.get('stop_hook_active') is True: stop_active='true'
        last=j.get('last_assistant_message') or ''
    except Exception: pass
# write last_msg to temp file path
tf=tempfile.NamedTemporaryFile(mode='w',delete=False,encoding='utf-8',suffix='.tmp')
tf.write(last); tf.close()
print(total, cur, done, stop_active, tf.name)
PY
)
export RAW_STDIN="$RAW"

if [ "$DONE" -ge "$TOTAL" ] || [ "$CURRENT" -gt "$TOTAL" ]; then
  log "ALL DONE ($DONE/$TOTAL) -> release"
  rm -f "$LAST_MSG_FILE" 2>/dev/null || true
  exit 0
fi

CUR_STATE="completed=${DONE};current=${CURRENT}"
PREV_STATE=""
[ -f "$STATE_FILE" ] && PREV_STATE="$(cat "$STATE_FILE")"

if [ "$STOP_ACTIVE" = "true" ] && [ "$PREV_STATE" = "$CUR_STATE" ]; then
  log "no progress under stop_hook_active=true -> release"
  printf '%s' "$CUR_STATE" >"$STATE_FILE"
  rm -f "$LAST_MSG_FILE" 2>/dev/null || true
  exit 0
fi
printf '%s' "$CUR_STATE" >"$STATE_FILE"

# detect question/self-termination patterns in last assistant message
HAS_Q=0
if [ -s "$LAST_MSG_FILE" ]; then
  if grep -Eq '\?[[:space:]]*$|할까요|하시겠|선택해|어떻게 할|확인 부탁|원하시|Would you like|Should I|Let me know|Please confirm|Please choose|Do you want|다음 턴|자동 재개|이번 턴|한 턴 한도|한도 도달|종료합니다' "$LAST_MSG_FILE"; then
    HAS_Q=1
  fi
fi
rm -f "$LAST_MSG_FILE" 2>/dev/null || true

NEXT_STR="$(printf '%03d' "$CURRENT")"
TOTAL_STR="$(printf '%03d' "$TOTAL")"
NEXT_PLUS="$(printf '%03d' "$((CURRENT+1))")"
STEP_FILE="step_archive/archived/step${NEXT_STR}.md"

if [ "$HAS_Q" = "1" ]; then
  REASON="[HARNESS107 AUTO-RESUME - VIOLATION DETECTED]

Your last message contained a question, confirmation request, or self-termination phrase.
This breaks the mandatory auto-execution contract (Step 001~${TOTAL_STR} must run without user confirmation).

Progress: ${DONE}/${TOTAL} completed.
Next step (MUST execute immediately, no questions): step${NEXT_STR} (${STEP_FILE})

DO:
1. Read ${STEP_FILE}.
2. Execute its instructions.
3. Report 'Step ${NEXT_STR}/${TOTAL} 완료'.
4. Move to step${NEXT_PLUS} without confirmation.

Resume Step ${NEXT_STR} NOW."
else
  REASON="[HARNESS107 AUTO-RESUME]
Progress: ${DONE}/${TOTAL} completed.
Next step to execute: step${NEXT_STR} (${STEP_FILE})

MANDATORY:
1. Read ${STEP_FILE} (Read tool, single file).
2. Execute its instructions immediately.
3. On completion, report 'Step ${NEXT_STR}/${TOTAL} 완료' then auto-advance.
4. Continue without user confirmation through step${TOTAL_STR}.

Never ask the user questions. Only stop after Step ${TOTAL} completes.
Begin step${NEXT_STR} NOW unless the user explicitly redirected."
fi

# emit JSON {decision:"block", reason:"..."}
export REASON
python3 - <<'PY'
import json,os
print(json.dumps({"decision":"block","reason":os.environ.get("REASON","")}))
PY
exit 0
