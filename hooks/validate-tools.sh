#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# validate-tools.sh - on-demand wrapper for step003~014 환경 검증
# Usage: bash hooks/validate-tools.sh <playwright|axe|biome|stylelint|c8|jscpd>
set -u
TOOL="${1:-}"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$PROJECT_ROOT" || exit 1

case "$TOOL" in
  playwright) npx playwright --version ;;
  axe) node -e 'console.log(require("@axe-core/playwright")?"OK":"FAIL")' ;;
  biome) npx biome --version ;;
  stylelint) npx stylelint --version ;;
  c8) npx c8 --version ;;
  jscpd) npx jscpd --version ;;
  *) echo "Unknown tool: $TOOL (use playwright|axe|biome|stylelint|c8|jscpd)"; exit 1 ;;
esac
