#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# mx-tag-validator.sh - PostToolUse(Write|Edit) hook (macOS/Linux)
set -u
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/mx-tag-validator.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }

RAW="$(cat || true)"
[ -z "$RAW" ] && exit 0
command -v python3 >/dev/null 2>&1 || exit 0

FP="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}
  print(ti.get("file_path") or ti.get("path") or "")
except: pass' 2>/dev/null)"
[ -z "$FP" ] && exit 0

case "${FP##*.}" in
  js|jsx|ts|tsx|mjs|cjs|html|css|py|go|rs) ;;
  *) exit 0 ;;
esac

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
PROGRESS_FILE="$PROJECT_ROOT/step_archive/progress.json"
[ -f "$PROGRESS_FILE" ] || exit 0
CUR="$(python3 -c "import json;print(int(json.load(open('$PROGRESS_FILE',encoding='utf-8')).get('current_step',1)))" 2>/dev/null || echo 1)"
[ "$CUR" -lt 15 ] && exit 0

case "$FP" in
  */step_archive/*|*/.claude/*|*/node_modules/*|*/.git/*|*/plugins/harness50/*) exit 0 ;;
esac
[ -f "$FP" ] || exit 0

if grep -qE '@MX:(NOTE|WARN|ANCHOR|TODO)' "$FP" 2>/dev/null; then
  if grep -qE '@MX:(WARN|ANCHOR)' "$FP" && ! grep -q '@MX:REASON' "$FP"; then
    echo "[@MX-WARN] $FP has WARN/ANCHOR but missing @MX:REASON sub-line" 1>&2
  fi
  log "OK [step=$CUR] $FP"
  exit 0
fi

log "[@MX-WARN] $FP has no @MX tags"
echo "[@MX-WARN] $FP has no @MX tags (NOTE/WARN/ANCHOR/TODO)" 1>&2
echo "Add: // @MX:NOTE: <intent>  // @MX:WARN: <risk> (+ @MX:REASON)  // @MX:ANCHOR: <invariant>  // @MX:TODO: <pending>" 1>&2
exit 0
