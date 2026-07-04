# auto-approve.ps1 - PreToolUse hook
# harness107 자율주행을 위한 자동 권한 승인.
# --dangerously-skip-permissions 와 동등 효과를 hook 차원에서 구현한다.
#
# 출처 (재검증 2회차):
#   https://code.claude.com/docs/en/hooks
#     PreToolUse hook이
#     {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#      "permissionDecision":"allow","permissionDecisionReason":"..."}}
#     를 stdout에 내보내면 권한 팝업이 스킵된다.
#   https://code.claude.com/docs/en/permissions
#     "A blocking hook also takes precedence over allow rules. A hook that
#      exits with code 2 stops the tool call before permission rules are
#      evaluated." -> destructive-guard exit 2가 우선한다.
#   같은 문서:
#     "All matching hooks run in parallel" (hooks 문서) -> destructive-guard
#     와 auto-approve가 병렬 실행되므로 *race condition* 위험이 있다.
#     따라서 auto-approve가 자체적으로 destructive 패턴을 재검증한다
#     (defense-in-depth).
#
# 2회차 변경:
#   - destructive-guard.ps1 의 패턴 50+개를 인라인 복제하여 race 차단
#   - 위험 명령이 감지되면 approve JSON을 *내보내지 않고* exit 0
#     (그러면 사용자 권한 팝업이 정상적으로 뜬다; destructive-guard 가 병렬로
#      exit 2 라면 그 결정이 최종)

param()
$ErrorActionPreference = "Continue"

$j = $null
try {
  $r = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $raw = $r.ReadToEnd()
  $r.Close()
  if ($raw) { $j = $raw | ConvertFrom-Json }
} catch {}

$toolName = "unknown"
try { if ($j -and $j.tool_name) { $toolName = $j.tool_name } } catch {}

# 자율주행 대상 도구 화이트리스트.
$autoApproveTools = @("Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch")
if ($autoApproveTools -notcontains $toolName) { exit 0 }

# [보안 수정 — 하네스 활성 게이트] auto-approve는 오직 harness107 자율주행이
# 실제 가동 중일 때만 발화한다. progress.json이 없으면(= /webapp 미트리거,
# 무관한 일반 세션) 자동승인을 절대 발급하지 않고 정상 권한 흐름으로 떨어뜨린다.
# 이 게이트가 없으면 플러그인 설치만으로 모든 세션이 상시 --dangerously-skip-permissions
# 상태가 되는 전역 자동승인 결함이 발생한다 (README:215 "그 외엔 silent skip" 계약 준수).
$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }
$progressFile = Join-Path $projectRoot "step_archive/progress.json"
if (-not (Test-Path $progressFile)) { exit 0 }

# 4회차 정규화 헬퍼 + 5회차 8.3 short name expand:
#   URL-decode -> 8.3 expand (System.IO.Path.GetFullPath; well-known short names만 expand,
#   비용 0.04ms 측정) -> backslash->slash -> // 축약 -> trailing dot/space 제거
#   -> long-path/UNC 정리 -> lowercase
function Get-NormalizedPath([string]$p) {
  if (-not $p) { return "" }
  $n = $p
  try { $n = [System.Uri]::UnescapeDataString($n) } catch {}
  # 5회차 B: 8.3 short name expand. PROGRA~1 / PROGRA~2 / WINDOW~1 등 시스템 well-known
  # short name은 GetFullPath가 long form으로 변환한다 (실파일 존재 무관).
  # 사용자 디렉토리 short name (ADMINI~1 등)은 실파일 lookup이 필요해 미변환 가능.
  if ($n -match '~\d') {
    try { $n = [System.IO.Path]::GetFullPath($n) } catch {}
  }
  $n = $n -replace '\\', '/'
  $n = $n -replace '/+', '/'
  $n = $n -replace '[\. ]+$', ''
  $n = $n -replace '^//\?/', ''
  $n = $n -replace '^//', '/'
  return $n.ToLowerInvariant()
}

