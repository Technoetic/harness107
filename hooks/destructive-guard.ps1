# destructive-guard.ps1 - PreToolUse(Bash) hook
# 파괴적 명령 차단 (exit 2 + stderr = 공식 차단 코드)
param()
$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "destructive-guard.log"
function Log($m) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try { Add-Content -Path $logFile -Value "[$ts] $m" -Encoding UTF8 } catch {}
}

$j = $null
try {
  $r = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $raw = $r.ReadToEnd(); $r.Close()
  if ($raw) { $j = $raw | ConvertFrom-Json }
} catch { Log "stdin: $_"; exit 0 }
if ($null -eq $j) { exit 0 }

$command = $null
try { $command = $j.tool_input.command } catch {}
if (-not $command) { exit 0 }
# 8회차 B-7: 코멘트 라인 스킵
if ($command -notmatch "`n") {
  if ($command -match '^\s*#') { exit 0 }
} else {
  $command = ($command -split "`n" | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }) -join "`n"
  if (-not $command) { exit 0 }
}

$patterns = @(
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
  # 5회차 D-2: 4회차 보강을 destructive-guard 본체에 정식 반영 (race-safe 1차 방어선 강화)
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
  # 5회차 C/D-2: PATH hijack 패턴 (auto-approve와 destructive-guard 동기화)
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
foreach ($p in $patterns) {
  if ($command -match $p) {
    Log "BLOCKED pattern=$p"
    [Console]::Error.WriteLine("BLOCKED: Destructive command detected")
    [Console]::Error.WriteLine("Pattern: $p")
    [Console]::Error.WriteLine("Command: $command")
    [Console]::Error.WriteLine("Requires explicit user approval.")
    exit 2
  }
}
exit 0
