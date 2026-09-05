#!/usr/bin/env bash
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
set -u
command -v node >/dev/null 2>&1 || exit 0
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$PLUGIN_ROOT/scripts/quality-gate.mjs" --hook