# 4회차 정규화된 민감 경로 패턴 (모두 slash 형식, lowercase 기준 매칭)
$sensitivePathPatternsNorm = @(
  '\.ssh/(authorized_keys|id_[a-z0-9_]+|known_hosts|config)$',
  '\.ssh/?$',
  '\.gnupg/',
  '\.aws/(credentials|config)$',
  '\.azure/',
  '\.config/gcloud/',
  '\.kube/config$',
  '\.docker/config\.json$',
  '/(\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.zshenv)$',
  '\.claude/settings\.json$',
  '\.claude/settings\.local\.json$',
  '^/etc/',
  '^/var/',
  '^/boot/',
  '/system32/',
  '/windows/',
  '/program files/',
  'harness107/hooks/(destructive-guard|auto-approve|permission-request-guard|step-auto-continue|hooks\.json)',
  'harness107/\.claude-plugin/plugin\.json$'
)

function Test-SensitivePath([string]$p) {
  $norm = Get-NormalizedPath $p
  if (-not $norm) { return $false }
  # 6회차 B fallback: 8.3 short name이 normalize에서 expand되지 않은 채 남아 있으면
  # well-known short token을 sensitive로 분류 (사용자 디렉토리 short name 우회 차단).
  if ($norm -match '(^|/)(progra~\d+|window~\d+|system~\d+|admini~\d+|docume~\d+|mydocu~\d+|users~\d+|appdat~\d+|locals~\d+|alluse~\d+)(/|$)') {
    return $true
  }
  foreach ($sp in $sensitivePathPatternsNorm) {
    if ($norm -match $sp) { return $true }
  }
  return $false
}

# 3회차 추가 + 4회차 보강: Write/Edit/MultiEdit/NotebookEdit 의 민감 경로 + 자기 hook 파일 보호.
if ($toolName -in @("Write", "Edit", "MultiEdit", "NotebookEdit")) {
  $path = $null
  try { $path = $j.tool_input.file_path } catch {}
  if (-not $path) {
    try { $path = $j.tool_input.notebook_path } catch {}
  }
  if (Test-SensitivePath $path) {
    # 민감 경로: approve 안 함 (사용자 권한 팝업으로 떨어뜨림)
    exit 0
  }
}

# 3회차 추가: WebFetch 의 위험 도메인 사전 검사.
if ($toolName -eq "WebFetch") {
  $url = $null
  try { $url = $j.tool_input.url } catch {}
  if ($url) {
    $dangerousUrlPatterns = @(
      # localhost / private network (SSRF)
      '^https?://(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)',
      '^https?://\[?(::1|fc00:|fd00:|fe80:)',
      # metadata services
      '^https?://(169\.254\.169\.254|metadata\.google\.internal|metadata\.azure\.com)',
      # raw remote executable payloads
      '\.(sh|ps1|bat|cmd|exe|dll|so|dylib|msi)(\?|$)',
      # file: scheme
      '^file://'
    )
    foreach ($dp in $dangerousUrlPatterns) {
      if ($url -match $dp) { exit 0 }
    }
  }
}

