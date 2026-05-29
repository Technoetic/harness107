#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# permission-request-guard.sh — PermissionRequest hook (macOS/Linux)
#
# 4회차 신규 — 다른 플러그인의 PermissionRequest hook이 updatedInput 으로
# 명령을 사후 변조하는 시도를 차단.
#
# 출처:
#   https://code.claude.com/docs/en/hooks
#     PermissionRequest hook이 hookSpecificOutput.decision.behavior=allow/deny
#     + decision.updatedInput 으로 사용자 대신 결정/변조 가능.
#     exit 2 → "Denies the permission".

set -u
RAW="$(cat 2>/dev/null || true)"

TOOL=""; CMD=""; FPATH=""; URL=""; NS=""
if [ -n "${RAW:-}" ] && command -v python3 >/dev/null 2>&1; then
  TOOL="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("tool_name","") or "")
except: pass' 2>/dev/null)"
  CMD="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}; print(ti.get("command","") or "")
except: pass' 2>/dev/null)"
  FPATH="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}; print(ti.get("file_path") or ti.get("notebook_path") or "")
except: pass' 2>/dev/null)"
  URL="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}; print(ti.get("url","") or "")
except: pass' 2>/dev/null)"
  NS="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}
  out=ti.get("new_string","") or ""
  for e in (ti.get("edits") or []):
    out += "\n" + (e.get("new_string","") or "")
  print(out)
except: pass' 2>/dev/null)"
fi

is_dangerous_cmd() {
  local c="$1"
  [ -z "$c" ] && return 1
  # 8회차 B-7: 코멘트 라인 스킵 (단일 라인 # 시작 시 검사 안 함, 다중 라인은 코멘트만 제거)
  c="$(printf '%s' "$c" | awk '!/^[[:space:]]*#/ && !/^[[:space:]]*$/')"
  [ -z "$c" ] && return 1
  # 7회차 C 동기화: destructive-guard.sh / auto-approve.sh 와 동일 카탈로그.
  # 신규: $HOME / ${HOME} / $PWD 변수 destructive 매칭 + PATH hijack 패턴.
  local patterns=(
    'rm[[:space:]]+(-[a-zA-Z]*[rfRF]+[a-zA-Z]*[[:space:]]+)+(/|\.|\*|~|--no-preserve-root|\$HOME|\$\{HOME|\$PWD|\$\{PWD)'
    'rm[[:space:]]+-[a-zA-Z]*[rfRF]+[a-zA-Z]*[[:space:]]+["'\'']?\$(\{|PWD|HOME)'
    'rm[[:space:]]+--recursive'
    'find[[:space:]]+/[[:space:]]+.*-delete'
    'find[[:space:]]+[^[:space:]]+[[:space:]]+.*-exec[[:space:]]+rm'
    'git[[:space:]]+push[[:space:]]+--force'
    'git[[:space:]]+reset[[:space:]]+--hard'
    'git[[:space:]]+clean[[:space:]]+-[fdx]'
    'git[[:space:]]+branch[[:space:]]+-D[[:space:]]+'
    'DROP[[:space:]]+TABLE|DROP[[:space:]]+DATABASE|TRUNCATE[[:space:]]+TABLE'
    'sudo[[:space:]]+'
    'su[[:space:]]+-'
    'chmod[[:space:]]+(-[a-zA-Z]+[[:space:]]+)?0?777'
    'mkfs\.'
    'dd[[:space:]]+.*of=/dev/(sd|nvme|hd)'
    '(curl|wget|fetch)[[:space:]]+.*\|[[:space:]]*(sh|bash|zsh)'
    'bash[[:space:]]+<\([[:space:]]*(curl|wget)'
    'crontab[[:space:]]+-[er]'
    'systemctl[[:space:]]+(stop|disable)[[:space:]]+'
    'shutdown[[:space:]]+|reboot[[:space:]]+|iptables[[:space:]]+-F|ufw[[:space:]]+disable'
    'ssh[[:space:]]+.*[[:space:]]+rm[[:space:]]+'
    'scp[[:space:]]+.*:[[:space:]]*/'
    'kubectl[[:space:]]+delete[[:space:]]+(ns|namespace|--all)'
    'terraform[[:space:]]+destroy[[:space:]]+(-auto-approve|-force)'
    # 7회차 C: PATH hijack (destructive-guard·auto-approve 와 동기화)
    '\bexport[[:space:]]+PATH[[:space:]]*='
    '\bset[[:space:]]+PATH[[:space:]]*='
    'PATH[[:space:]]*=[[:space:]]*[^;:]*[;:][[:space:]]*\$PATH'
    'PATH[[:space:]]*=[[:space:]]*\$PATH[[:space:]]*[;:]'
    # 8회차 A 신규: 패키지매니저 install
    '\b(apt|apt-get|yum|dnf|brew|pacman|pip|pip3|gem|cargo|conda|zypper|emerge|opkg|apk|snap|flatpak)\b[[:space:]]+(install|-S\b|-i\b|add\b)'
    '\bnpm[[:space:]]+install[[:space:]]+(-g|--global)\b'
    # 8회차 A 신규: 계정/권한 변경
    '\b(useradd|adduser|userdel|deluser|groupadd|groupdel|usermod|groupmod|chsh|passwd|gpasswd)\b'
    '\bchown[[:space:]]+(root|0)\b'
    '\bsetcap\b'
    '\bvisudo\b'
    '/etc/sudoers'
    # 8회차 A 신규: 리버스 쉘
    '\bnc(at)?[[:space:]]+(-l[vnpuk]*|--listen)\b'
    '\bbash[[:space:]]+-i[[:space:]]*>&?[[:space:]]*/dev/tcp/'
    '/dev/tcp/[0-9a-fA-F\.:]+/[0-9]+'
    '\bpython[0-9]*[[:space:]]+-c[[:space:]]+["'\''][^"'\'']*\b(socket|subprocess|pty)\b'
    '\bperl[[:space:]]+-e[[:space:]]+["'\''][^"'\'']*\bsocket\b'
    '\bruby[[:space:]]+-r?e[[:space:]]+["'\''][^"'\'']*\bTCPSocket\b'
    '\bphp[[:space:]]+-r[[:space:]]+["'\''][^"'\'']*\bfsockopen\b'
    '\bsocat[[:space:]]+(tcp|exec):'
  )
  for p in "${patterns[@]}"; do
    if printf '%s' "$c" | grep -Eq "$p"; then return 0; fi
  done
  return 1
}

