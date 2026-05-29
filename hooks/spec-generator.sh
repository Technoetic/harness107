#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# spec-generator.sh - Stop hook (macOS/Linux)
set -u
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
PROGRESS_FILE="$PROJECT_ROOT/step_archive/progress.json"
SPEC_DIR="$PROJECT_ROOT/step_archive/specs"
ARCHIVED_DIR="$PROJECT_ROOT/step_archive/archived"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/spec-generator.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }

[ -f "$PROGRESS_FILE" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
mkdir -p "$SPEC_DIR"

export PROGRESS_FILE SPEC_DIR ARCHIVED_DIR
python3 - <<'PY'
import json, os, re, datetime
p=json.load(open(os.environ["PROGRESS_FILE"],encoding="utf-8"))
cur=int(p.get("current_step",0)); total=int(p.get("total_steps",107))
if cur<1 or cur>total: raise SystemExit(0)
num=f"{cur:03d}"
spec_path=os.path.join(os.environ["SPEC_DIR"],f"SPEC-{num}.md")
if os.path.exists(spec_path): raise SystemExit(0)
step_path=os.path.join(os.environ["ARCHIVED_DIR"],f"step{num}.md")
if not os.path.exists(step_path): raise SystemExit(0)

body=open(step_path,encoding="utf-8").read()
m=re.search(r'(?m)^#\s+(.+)$', body)
title=m.group(1).strip() if m else f"Step {cur}"
sm=re.search(r'(?ms)^##\s+(실행 내용|개요|목적|Step-Back|검증).+?(?=^##\s+|^---|\Z)', body)
ref="\n".join((sm.group(0).split("\n")[:30]) if sm else [f"본문 추출 실패. step{num}.md 직접 참조."])
prev=f"{cur-1:03d}"
now=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

content=f"""# SPEC-{num} — {title}

자동 생성: {now}
원본: step_archive/archived/step{num}.md

---

## WHAT
{title}

## WHY
다음 Step 진행에 필요한 결과물 산출.

## WHEN
- 이전 Step ({prev}) 완료
- progress.json.current_step == {cur}

## ACCEPTANCE
- Self-Calibration 통과
- 결과 파일 step_archive/step{num}_*.md 생성
- 평가 라운드(49/69/104) 도달 시 TRUST 5 게이트 통과

## REFERENCE
```
{ref}
```

## RUN-COMMAND
Read step_archive/archived/step{num}.md → 본문 실행
"""
open(spec_path,"w",encoding="utf-8").write(content)
PY
log "SPEC generated for current step"
exit 0