# 4회차 D-2/D-3: Edit / MultiEdit 의 new_string 내 destructive 패턴 사전 검사.
# (file_path 가 안전해도 new_string 으로 악성 명령이 파일에 박힐 수 있음)
function Test-DangerousString([string]$s) {
  if (-not $s) { return $false }
  # 7회차 C 동기화 + 8회차 A 보강: 패키지매니저 install / 계정·권한 / 리버스 쉘 카테고리.
  $danger = @(
    'rm\s+(-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+)+(/|\.|\*|~|--no-preserve-root|\$HOME|\$\{HOME|\$PWD|\$\{PWD)',
    'rm\s+--recursive', 'rm\s+--force\s+--recursive',
    'find\s+/\s+.*-delete', 'find\s+\S+\s+.*-exec\s+rm',
    'sudo\s+', 'su\s+-', 'chmod\s+(-[a-zA-Z]+\s+)?0?777',
    'mkfs\.', 'dd\s+.*of=/dev/(sd|nvme|hd)',
    '(curl|wget|fetch)\s+.*\|\s*(sh|bash|zsh)',
    'bash\s+<\(\s*(curl|wget)',
    'eval\s+["'']?\$\(\s*(curl|wget)',
    ':\(\)\s*\{.*\|.*&',
    '(?i)\bexport\s+PATH\s*=',
    '(?i)\bset\s+PATH\s*=',
    '(?i)\$env:PATH\s*=',
    '(?i)PATH\s*=\s*[^;:]*[;:]\s*\$PATH',
    '(?i)PATH\s*=\s*\$PATH\s*[;:]',
    'crontab\s+-[er]', 'shutdown\s+', 'reboot\s+',
    'DROP\s+TABLE', 'DROP\s+DATABASE', 'TRUNCATE\s+TABLE',
    'git\s+push\s+--force', 'git\s+push\s+-f\s', 'git\s+reset\s+--hard',
    'git\s+clean\s+-[fdx]', 'git\s+branch\s+-D\s',
    # 8회차 A 신규: 패키지매니저 install
    '(?i)\b(apt|apt-get|yum|dnf|brew|pacman|pip|pip3|gem|cargo|conda|zypper|emerge|opkg|apk|snap|flatpak)\b\s+(install|-S\b|-i\b|add\b)',
    '(?i)\bnpm\s+install\s+(-g|--global)\b',
    # 8회차 A 신규: 계정/권한 변경
    '(?i)\b(useradd|adduser|userdel|deluser|groupadd|groupdel|usermod|groupmod|chsh|passwd|gpasswd)\b',
    '(?i)\bchown\s+(root|0)\b',
    '(?i)\bsetcap\b', '(?i)\bvisudo\b', '/etc/sudoers',
    # 8회차 A 신규: 리버스 쉘
    '(?i)\bnc(at)?\s+(-l[vnpuk]*|--listen)\b',
    '(?i)\bbash\s+-i\s*>&?\s*/dev/tcp/',
    '(?i)/dev/tcp/[0-9a-fA-F\.:]+/[0-9]+',
    '(?i)\bpython\d*\s+-c\s+["''][^"'']*\b(socket|subprocess|pty)\b',
    '(?i)\bperl\s+-e\s+["''][^"'']*\bsocket\b',
    '(?i)\bruby\s+-r?e\s+["''][^"'']*\bTCPSocket\b',
    '(?i)\bphp\s+-r\s+["''][^"'']*\bfsockopen\b',
    '(?i)\bsocat\s+(tcp|exec):'
  )
  foreach ($d in $danger) { if ($s -match $d) { return $true } }
  return $false
}

if ($toolName -eq "Edit") {
  $ns = $null
  try { $ns = $j.tool_input.new_string } catch {}
  if (Test-DangerousString $ns) { exit 0 }
}
if ($toolName -eq "MultiEdit") {
  try {
    foreach ($e in $j.tool_input.edits) {
      if (Test-DangerousString $e.new_string) { exit 0 }
    }
  } catch {}
}

# 4회차 B: Bash PATH hijack 방어.
# plugin 의 bin/ 디렉토리는 자동으로 PATH 앞에 추가되므로, 다른 플러그인이 bin/rm,
# bin/sudo 등으로 시스템 바이너리를 shadow 가능 (공식 plugins-reference 인용).
# 명령에 `export PATH=...` 또는 PATH 변조가 들어 있으면 approve 안 함.
if ($toolName -eq "Bash") {
  $command = $null
  try { $command = $j.tool_input.command } catch {}
  # 8회차 B-7: 코멘트 라인 스킵 동일 적용
  if ($command) {
    if ($command -notmatch "`n") {
      if ($command -match '^\s*#') { $command = $null }
    } else {
      $command = ($command -split "`n" | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }) -join "`n"
      if (-not $command) { $command = $null }
    }
  }
  if ($command) {
    $pathHijackPatterns = @(
      '(?i)\bexport\s+PATH\s*=',
      '(?i)\bset\s+PATH\s*=',
      '(?i)\$env:PATH\s*=',
      '(?i)\$env:Path\s*=',
      '(?i)PATH\s*=\s*[^;:]*[;:]\s*\$PATH',  # PATH=/foo:$PATH
      '(?i)PATH\s*=\s*\$PATH\s*[;:]'
    )
    foreach ($pp in $pathHijackPatterns) {
      if ($command -match $pp) { exit 0 }
    }
  }
}

