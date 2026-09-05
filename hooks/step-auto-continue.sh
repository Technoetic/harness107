#!/usr/bin/env bash
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
command -v python3 >/dev/null 2>&1 || exit 0
export RAW_STDIN="$(cat || true)"
python3 - <<'PY_STOP'
import json, os, re
try:
    event=json.loads(os.environ.get('RAW_STDIN') or '{}')
    root=os.environ.get('CLAUDE_PROJECT_DIR') or event.get('cwd') or os.getcwd()
    archive=os.path.join(root,'step_archive')
    with open(os.path.join(archive,'progress.json'),encoding='utf-8-sig') as f: p=json.load(f)
    if p.get('paused') is True or p.get('status')=='paused': raise SystemExit(0)
    total=int(p['total_steps'])
    if not 1<=total<=999: raise SystemExit(0)
    done=sorted(set(p.get('completed_steps') or []))
    current=next((n for n in range(1,total+1) if n not in done),0)
    if not current: raise SystemExit(0)
    session=re.sub('[^a-zA-Z0-9-]','',str(event.get('session_id') or ''))
    state=os.path.join(archive,'step-auto-continue'+('.'+session if session else '')+'.state')
    signature='completed='+str(len(done))+';current='+str(current)
    stall=0
    try:
        with open(state,encoding='utf-8-sig') as f: previous=f.read().strip()
        old,count=previous.rsplit('|stall=',1)
        if event.get('stop_hook_active') is True and old==signature: stall=int(count)+1
    except (OSError,ValueError): pass
    tmp=state+'.tmp.'+str(os.getpid())
    with open(tmp,'w',encoding='utf-8') as f: f.write(signature+'|stall='+str(min(stall,3)))
    os.replace(tmp,state)
    if stall>=3: raise SystemExit(0)
    step=f'step{current:03d}.md'
    relative='step_archive/archived/'+step if os.path.isfile(os.path.join(archive,'archived',step)) else 'step_archive/'+step
    print(json.dumps({'decision':'block','reason':f'[HARNESS] {len(done)}/{total} done. Read and execute {relative}, report completion, then continue. User direct requests take priority.'}))
except (OSError,ValueError,KeyError,TypeError): pass
PY_STOP
exit 0
