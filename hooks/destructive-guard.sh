#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# destructive-guard.sh — PreToolUse(Bash) hook (macOS/Linux)
# exit 2 + stderr blocks the tool call.
set -u
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/destructive-guard.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }

RAW="$(cat || true)"
[ -z "$RAW" ] && exit 0

if command -v python3 >/dev/null 2>&1; then
  CMD="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print((d.get("tool_input") or {}).get("command","") or "")
except: pass' 2>/dev/null)"
else
  CMD=""
fi
[ -z "$CMD" ] && exit 0
# 8회차 B-7: 코멘트 라인 스킵
CMD="$(printf '%s' "$CMD" | awk '!/^[[:space:]]*#/ && !/^[[:space:]]*$/')"
[ -z "$CMD" ] && exit 0

PATTERNS=(
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
  # 5회차 D-2: 4회차 보강을 destructive-guard 본체에 정식 반영
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
  'eval[[:space:]]+.*\$\([[:space:]]*(curl|wget)'
  'ssh[[:space:]]+.*[[:space:]]+rm[[:space:]]+'
  'scp[[:space:]]+.*:[[:space:]]*/'
  'iptables[[:space:]]+-F'
  'ufw[[:space:]]+disable'
  'shutdown[[:space:]]+'
  'reboot[[:space:]]+'
  'halt[[:space:]]+'
  'init[[:space:]]+0'
  'init[[:space:]]+6'
  # 5회차 C/D-2: PATH hijack 패턴
  'export[[:space:]]+PATH[[:space:]]*='
  'PATH[[:space:]]*=[^;:]*[;:][[:space:]]*\$PATH'
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
  # [보안 수정 C2] 인터프리터 경유 파일 삭제 (내부 따옴표에 끊기지 않게 자유 매칭)
  '\bpython[0-9]*[[:space:]]+-c\b.*(shutil\.rmtree|os\.(remove|unlink|rmdir))'
  '\bnode[[:space:]]+(-e|--eval)\b.*(rmSync|unlinkSync|rmdirSync|fs\.rm|fs\.unlink|fs\.rmdir)'
  '\bperl[[:space:]]+-e\b.*(unlink|rmtree|File::Path)'
  '\bruby[[:space:]]+-r?e\b.*(FileUtils\.rm|File\.delete|Dir\.(rmdir|delete))'
  # [보안 수정 C2] 변수 인다이렉션 재귀 삭제 ($X -rf ...). 재귀 플래그(r) 필수.
  '\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]'
  'eval[[:space:]]+["'\''][^"'\'']*\brm\b'
  # [보안 수정 C3] git 훅/앨리어스 하이재킹 (지속 코드실행 백도어)
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
for p in "${PATTERNS[@]}"; do
  if printf '%s' "$CMD" | grep -Eq "$p"; then
    log "BLOCKED pattern=$p"
    echo "BLOCKED: Destructive command detected" 1>&2
    echo "Pattern: $p" 1>&2
    echo "Command: $CMD" 1>&2
    echo "Requires explicit user approval." 1>&2
    exit 2
  fi
done
exit 0
