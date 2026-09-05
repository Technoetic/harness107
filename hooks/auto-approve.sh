#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# auto-approve.sh — PreToolUse hook (macOS/Linux)
#
# harness50 자율주행을 위한 자동 권한 승인.
# Approval is limited to eligible project edits and WebSearch during an active workflow.
#
# 출처 (재검증 2회차):
#   https://code.claude.com/docs/en/hooks
#     "All matching hooks run in parallel" -> destructive-guard 와 본 hook
#     은 병렬 실행된다. race-safe 를 위해 본 hook 자체에서도 위험 패턴을
#     재검증한다.
#   https://code.claude.com/docs/en/permissions
#     "A blocking hook also takes precedence over allow rules. A hook that
#      exits with code 2 stops the tool call before permission rules are
#      evaluated." -> destructive-guard exit 2 가 최종.

set -u
RAW="$(cat 2>/dev/null || true)"

# A missing runtime or failed policy check can never grant approval.
command -v node >/dev/null 2>&1 || exit 0
POLICY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ELIGIBILITY="$(printf '%s' "$RAW" | node "$POLICY_ROOT/lib/approval-policy.mjs" auto 2>/dev/null)" || exit 0
[ "$ELIGIBILITY" = eligible ] || exit 0


TOOL=""
CMD=""
if [ -n "${RAW:-}" ] && command -v python3 >/dev/null 2>&1; then
  TOOL="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("tool_name","") or "")
except: pass' 2>/dev/null)"
  CMD="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print((d.get("tool_input") or {}).get("command","") or "")
except: pass' 2>/dev/null)"
fi

case "$TOOL" in
  Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch) ;;
  *) exit 0 ;;
esac

# [보안 수정 — 하네스 활성 게이트] auto-approve는 harness50 자율주행이 실제
# 가동 중일 때만 발화한다. progress.json이 없으면(무관한 일반 세션) 자동승인을
# 발급하지 않고 정상 권한 흐름으로 떨어뜨린다 (전역 자동승인 결함 차단).
 # Active workflow state is validated by approval-policy.mjs above.

# 8회차 B-7: 코멘트 라인 스킵 헬퍼 (단일 라인 # 코멘트 false-positive 방지).
# 단일/다중 라인 모두 코멘트가 아닌 비공백 라인만 남긴다.
strip_comment_lines() {
  printf '%s' "$1" | awk '!/^[[:space:]]*#/ && !/^[[:space:]]*$/'
}

# Bash 도구 CMD에 코멘트 스킵 적용
if [ "$TOOL" = "Bash" ] && [ -n "${CMD:-}" ]; then
  CMD="$(strip_comment_lines "$CMD")"
fi

# 4회차 정규화 헬퍼: URL-decode + backslash→slash + // 축약 + trailing dot/space 제거 + lowercase
# 6회차 B 추가: WSL2/MSYS의 /mnt/c/PROGRA~1 같은 8.3 short name 흔적이 남으면 expand 시도 후
#               실패 시 보수적으로 well-known short name을 sensitive로 분류한다 (sensitive_short_token).
normalize_path() {
  printf '%s' "$1" | python3 -c '
import sys, urllib.parse, re, os, os.path
s = sys.stdin.read()
s = urllib.parse.unquote(s)
s = s.replace("\\", "/")
s = re.sub(r"/+", "/", s)
s = re.sub(r"[\. ]+$", "", s)
s = re.sub(r"^//\?/", "", s)
s = re.sub(r"^//", "/", s)
# 6회차 B: WSL2 /mnt/c 경로의 8.3 short name expand 시도
if re.search(r"~\d", s):
    try:
        rp = os.path.realpath(s)
        if rp and rp != s and "~" not in rp:
            s = rp
    except Exception:
        pass
print(s.lower())
' 2>/dev/null
}

# 6회차 B 신규: 8.3 well-known short name 패턴이 path 안에 남아 있으면 sensitive로 간주
# (사용자 의도 literal 디렉토리는 normal이지만, 시스템 파일시스템에 자동 expand되는 위험을 차단)
sensitive_short_token() {
  local p="$1"
  printf '%s' "$p" | grep -Eiq '(^|/)(PROGRA~[0-9]+|WINDOW~[0-9]+|SYSTEM~[0-9]+|ADMINI~[0-9]+|DOCUME~[0-9]+|MYDOCU~[0-9]+|USERS~[0-9]+|APPDAT~[0-9]+|LOCALS~[0-9]+|ALLUSE~[0-9]+)(/|$)'
}