is_sensitive_path() {
  local p="$1"
  [ -z "$p" ] && return 1
  # 정규화: URL-decode, backslash→slash, double slash→single, trailing dot/space 제거, lowercase
  # 6회차 B: WSL2 /mnt/c 의 8.3 short name expand 시도 + well-known short token 매칭
  local norm
  norm="$(printf '%s' "$p" | python3 -c '
import sys, urllib.parse, re, os, os.path
s = sys.stdin.read()
s = urllib.parse.unquote(s)
s = s.replace("\\", "/")
s = re.sub(r"/+", "/", s)
s = re.sub(r"[\. ]+$", "", s)
s = re.sub(r"^//\?/", "", s)
s = re.sub(r"^//", "/", s)
if re.search(r"~\d", s):
    try:
        rp = os.path.realpath(s)
        if rp and rp != s and "~" not in rp:
            s = rp
    except Exception:
        pass
print(s.lower())
' 2>/dev/null)"
  [ -z "$norm" ] && norm="$p"
  # 6회차 B: 8.3 short token sensitive 분류
  if printf '%s' "$norm" | grep -Eiq '(^|/)(progra~[0-9]+|window~[0-9]+|system~[0-9]+|admini~[0-9]+|docume~[0-9]+|mydocu~[0-9]+|users~[0-9]+|appdat~[0-9]+|locals~[0-9]+|alluse~[0-9]+)(/|$)'; then
    return 0
  fi
  local patterns=(
    '\.ssh/(authorized_keys|id_[a-z0-9_]+|known_hosts|config)$'
    '\.ssh/?$'
    '\.gnupg/'
    '\.aws/(credentials|config)$'
    '\.azure/'
    '\.config/gcloud/'
    '\.kube/config$'
    '\.docker/config\.json$'
    '/(\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.zshenv)$'
    '\.claude/settings\.json$'
    '\.claude/settings\.local\.json$'
    '^/etc/'
    '^/var/'
    '^/boot/'
    '/system32/|/windows/|/program files/'
    'harness107/hooks/(destructive-guard|auto-approve|permission-request-guard|step-auto-continue|hooks\.json)'
    'harness107/\.claude-plugin/plugin\.json$'
  )
  for sp in "${patterns[@]}"; do
    if printf '%s' "$norm" | grep -Eq "$sp"; then return 0; fi
  done
  return 1
}

BLOCKED=0
REASON=""

case "$TOOL" in
  Bash)
    if is_dangerous_cmd "$CMD"; then
      BLOCKED=1
      REASON="harness107: PermissionRequest blocked - destructive command (cross-plugin tamper protection)"
    fi
    ;;
  Write|Edit|MultiEdit|NotebookEdit)
    if is_sensitive_path "$FPATH"; then
      BLOCKED=1
      REASON="harness107: PermissionRequest blocked - sensitive path"
    fi
    # 4회차 D-2/D-3: new_string 내 destructive 검사
    if [ "$BLOCKED" -eq 0 ] && [ -n "$NS" ] && is_dangerous_cmd "$NS"; then
      BLOCKED=1
      REASON="harness107: PermissionRequest blocked - destructive content in new_string"
    fi
    ;;
  WebFetch)
    if [ -n "$URL" ]; then
      url_patterns=(
        '^https?://(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'
        '^https?://(169\.254\.169\.254|metadata\.google\.internal|metadata\.azure\.com)'
        '\.(sh|ps1|bat|cmd|exe|dll|so|dylib|msi)(\?|$)'
        '^file://'
      )
      for dp in "${url_patterns[@]}"; do
        if printf '%s' "$URL" | grep -Eq "$dp"; then
          BLOCKED=1
          REASON="harness107: PermissionRequest blocked - dangerous URL"
          break
        fi
      done
    fi
    ;;
esac

if [ "$BLOCKED" -eq 1 ]; then
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","reason":"$REASON"}}}
EOF
  # 이중 안전: exit 2 → Denies the permission (공식 문서)
  exit 2
fi

exit 0
