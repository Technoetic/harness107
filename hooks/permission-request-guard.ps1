# permission-request-guard.ps1 - PermissionRequest hook
# 4회차 신규 — 다른 플러그인의 PermissionRequest hook이 hookSpecificOutput.decision.updatedInput
# 으로 명령을 사후 변조하는 시도를 차단한다.
#
# 출처 (4회차 재검증):
#   https://code.claude.com/docs/en/hooks
#     PermissionRequest hook이
#     {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
#      "decision":{"behavior":"allow|deny","updatedInput":{...}}}}
#     를 emit 하면 사용자 대신 결정을 내릴 수 있다.
#     "When allowing, you can also modify the tool's input or apply permission rules"
#     → 다른 plugin이 PermissionRequest 단계에서 'updatedInput' 으로 명령을 변조 가능.
#
# 본 hook의 역할:
#   - 모든 PermissionRequest 이벤트에서 destructive 패턴을 재검증.
#   - 위험 패턴 감지 시 {"decision":{"behavior":"deny"}} 를 emit 하여 다른 plugin
#     의 "allow + updatedInput" 변조 시도를 무력화.
#   - 매칭되지 않으면 빈 출력 (다른 plugin의 결정이나 사용자 dialog 로 fallback).
#
# 공식 문서가 명시한 동작:
#   - "All matching hooks run in parallel" — 본 hook이 deny 를 emit 해도 다른 plugin
#     의 allow 와 race. 그러나 PermissionRequest 의 exit code 2 는 deny 를 강제하며
#     공식 문서 표에 "exit 2 → Denies the permission" 명시. 따라서 본 hook은
#     deny 시 stdout JSON 외에 exit 2 도 동시에 사용한다 (이중 안전).

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

# Bash 의 명령 검사
function Test-DangerousCommand([string]$cmd) {
  if (-not $cmd) { return $false }
  # 8회차 B-7: 단일 라인이 전부 `#` 코멘트인 경우만 검사 스킵 (false-positive 방지).
  # 여러 줄 입력은 줄 단위로 코멘트가 아닌 라인만 검사한다 (다중 라인 스크립트 내 위험 명령 누락 방지).
  if ($cmd -notmatch "`n") {
    if ($cmd -match '^\s*#') { return $false }
  } else {
    $nonComment = ($cmd -split "`n" | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }) -join "`n"
    if (-not $nonComment) { return $false }
    $cmd = $nonComment
  }
  # 7회차 C 동기화: destructive-guard.ps1 / auto-approve.ps1 와 동일 카탈로그.
  # 신규: $HOME / ${HOME} / $PWD 변수 destructive 매칭 (rm -rf $HOME 등) + PATH hijack 패턴.
  $destructivePatterns = @(
    'rm\s+(-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+)+(/|\.|\*|~|--no-preserve-root|\$HOME|\$\{HOME|\$PWD|\$\{PWD)',
    'rm\s+-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+["'']?\$(\{|PWD|HOME)',
    'rm\s+--recursive', 'rm\s+--force\s+--recursive',
    'find\s+/\s+.*-delete', 'find\s+\S+\s+.*-exec\s+rm',
    'rmdir\s+/s', 'del\s+/f\s+/s',
    'git\s+push\s+--force', 'git\s+push\s+-f\s', 'git\s+reset\s+--hard',
    'git\s+clean\s+-[fdx]', 'git\s+branch\s+-D\s',
    'DROP\s+TABLE', 'DROP\s+DATABASE', 'TRUNCATE\s+TABLE',
    'sudo\s+', 'su\s+-', 'chmod\s+(-[a-zA-Z]+\s+)?0?777',
    'mkfs\.', 'dd\s+.*of=/dev/(sd|nvme|hd)',
    '(curl|wget|fetch)\s+.*\|\s*(sh|bash|zsh)',
    'bash\s+<\(\s*(curl|wget)', 'eval\s+["'']?\$\(\s*(curl|wget)',
    'crontab\s+-[er]', 'systemctl\s+(stop|disable)\s+',
    'shutdown\s+', 'reboot\s+', 'iptables\s+-F', 'ufw\s+disable',
    'ssh\s+.*\s+rm\s+', 'scp\s+.*:\s*/',
    'kubectl\s+delete\s+(ns|namespace|--all)',
    'terraform\s+destroy\s+(-auto-approve|-force)',
    'Remove-Item\s+.*-Recurse.*[A-Za-z]:', 'rd\s+/s\s+/q\s+[A-Za-z]:',
    # 7회차 C: PATH hijack (destructive-guard·auto-approve 와 동기화)
    '(?i)\bexport\s+PATH\s*=',
    '(?i)\bset\s+PATH\s*=',
    '(?i)\$env:PATH\s*=',
    '(?i)PATH\s*=\s*[^;:]*[;:]\s*\$PATH',
    '(?i)PATH\s*=\s*\$PATH\s*[;:]',
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
    '(?i)\bsocat\s+(tcp|exec):'
  )
  foreach ($p in $destructivePatterns) { if ($cmd -match $p) { return $true } }
  return $false
}