# 3회차 + 4회차 보강: Write/Edit 의 민감 경로 + 자기 hook 파일 보호. 정규화 매칭.
if [ "$TOOL" = "Write" ] || [ "$TOOL" = "Edit" ] || [ "$TOOL" = "MultiEdit" ] || [ "$TOOL" = "NotebookEdit" ]; then
  FPATH=""
  if [ -n "${RAW:-}" ] && command -v python3 >/dev/null 2>&1; then
    FPATH="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}; print(ti.get("file_path") or ti.get("notebook_path") or "")
except: pass' 2>/dev/null)"
  fi
  if [ -n "${FPATH:-}" ]; then
    FPATH_NORM="$(normalize_path "$FPATH")"
    [ -z "$FPATH_NORM" ] && FPATH_NORM="$FPATH"
    # 6회차 B: 8.3 short name이 normalize에서 expand되지 않으면 sensitive로 분류
    if sensitive_short_token "$FPATH_NORM"; then
      exit 0
    fi
    SENSITIVE_PATH_PATTERNS=(
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
      'harness50/hooks/(destructive-guard|auto-approve|permission-request-guard|step-auto-continue|hooks\.json)'
      'harness50/\.claude-plugin/plugin\.json$'
    )
    for sp in "${SENSITIVE_PATH_PATTERNS[@]}"; do
      if printf '%s' "$FPATH_NORM" | grep -Eq "$sp"; then
        exit 0
      fi
    done
  fi

  # 4회차 D-2/D-3: Edit / MultiEdit 의 new_string 내 destructive 패턴 검사.
  NS_ALL=""
  if [ -n "${RAW:-}" ] && command -v python3 >/dev/null 2>&1; then
    NS_ALL="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}
  out=ti.get("new_string","") or ""
  for e in (ti.get("edits") or []):
    out += "\n" + (e.get("new_string","") or "")
  print(out)
