#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# step-progress-writer.sh — Stop hook (macOS/Linux)
set -u
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
STEP_ARCHIVE="$PROJECT_ROOT/step_archive"
ARCHIVED_DIR="$STEP_ARCHIVE/archived"
PROGRESS_FILE="$STEP_ARCHIVE/progress.json"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/step-progress-writer.log"
LOCK_FILE="$STEP_ARCHIVE/.writer.lock"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }
log "invoked"

[ -f "$PROGRESS_FILE" ] || exit 0
command -v python3 >/dev/null 2>&1 || { log "python3 missing"; exit 0; }

RAW="$(cat || true)"

# advisory file lock (best effort)
exec 9>"$LOCK_FILE" 2>/dev/null || true
if command -v flock >/dev/null 2>&1; then
  flock -w 5 9 || { log "flock timeout"; exit 0; }
fi

export RAW PROGRESS_FILE ARCHIVED_DIR
python3 - <<'PY'
import json, os, re, datetime, tempfile, shutil
raw=os.environ.get("RAW","")
p_path=os.environ["PROGRESS_FILE"]
a_dir=os.environ["ARCHIVED_DIR"]

try:
    with open(p_path,encoding="utf-8") as f: progress=json.load(f)
except Exception: raise SystemExit(0)

response=""
j=None
try: j=json.loads(raw) if raw else None
except Exception: j=None
if j:
    if j.get("last_assistant_message"):
        response+="\n"+j["last_assistant_message"]
    tp=j.get("transcript_path")
    if tp and os.path.exists(tp):
        try:
            with open(tp,encoding="utf-8") as f:
                for ln in f:
                    ln=ln.strip()
                    if not ln: continue
                    try:
                        e=json.loads(ln)
                        if e.get("type")=="assistant":
                            content=(e.get("message") or {}).get("content") or []
                            for b in content:
                                if b.get("type")=="text" and b.get("text"):
                                    response+="\n"+b["text"]
                    except Exception: pass
        except Exception: pass

total=int(progress.get("total_steps",107))
found=set()
for m in re.finditer(r'Step\s+(\d{1,3})\s*/\s*(\d{1,3})\s*완료', response, re.I):
    n=int(m.group(1)); tot=int(m.group(2))
    if 1<=n<=total and tot==total: found.add(n)
for m in re.finditer(r'(?m)(?:^|[\s✅→])Step\s+(\d{1,3})\s+완료', response, re.I):
    n=int(m.group(1))
    if 1<=n<=total: found.add(n)

valid={n for n in found if os.path.exists(os.path.join(a_dir,f"step{n:03d}.md"))}
existing=set(int(x) for x in (progress.get("completed_steps") or []))
new_ones=sorted(valid - existing)
if new_ones:
    all_done=sorted(existing | valid)
    progress["completed_steps"]=all_done
    maxC=max(all_done)
    progress["current_step"]=maxC+1 if maxC<total else total
    print(f"newly completed: {new_ones}, total {len(all_done)}/{total}")

progress["last_updated"]=datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

tmp=p_path+f".tmp.{os.getpid()}"
with open(tmp,"w",encoding="utf-8") as f:
    json.dump(progress,f,ensure_ascii=False,indent=2)
os.replace(tmp,p_path)
PY
exit 0