# Bash 도구일 때만 명령 안전성 재검증 (race-safe).
if ($toolName -eq "Bash") {
  $command = $null
  try { $command = $j.tool_input.command } catch {}
  # 8회차 B-7: 단일 라인 `#` 코멘트인 경우 패턴 검사 스킵 (코멘트 안의 sudo 단어 false-positive 방지).
  # 다중 라인이면 코멘트 라인만 제거 후 검사 (스크립트 내 위험 명령 누락 방지).
  if ($command) {
    if ($command -notmatch "`n") {
      if ($command -match '^\s*#') { $command = $null }
    } else {
      $command = ($command -split "`n" | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }) -join "`n"
      if (-not $command) { $command = $null }
    }
  }
  if ($command) {
    $destructivePatterns = @(
      'rm\s+(-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+)+(/|\.|\*|~|--no-preserve-root)',
      'rm\s+(-[rR]\s+-[fF]|-[fF]\s+-[rR])\s+',
      'rm\s+--recursive\s+',
      'rm\s+--force\s+--recursive',
      'find\s+/\s+.*-delete',
      'find\s+\S+\s+.*-exec\s+rm',
      'rmdir\s+/s',
      'del\s+/f\s+/s',
      'git\s+push\s+--force(?!\s)',
      'git\s+push\s+--force\s',
      'git\s+push\s+--force-with-lease',
      'git\s+push\s+-f\s',
      'git\s+push\s+\S+\s+\+',
      'git\s+reset\s+--hard',
      'git\s+clean\s+-[fdx]',
      'git\s+checkout\s+\.',
      'git\s+restore\s+\.',
      'git\s+branch\s+-D\s',
      'DROP\s+TABLE','DROP\s+DATABASE','DROP\s+SCHEMA','TRUNCATE\s+TABLE',
      'npm\s+publish','npx\s+-y\s',
      'chmod\s+(-[a-zA-Z]+\s+)?0?777','chmod\s+(-[a-zA-Z]+\s+)?a\+rwx',
      'mkfs\.',
      ':\(\)\s*\{.*\|.*&',
      'dd\s+.*of=/dev/(sd|nvme|hd)',
      '>\s*/dev/(sd|nvme|hd)',
      'Remove-Item\s+.*-Recurse.*[A-Za-z]:\\?(\s|$|"|'')',
      'Remove-Item\s+.*[A-Za-z]:\\?(\s|"|'').*-Recurse',
      'Remove-Item\s+.*-Recurse.*[\\/](Users|Windows|Program|System|etc|var|home|root)',
      'rd\s+/s\s+/q\s+[A-Za-z]:',
      'Format-Volume',
      'rm\s+-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+["'']?\$\(',
      'rm\s+-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+["'']?\$(\{|PWD|HOME)',
      'rm\s+-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+`',
      '(curl|wget|fetch)\s+.*\|\s*(sh|bash|zsh)\b',
      'echo\s+.*\|\s*(sh|bash|zsh)\b',
      'gh\s+(auth\s+token|secret\s+set).*\|',
      'aws\s+(s3\s+rb|iam\s+delete-user|ec2\s+terminate-instances)',
      'docker\s+(rmi\s+-f|volume\s+rm\s+-f|system\s+prune\s+-af)',
      'kubectl\s+delete\s+(ns|namespace|node|pv|pvc|--all)',
      'terraform\s+destroy\s+(-auto-approve|-force)',
      '(ngrok|cloudflared)\s+http\s+(0\.0\.0\.0|\*)',
      'echo\s+["''](AKIA|ghp_|sk-|xoxb-)',
      # 2회차 추가 보강 (auto mode classifier 차단 패턴 참고):
      'sudo\s+',
      'su\s+-',
      'crontab\s+-[er]',
      'systemctl\s+(stop|disable)\s+',
      'launchctl\s+(unload|remove)\s+',
      'pip\s+install\s+.*--index-url\s+',
      'npm\s+install\s+.*--registry\s+',
      'curl\s+.*\|\s*python',
      'wget\s+.*\|\s*python',
      'bash\s+<\(\s*curl',
      'bash\s+<\(\s*wget',
      'eval\s+["'']?\$\(\s*(curl|wget)',
      'ssh\s+.*\s+rm\s+',
      'scp\s+.*:\s*/',
      'iptables\s+-F',
      'ufw\s+disable',
      'shutdown\s+',
      'reboot\s+',
      'halt\s+',
      'init\s+0',
      'init\s+6',
      # 8회차 A 신규: 패키지매니저 install
      '(?i)\b(apt|apt-get|yum|dnf|brew|pacman|pip|pip3|gem|cargo|conda|zypper|emerge|opkg|apk|snap|flatpak)\b\s+(install|-S\b|-i\b|add\b)',
      '(?i)\bnpm\s+install\s+(-g|--global)\b',
      # 8회차 A 신규: 계정/권한 변경
      '(?i)\b(useradd|adduser|userdel|deluser|groupadd|groupdel|usermod|groupmod|chsh|passwd|gpasswd)\b',
      '(?i)\bchown\s+(root|0)\b',
      '(?i)\bsetcap\b','(?i)\bvisudo\b','/etc/sudoers',
      # 8회차 A 신규: 리버스 쉘
      '(?i)\bnc(at)?\s+(-l[vnpuk]*|--listen)\b',
      '(?i)\bbash\s+-i\s*>&?\s*/dev/tcp/',
      '(?i)/dev/tcp/[0-9a-fA-F\.:]+/[0-9]+',
      '(?i)\bpython\d*\s+-c\s+["''][^"'']*\b(socket|subprocess|pty)\b',
      '(?i)\bperl\s+-e\s+["''][^"'']*\bsocket\b',
      '(?i)\bruby\s+-r?e\s+["''][^"'']*\bTCPSocket\b',
      '(?i)\bphp\s+-r\s+["''][^"'']*\bfsockopen\b',
      '(?i)\bsocat\s+(tcp|exec):',
      # [보안 수정 C2] 인터프리터 경유 파일 삭제 (내부 따옴표에 끊기지 않게 자유 매칭)
      '(?i)\bpython\d*\s+-c\b.*(shutil\.rmtree|os\.(remove|unlink|rmdir))',
      '(?i)\bnode\s+(-e|--eval)\b.*(rmSync|unlinkSync|rmdirSync|fs\.rm\b|fs\.unlink|fs\.rmdir)',
      '(?i)\bperl\s+-e\b.*(unlink|rmtree|File::Path)',
      '(?i)\bruby\s+-r?e\b.*(FileUtils\.rm|File\.delete|Dir\.(rmdir|delete))',
      # [보안 수정 C2] 변수 인다이렉션 재귀 삭제 ($X -rf ...). 재귀 플래그(r) 필수.
      '\$\{?[A-Za-z_]\w*\}?\s+-[a-zA-Z]*[rR][a-zA-Z]*\s',
      '(?i)\beval\s+["''][^"'']*\brm\b',
      # [보안 수정 C3] git 훅/앨리어스 하이재킹 (지속 코드실행 백도어)
      '(?i)\bgit\s+config\s+.*\bcore\.hooksPath\b',
      '(?i)\bgit\s+config\s+.*\balias\.',
      '(?i)\.git[\\/]hooks[\\/]',
      # [보안 수정 C3] 2단계 다운로드 후 실행 (curl -o x && sh x)
      '(?i)(curl|wget)\s+[^|]*-[oO]\s+\S+.*(&&|;|\|\|).*(\b(sh|bash|zsh|source)\b|\.\/|python|node|perl)',
      '(?i)\bchmod\s+\+x\s+\S+.*(&&|;).*(\.\/|\bbash\b|\bsh\b)',
      # [보안 수정 H7] 자격증명/비밀키 읽기·유출
      '(?i)\b(cat|less|more|head|tail|cp|mv|tar|zip|base64|xxd|od|strings)\b[^|;&]*(\.ssh[\\/]|\.aws[\\/]|\.gnupg[\\/]|\.kube[\\/]config|id_rsa|id_ed25519|id_ecdsa|credentials\b|\.env\b|\.npmrc\b|\.pypirc\b)',
      '(?i)\bcurl\s+[^|]*(-T\s|--upload-file|--data-binary\s+@|-d\s+@|-F\s+\S*=@)',
      '(?i)(id_rsa|id_ed25519|credentials|\.env)\b[^|]*\|\s*(curl|wget|nc|ncat)\b'
    )
    foreach ($p in $destructivePatterns) {
      if ($command -match $p) {
        # 위험 명령: approve 하지 않음 (정상 권한 흐름으로 떨어뜨림).
        # destructive-guard 가 병렬로 exit 2 를 내면 그쪽이 최종 결정.
        exit 0
      }
    }
  }
}

# 안전 판정 -> Auto-approve JSON 출력.
$out = @{
  hookSpecificOutput = @{
    hookEventName            = "PreToolUse"
    permissionDecision       = "allow"
    permissionDecisionReason = "harness107 autopilot mode: $toolName auto-approved (race-safe pattern check passed)"
  }
} | ConvertTo-Json -Depth 5 -Compress

[Console]::Out.Write($out)
exit 0