except: pass' 2>/dev/null)"
  fi
  if [ -n "$NS_ALL" ]; then
    # 8회차 B-7: new_string도 코멘트 스킵
    NS_ALL="$(strip_comment_lines "$NS_ALL")"
  fi
  if [ -n "$NS_ALL" ]; then
    # 7회차 C 동기화: permission-request-guard.sh is_dangerous_cmd 와 동일 카탈로그.
    # sudo 일반(\s+), PATH hijack, $HOME 변수 destructive 패턴 보강.
    NS_DANGER_PATTERNS=(
      'rm[[:space:]]+(-[a-zA-Z]*[rfRF]+[a-zA-Z]*[[:space:]]+)+(/|\.|\*|~|--no-preserve-root|\$HOME|\$\{HOME|\$PWD|\$\{PWD)'
      'rm[[:space:]]+--recursive'
      'find[[:space:]]+/[[:space:]]+.*-delete'
      'find[[:space:]]+[^[:space:]]+[[:space:]]+.*-exec[[:space:]]+rm'
      'sudo[[:space:]]+'
      'su[[:space:]]+-'
      'chmod[[:space:]]+(-[a-zA-Z]+[[:space:]]+)?0?777'
      'mkfs\.'
      'dd[[:space:]]+.*of=/dev/(sd|nvme|hd)'
      '(curl|wget|fetch)[[:space:]]+.*\|[[:space:]]*(sh|bash|zsh)'
      'bash[[:space:]]+<\([[:space:]]*(curl|wget)'
      'eval[[:space:]]+["'\'']?\$\([[:space:]]*(curl|wget)'
      '\bexport[[:space:]]+PATH[[:space:]]*='
      '\bset[[:space:]]+PATH[[:space:]]*='
      'PATH[[:space:]]*=[[:space:]]*[^;:]*[;:][[:space:]]*\$PATH'
      'PATH[[:space:]]*=[[:space:]]*\$PATH[[:space:]]*[;:]'
      'crontab[[:space:]]+-[er]'
      'shutdown[[:space:]]+|reboot[[:space:]]+'
      'DROP[[:space:]]+TABLE|DROP[[:space:]]+DATABASE|TRUNCATE[[:space:]]+TABLE'
      'git[[:space:]]+push[[:space:]]+--force'
      'git[[:space:]]+reset[[:space:]]+--hard'
      'git[[:space:]]+clean[[:space:]]+-[fdx]'
      'git[[:space:]]+branch[[:space:]]+-D[[:space:]]+'
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
    for dp in "${NS_DANGER_PATTERNS[@]}"; do
      if printf '%s' "$NS_ALL" | grep -Eq "$dp"; then
        exit 0
      fi
    done
  fi
fi

# 3회차 추가: WebFetch 의 위험 도메인 사전 검사.
if [ "$TOOL" = "WebFetch" ]; then
  URL=""
  if [ -n "${RAW:-}" ] && command -v python3 >/dev/null 2>&1; then
    URL="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print((d.get("tool_input") or {}).get("url","") or "")
except: pass' 2>/dev/null)"
  fi
  if [ -n "${URL:-}" ]; then
    DANGEROUS_URL_PATTERNS=(
      '^https?://(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'
      '^https?://(169\.254\.169\.254|metadata\.google\.internal|metadata\.azure\.com)'
      '\.(sh|ps1|bat|cmd|exe|dll|so|dylib|msi)(\?|$)'
      '^file://'
    )
    for dp in "${DANGEROUS_URL_PATTERNS[@]}"; do
      if printf '%s' "$URL" | grep -Eq "$dp"; then
        exit 0
      fi
    done
  fi
fi

# 4회차 B: Bash PATH hijack 방어.
# 다른 플러그인의 bin/ 디렉토리가 PATH 앞에 추가되면 시스템 바이너리(rm, sudo, curl)
# 가 shadow 된다. 명령에 PATH 변조가 포함되면 approve 안 함.
if [ "$TOOL" = "Bash" ] && [ -n "${CMD:-}" ]; then
  PATH_HIJACK_PATTERNS=(
    '\bexport[[:space:]]+PATH[[:space:]]*='
    '\bPATH[[:space:]]*=[[:space:]]*[^[:space:]]*:[[:space:]]*\$PATH'
    '\bPATH[[:space:]]*=[[:space:]]*\$PATH[[:space:]]*:'
    '\$env:PATH[[:space:]]*='
    '\$env:Path[[:space:]]*='
  )
  for pp in "${PATH_HIJACK_PATTERNS[@]}"; do
    if printf '%s' "$CMD" | grep -Eq "$pp"; then
      exit 0
    fi
  done
fi

# Bash 도구의 경우 명령 안전성 재검증 (race-safe).
if [ "$TOOL" = "Bash" ] && [ -n "${CMD:-}" ]; then
  DESTRUCTIVE_PATTERNS=(
    'rm[[:space:]]+(-[a-zA-Z]*[rfRF]+[a-zA-Z]*[[:space:]]+)+(/|\.|\*|~|--no-preserve-root)'
    'rm[[:space:]]+(-[rR][[:space:]]+-[fF]|-[fF][[:space:]]+-[rR])[[:space:]]+'
    'rm[[:space:]]+--recursive[[:space:]]+'
    'rm[[:space:]]+--force[[:space:]]+--recursive'
    'find[[:space:]]+/[[:space:]]+.*-delete'
    'find[[:space:]]+[^[:space:]]+[[:space:]]+.*-exec[[:space:]]+rm'
    'git[[:space:]]+push[[:space:]]+--force'
    'git[[:space:]]+push[[:space:]]+--force-with-lease'
    'git[[:space:]]+push[[:space:]]+-f[[:space:]]+'
    'git[[:space:]]+reset[[:space:]]+--hard'
    'git[[:space:]]+clean[[:space:]]+-[fdx]'
    'git[[:space:]]+checkout[[:space:]]+\.'
    'git[[:space:]]+restore[[:space:]]+\.'
    'git[[:space:]]+branch[[:space:]]+-D[[:space:]]+'
    'DROP[[:space:]]+TABLE|DROP[[:space:]]+DATABASE|DROP[[:space:]]+SCHEMA|TRUNCATE[[:space:]]+TABLE'
    'npm[[:space:]]+publish'
    'chmod[[:space:]]+(-[a-zA-Z]+[[:space:]]+)?0?777|chmod[[:space:]]+(-[a-zA-Z]+[[:space:]]+)?a\+rwx'
    'mkfs\.'
    'dd[[:space:]]+.*of=/dev/(sd|nvme|hd)'
    '>[[:space:]]*/dev/(sd|nvme|hd)'
    '(curl|wget|fetch)[[:space:]]+.*\|[[:space:]]*(sh|bash|zsh)'
    'aws[[:space:]]+(s3[[:space:]]+rb|iam[[:space:]]+delete-user|ec2[[:space:]]+terminate-instances)'
    'docker[[:space:]]+(rmi[[:space:]]+-f|volume[[:space:]]+rm[[:space:]]+-f|system[[:space:]]+prune[[:space:]]+-af)'
    'kubectl[[:space:]]+delete[[:space:]]+(ns|namespace|node|pv|pvc|--all)'
    'terraform[[:space:]]+destroy[[:space:]]+(-auto-approve|-force)'
    '(ngrok|cloudflared)[[:space:]]+http[[:space:]]+(0\.0\.0\.0|\*)'
    'echo[[:space:]]+["'\''](AKIA|ghp_|sk-|xoxb-)'
    # 2회차 추가 보강:
    'sudo[[:space:]]+'
    'su[[:space:]]+-'
    'crontab[[:space:]]+-[er]'
    'systemctl[[:space:]]+(stop|disable)[[:space:]]+'
    'launchctl[[:space:]]+(unload|remove)[[:space:]]+'
    'pip[[:space:]]+install[[:space:]]+.*--index-url[[:space:]]+'
    'npm[[:space:]]+install[[:space:]]+.*--registry[[:space:]]+'
    'curl[[:space:]]+.*\|[[:space:]]*python'
    'wget[[:space:]]+.*\|[[:space:]]*python'
    'bash[[:space:]]+<\([[:space:]]*curl'
    'bash[[:space:]]+<\([[:space:]]*wget'
    'eval[[:space:]]+["'\'']?\$\([[:space:]]*(curl|wget)'
    'ssh[[:space:]]+.*[[:space:]]+rm[[:space:]]+'
    'scp[[:space:]]+.*:[[:space:]]*/'
    'iptables[[:space:]]+-F'
    'ufw[[:space:]]+disable'
    'shutdown[[:space:]]+'
    'reboot[[:space:]]+'
    'halt[[:space:]]+'
    'init[[:space:]]+0'
    'init[[:space:]]+6'
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
    # [보안 수정 C2] 인터프리터 경유 파일 삭제 (내부 따옴표에 끊기지 않게 자유 매칭)
    '\bpython[0-9]*[[:space:]]+-c\b.*(shutil\.rmtree|os\.(remove|unlink|rmdir))'
    '\bnode[[:space:]]+(-e|--eval)\b.*(rmSync|unlinkSync|rmdirSync|fs\.rm|fs\.unlink|fs\.rmdir)'
    '\bperl[[:space:]]+-e\b.*(unlink|rmtree|File::Path)'
    '\bruby[[:space:]]+-r?e\b.*(FileUtils\.rm|File\.delete|Dir\.(rmdir|delete))'
    # [보안 수정 C2] 변수 인다이렉션 재귀 삭제 ($X -rf ...). 재귀 플래그(r) 필수.
    '\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]'
    'eval[[:space:]]+["'\''][^"'\'']*\brm\b'
    # [보안 수정 C3] git 훅/앨리어스 하이재킹
    'git[[:space:]]+config[[:space:]]+.*core\.hooksPath'
    'git[[:space:]]+config[[:space:]]+.*alias\.'
    '\.git/hooks/'
    # [보안 수정 C3] 2단계 다운로드 후 실행
    '(curl|wget)[[:space:]]+[^|]*-[oO][[:space:]]+[^[:space:]]+.*(&&|;|\|\|).*(\b(sh|bash|zsh|source)\b|\./|python|node|perl)'
    'chmod[[:space:]]+\+x[[:space:]]+[^[:space:]]+.*(&&|;).*(\./|\bbash\b|\bsh\b)'
    # [보안 수정 H7] 자격증명/비밀키 읽기·유출
    '\b(cat|less|more|head|tail|cp|mv|tar|zip|base64|xxd|od|strings)\b[^|;&]*(\.ssh/|\.aws/|\.gnupg/|\.kube/config|id_rsa|id_ed25519|id_ecdsa|credentials\b|\.env\b|\.npmrc\b|\.pypirc\b)'
    'curl[[:space:]]+[^|]*(-T[[:space:]]|--upload-file|--data-binary[[:space:]]+@|-d[[:space:]]+@|-F[[:space:]]+[^[:space:]]*=@)'
    '(id_rsa|id_ed25519|credentials|\.env)\b[^|]*\|[[:space:]]*(curl|wget|nc|ncat)\b'
  )
  for p in "${DESTRUCTIVE_PATTERNS[@]}"; do
    if printf '%s' "$CMD" | grep -Eq "$p"; then
      # 위험 명령 -> approve 하지 않음. destructive-guard 가 차단.
      exit 0
    fi
  done
fi

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"harness50 autopilot mode: $TOOL auto-approved (race-safe pattern check passed)"}}
EOF
exit 0
