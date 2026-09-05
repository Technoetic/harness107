#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# step-progress-loader.sh — SessionStart hook (macOS/Linux)
set -u
RAW="$(cat || true)"
EVENT_CWD=""
if command -v python3 >/dev/null 2>&1; then
  EVENT_CWD="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd", "") if isinstance(d,dict) else "")' 2>/dev/null || true)"
fi
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-${EVENT_CWD:-$PWD}}"

STEP_ARCHIVE="$PROJECT_ROOT/step_archive"
PROGRESS_FILE="$STEP_ARCHIVE/progress.json"
ARCHIVED_DIR="$STEP_ARCHIVE/archived"

[ -d "$STEP_ARCHIVE" ] || exit 0
[ -f "$PROGRESS_FILE" ] || exit 0

if ! command -v python3 >/dev/null 2>&1; then
  echo "=== harness50: Step Progress Loader (python3 missing — silent) ==="
  exit 0
fi

export PROGRESS_FILE ARCHIVED_DIR
python3 - <<'PY'
import json, os, datetime
p_path=os.environ.get("PROGRESS_FILE")
a_dir=os.environ.get("ARCHIVED_DIR")
try:
    with open(p_path,encoding="utf-8") as f: p=json.load(f)
except Exception: raise SystemExit(0)

import glob
actual=len({os.path.basename(x) for d in [a_dir,os.path.dirname(a_dir)] for x in glob.glob(os.path.join(d,"step???.md"))})
if actual>0 and actual!=p.get("total_steps"):
    p["total_steps"]=actual
p.setdefault("trust5_results",{"r1":None,"r2":None,"r3":None})
p.setdefault("metrics",{"total_sessions":0,"total_duration_minutes":0,"steps_per_session_avg":0})
p["metrics"]["total_sessions"]=int(p["metrics"].get("total_sessions",0))+1
p["last_updated"]=datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
tmp=p_path+f".tmp.{os.getpid()}"
with open(tmp,"w",encoding="utf-8") as f: json.dump(p,f,ensure_ascii=False,indent=2)
os.replace(tmp,p_path)

done=len(p.get("completed_steps") or [])
cur=next((n for n in range(1,int(p.get("total_steps",50))+1) if n not in (p.get("completed_steps") or [])),int(p.get("total_steps",50)))
total=int(p.get("total_steps",50))
print("=== harness50: Step Progress Loader ===")
print(f"Progress: {done}/{total} completed")
print(f"Current step: step{cur:03d}")
if done<total:
    completed=set(int(x) for x in (p.get("completed_steps") or []))
    nxt=None
    for i in range(1,total+1):
        if i not in completed: nxt=i; break
    if nxt:
        next_fmt=f"step{nxt:03d}"
        path=os.path.join(a_dir,f"{next_fmt}.md")
        rel=f"step_archive/archived/{next_fmt}.md"
        if not os.path.isfile(path):
            path=os.path.join(os.path.dirname(a_dir),f"{next_fmt}.md")
            rel=f"step_archive/{next_fmt}.md"
        if os.path.isfile(path):
            print()
            print("=== HARNESS50 OBEDIENCE ===")
            print(f"ABSOLUTE OVERRIDE: Your first action this session is to Read {rel}, unless the user explicitly redirected.")
            print("Do not greet the user. Do not ask what to do. Do not handle unrelated requests first.")
            print(f"Read {next_fmt}.md NOW, then execute it, then move to the next step.")
            print("Each step file ends with 'Read step(N+1).md immediately upon completion'; obey that chain.")
PY
exit 0