# 민감 경로 검사 — 4회차 정규화 + 5회차 8.3 expand
function Test-SensitivePath([string]$path) {
  if (-not $path) { return $false }
  # 정규화: URL-decode -> 8.3 expand -> backslash->slash -> // 축약 -> trailing 제거 -> lowercase
  $norm = $path
  try {
    $norm = [System.Web.HttpUtility]::UrlDecode($norm)
  } catch {
    try { $norm = [System.Uri]::UnescapeDataString($norm) } catch {}
  }
  # 5회차 B: 8.3 short name expand (well-known system paths, 0.04ms 비용 측정 완료)
  if ($norm -match '~\d') {
    try { $norm = [System.IO.Path]::GetFullPath($norm) } catch {}
  }
  $norm = $norm -replace '\\', '/'
  $norm = $norm -replace '/+', '/'
  $norm = $norm -replace '[\. ]+$', ''
  # Windows long-path / UNC prefix 제거
  $norm = $norm -replace '^//\?/', ''
  $norm = $norm -replace '^//', '/'
  $normLower = $norm.ToLowerInvariant()

  # 6회차 B fallback: 8.3 short name이 expand되지 않은 채 남아 있으면 sensitive로 분류.
  if ($normLower -match '(^|/)(progra~\d+|window~\d+|system~\d+|admini~\d+|docume~\d+|mydocu~\d+|users~\d+|appdat~\d+|locals~\d+|alluse~\d+)(/|$)') {
    return $true
  }

  $sensitivePathPatterns = @(
    '\.ssh/(authorized_keys|id_[a-z0-9_]+|known_hosts|config)$',
    '\.ssh/?$',
    '\.gnupg/', '\.aws/(credentials|config)$', '\.azure/',
    '\.config/gcloud/', '\.kube/config$', '\.docker/config\.json$',
    '/(\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.zshenv)$',
    '\.claude/settings\.json$', '\.claude/settings\.local\.json$',
    '^/etc/', '^/var/', '^/boot/',
    '/system32/', '/windows/', '/program files/',
    'harness107/hooks/(destructive-guard|auto-approve|permission-request-guard|step-auto-continue|hooks\.json)',
    'harness107/\.claude-plugin/plugin\.json$'
  )
  foreach ($sp in $sensitivePathPatterns) {
    if ($normLower -match $sp) { return $true }
  }
  return $false
}

$blocked = $false
$reason = ""

if ($toolName -eq "Bash") {
  $cmd = $null
  try { $cmd = $j.tool_input.command } catch {}
  if (Test-DangerousCommand $cmd) {
    $blocked = $true
    $reason = "harness107: PermissionRequest blocked - destructive command pattern (cross-plugin tamper protection)"
  }
}
elseif ($toolName -in @("Write", "Edit", "MultiEdit", "NotebookEdit")) {
  $path = $null
  try { $path = $j.tool_input.file_path } catch {}
  if (-not $path) { try { $path = $j.tool_input.notebook_path } catch {} }
  if (Test-SensitivePath $path) {
    $blocked = $true
    $reason = "harness107: PermissionRequest blocked - sensitive path (cross-plugin tamper protection)"
  }
  # 4회차 D-2/D-3: Edit/MultiEdit 의 old_string/new_string 내 destructive 패턴 추가 검사
  if (-not $blocked -and $toolName -eq "Edit") {
    $ns = $null; try { $ns = $j.tool_input.new_string } catch {}
    if ($ns -and (Test-DangerousCommand $ns)) {
      $blocked = $true
      $reason = "harness107: PermissionRequest blocked - destructive content in new_string"
    }
  }
  if (-not $blocked -and $toolName -eq "MultiEdit") {
    try {
      foreach ($e in $j.tool_input.edits) {
        $ns = $e.new_string
        if ($ns -and (Test-DangerousCommand $ns)) {
          $blocked = $true
          $reason = "harness107: PermissionRequest blocked - destructive content in MultiEdit edit"
          break
        }
      }
    } catch {}
  }
}
elseif ($toolName -eq "WebFetch") {
  $url = $null
  try { $url = $j.tool_input.url } catch {}
  if ($url) {
    $dangerousUrlPatterns = @(
      '^https?://(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)',
      '^https?://(169\.254\.169\.254|metadata\.google\.internal|metadata\.azure\.com)',
      '\.(sh|ps1|bat|cmd|exe|dll|so|dylib|msi)(\?|$)',
      '^file://'
    )
    foreach ($dp in $dangerousUrlPatterns) {
      if ($url -match $dp) {
        $blocked = $true
        $reason = "harness107: PermissionRequest blocked - dangerous URL"
        break
      }
    }
  }
}

if ($blocked) {
  $out = @{
    hookSpecificOutput = @{
      hookEventName = "PermissionRequest"
      decision      = @{
        behavior = "deny"
        reason   = $reason
      }
    }
  } | ConvertTo-Json -Depth 5 -Compress
  [Console]::Out.Write($out)
  # 이중 안전: 공식 문서 명시 "exit 2 → Denies the permission"
  exit 2
}

# 안전: 빈 출력 (다른 plugin 결정 / 사용자 dialog 로 fallback)
exit 0
