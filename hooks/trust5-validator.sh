#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# trust5-validator.sh - Stop hook (macOS/Linux)
set -u
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
PROGRESS_FILE="$PROJECT_ROOT/step_archive/progress.json"
OUT_DIR="$PROJECT_ROOT/step_archive/outputs"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/trust5-validator.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }

[ -f "$PROGRESS_FILE" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

DONE="$(python3 -c "import json;p=json.load(open('$PROGRESS_FILE',encoding='utf-8'));print(len(p.get('completed_steps') or []))" 2>/dev/null || echo 0)"

ROUND=""
case "$DONE" in
  49) ROUND="r1" ;;
  69) ROUND="r2" ;;
  104) ROUND="r3" ;;
  *) exit 0 ;;
esac

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/trust5_$ROUND.md"
[ -f "$OUT_FILE" ] && exit 0

SRC_DIR="$PROJECT_ROOT/src"
COV_DIR="$PROJECT_ROOT/coverage"

TESTED=3; [ -d "$COV_DIR" ] && TESTED=8
READABLE=5
( cd "$PROJECT_ROOT" && npx biome check --max-diagnostics=0 src 2>&1 | grep -Eq 'no problems|0 errors' ) && READABLE=9
UNIFIED=4; [ -d "$SRC_DIR" ] && UNIFIED=8
SECURED=4
if command -v semgrep >/dev/null 2>&1; then
  ( cd "$PROJECT_ROOT" && semgrep --config=auto --quiet --error src >/dev/null 2>&1 ) && SECURED=9
fi

TRACKABLE=3
if [ -d "$SRC_DIR" ]; then
  ALL=$(find "$SRC_DIR" -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" -o -name "*.html" -o -name "*.css" \) 2>/dev/null | wc -l | tr -d ' ')
  MX=$(grep -lrE '@MX:(NOTE|WARN|ANCHOR|TODO)' "$SRC_DIR" --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' --include='*.html' --include='*.css' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ALL" -eq 0 ]; then TRACKABLE=5
  else TRACKABLE=$(python3 -c "print(round(($MX/$ALL)*10))"); fi
fi

TOTAL=$((TESTED+READABLE+UNIFIED+SECURED+TRACKABLE))
VERDICT="WARN"; [ "$TOTAL" -ge 40 ] && VERDICT="PASS"
NOW="$(date '+%Y-%m-%d %H:%M:%S')"

{
  echo "# TRUST 5 게이트 결과 - $ROUND (step$DONE 도달)"
  echo
  echo "생성: $NOW"
  echo
  echo "| 축 | 점수 | 측정 |"
  echo "|:---|:---:|:---|"
  echo "| Tested    | $TESTED/10    | coverage/ |"
  echo "| Readable  | $READABLE/10  | Biome check |"
  echo "| Unified   | $UNIFIED/10   | src/ |"
  echo "| Secured   | $SECURED/10   | semgrep --config=auto |"
  echo "| Trackable | $TRACKABLE/10 | @MX 4종 |"
  echo "| **총점**  | **$TOTAL/50** | — |"
  echo
  echo "## 판정: $VERDICT"
  echo
  echo "## 보강 권고"
  [ "$TESTED"    -lt 7 ] && echo "- Tested: 단위 테스트 추가 + c8 커버리지 측정"
  [ "$READABLE"  -lt 7 ] && echo "- Readable: biome check 0 errors 달성"
  [ "$UNIFIED"   -lt 7 ] && echo "- Unified: src/ 구조화 + 디자인 토큰 단일화"
  [ "$SECURED"   -lt 7 ] && echo "- Secured: semgrep findings 0건 달성"
  [ "$TRACKABLE" -lt 7 ] && echo "- Trackable: 모든 신규 소스에 @MX 4종 태그 부착"
} >"$OUT_FILE"
log "$ROUND = $TOTAL/50 ($VERDICT)"
exit 0
