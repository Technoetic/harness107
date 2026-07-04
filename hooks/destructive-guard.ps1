# destructive-guard.ps1 - 파괴적 명령 차단
# PreToolUse(Bash) 훅: rm -rf, git push --force, DROP TABLE 등 위험 명령 차단
param()

# B-P2-10 fix (revised): stdin parse 실패는 fail-open.
# 정상 호출 흐름에서도 stdin이 비거나 형식이 다를 수 있어 fail-closed는 가용성을 깨뜨린다.
# 진짜 방어선은 패턴 보강(B-P2-13/14)에 있다.
$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "destructive-guard.log"
function Write-GuardLog($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8 } catch {}
}

# stdin에서 이벤트 JSON 읽기 (UTF-8 명시)
$inputJson = $null
try {
    $stdinStream = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
    $raw = $stdinStream.ReadToEnd()
    $stdinStream.Close()
    if ($raw) { $inputJson = $raw | ConvertFrom-Json }
} catch {
    Write-GuardLog "stdin parse FAILED (fail-open): $_"
    exit 0
}

if ($null -eq $inputJson) { exit 0 }

$command = $null
try { $command = $inputJson.tool_input.command } catch {}
if (-not $command) { exit 0 }

# rm 재귀 플래그 공통 프리픽스 — 플래그 묶음/분리(-rf, -fr, -f -r) 모두 커버,
# 재귀 플래그([rR]) 실존을 요구 (단독 -f는 비재귀라 비차단)
$rmRec = 'rm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*(?:\s+-[a-zA-Z]+)*\s+'

# 파괴적 패턴 목록 (B-P2-13/14 fix: 공백 분리/별칭/우회 케이스 포함)
# 2026-06-10 GATE-03 fix: 구버전 'rm -rf (/|.|*|~)' prefix 매칭은 /tmp/..., .lighthouseci 등
# 합법 경로까지 오차단 — 위험 타깃을 전체 토큰으로 anchoring하여 정밀화.
$destructivePatterns = @(
    # rm -rf <위험 타깃>: 루트/시스템 디렉토리, 홈, CWD(./..), 와일드카드 단독, 드라이브 루트
    ($rmRec + '["'']?/\s*["'']?\s*(?:$|[;&|])'),                       # rm -rf /  (끝 또는 구분자 앞)
    ($rmRec + '["'']?/\*'),                                            # rm -rf /*
    ($rmRec + '["'']?/(home|etc|var|usr|bin|sbin|boot|root|opt|srv|lib|lib64|sys|proc|dev)\b'),
    ($rmRec + '["'']?~'),                                              # rm -rf ~ / ~/...
    ($rmRec + '["'']?\$\{?(HOME|USERPROFILE)\}?["'']?\s*(?:$|[;&|/]\s*\*?)'),
    ($rmRec + '["'']?\.{1,2}/?["'']?\s*(?:$|[;&|])'),                  # rm -rf . / .. (CWD 삭제)
    ($rmRec + '["'']?\*["'']?\s*(?:$|[;&|])'),                         # rm -rf * 단독
    ($rmRec + '["'']?[A-Za-z]:[\\/]*["'']?\s*(?:$|[;&|])'),            # rm -rf C:\ 드라이브 루트
    'rm\s+.*--no-preserve-root',
    'rm\s+--recursive\s+--force\s+', 'rm\s+--force\s+--recursive\s+',
    # find -delete / -exec rm
    'find\s+/\s+.*-delete',
    'find\s+\S+\s+.*-exec\s+rm',
    'rmdir\s+/s',
    'del\s+/f\s+/s',
    # git: --force-with-lease, +ref, FETCH_HEAD reset 등 우회 포함
    'git\s+push\s+--force(?!\s)',  # --force 단독
    'git\s+push\s+--force\s',
    'git\s+push\s+--force-with-lease',
    'git\s+push\s+-f\s',
    'git\s+push\s+\S+\s+\+',  # refspec + 강제 푸시
    'git\s+reset\s+--hard',
    'git\s+clean\s+-[fdx]',
    'git\s+checkout\s+\.',
    'git\s+restore\s+\.',
    'git\s+branch\s+(?-i:-D)\s',  # 대문자 -D만 (PS -match는 기본 대소문자 무시 — 안전한 -d 오차단 방지)
    # SQL
    'DROP\s+TABLE',
    'DROP\s+DATABASE',
    'DROP\s+SCHEMA',
    'TRUNCATE\s+TABLE',
    # 패키지 배포/위험 (2026-06-10: 'npx -y' 패턴 제거 — 패키지 자동 설치 자체는 비파괴적이며
    # tsc/lint/lhci 등 정상 Step을 다수 오차단했음, 로그 실증)
    'npm\s+publish',
    # chmod: 0777, 777, a+rwx 등
    'chmod\s+0?777',
    'chmod\s+a\+rwx',
    # 파일시스템 파괴
    'mkfs\.',
    ':\(\)\s*\{.*\|.*&',  # fork bomb
    'dd\s+.*of=/dev/(sd|nvme|hd)',
    '>\s*/dev/(sd|nvme|hd)',
    # PowerShell 위험 — 시스템 경로 + Recurse 동시 만족 시만 차단 (false positive 방지)
    'Remove-Item\s+.*-Recurse.*[A-Za-z]:\\?(\s|$|"|'')',
    'Remove-Item\s+.*[A-Za-z]:\\?(\s|"|'').*-Recurse',
    'Remove-Item\s+.*-Recurse.*[\\/](Users|Windows|Program|System|etc|var|home|root)',
    'rd\s+/s\s+/q\s+[A-Za-z]:',          # cmd legacy with drive
    'Format-Volume',
    # subshell/명령치환 안에서 rm
    'rm\s+-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+["'']?\$\(',
    'rm\s+-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+["'']?\$(\{|PWD|HOME)',
    'rm\s+-[a-zA-Z]*[rfRF]+[a-zA-Z]*\s+`',  # backtick command substitution
    # pipe-to-shell (curl/wget | sh|bash)
    '(curl|wget|fetch)\s+.*\|\s*(sh|bash|zsh)\b',
    'echo\s+.*\|\s*(sh|bash|zsh)\b',
    # MoAI-ADK 벤치마킹: 보안 패턴 보강
    'gh\s+(auth\s+token|secret\s+set).*\|',           # GitHub 토큰 누출 위험 파이프
    'aws\s+(s3\s+rb|iam\s+delete-user|ec2\s+terminate-instances)',  # AWS 파괴 명령
    'docker\s+(rmi\s+-f|volume\s+rm\s+-f|system\s+prune\s+-af)',     # Docker 강제 제거
    'kubectl\s+delete\s+(ns|namespace|node|pv|pvc|--all)',            # K8s 광범위 삭제
    'terraform\s+destroy\s+(-auto-approve|-force)',                   # Terraform 자동 파괴
    '(ngrok|cloudflared)\s+http\s+(0\.0\.0\.0|\*)',                   # 외부 노출 터널
    'echo\s+["''](AKIA|ghp_|sk-|xoxb-)',                             # 시크릿 패턴 echo
    # [보안 수정 C2] 인터프리터 경유 파일 삭제 (리터럴 rm 우회 차단).
    # 페이로드 내부 따옴표에 끊기지 않도록 -c/-e 이후를 자유 매칭한다.
    '(?i)python\d*\s+-c\b.*(shutil\.rmtree|os\.(remove|unlink|rmdir))',
    '(?i)node\s+(-e|--eval)\b.*(rmSync|unlinkSync|rmdirSync|fs\.rm\b|fs\.unlink|fs\.rmdir)',
    '(?i)perl\s+-e\b.*(unlink|rmtree|File::Path)',
    '(?i)ruby\s+-r?e\b.*(FileUtils\.rm|File\.delete|Dir\.(rmdir|delete))',
    # [보안 수정 C2] 변수 인다이렉션 재귀 삭제 ($X -rf ...). 재귀 플래그(r) 필수로
    # 좁혀 비재귀 -f (예: tar $ARGS -f) 오탐을 배제한다.
    '\$\{?[A-Za-z_]\w*\}?\s+-[a-zA-Z]*[rR][a-zA-Z]*\s',
    '(?i)eval\s+["''][^"'']*\brm\b',
    # [보안 수정 C3] git 훅/앨리어스 하이재킹 (지속 코드실행 백도어)
    '(?i)git\s+config\s+.*core\.hooksPath',
    '(?i)git\s+config\s+.*alias\.',
    '(?i)\.git[\\/]hooks[\\/]',
    # [보안 수정 C3] 2단계 다운로드 후 실행
    '(?i)(curl|wget)\s+[^|]*-[oO]\s+\S+.*(&&|;|\|\|).*(\b(sh|bash|zsh|source)\b|\.\/|python|node|perl)',
    '(?i)chmod\s+\+x\s+\S+.*(&&|;).*(\.\/|\bbash\b|\bsh\b)',
    # [보안 수정 H7] 자격증명/비밀키 읽기·유출
    '(?i)\b(cat|less|more|head|tail|cp|mv|tar|zip|base64|xxd|od|strings)\b[^|;&]*(\.ssh[\\/]|\.aws[\\/]|\.gnupg[\\/]|\.kube[\\/]config|id_rsa|id_ed25519|id_ecdsa|credentials\b|\.env\b|\.npmrc\b|\.pypirc\b)',
    '(?i)curl\s+[^|]*(-T\s|--upload-file|--data-binary\s+@|-d\s+@|-F\s+\S*=@)',
    '(?i)(id_rsa|id_ed25519|credentials|\.env)\b[^|]*\|\s*(curl|wget|nc|ncat)\b'
)

foreach ($pattern in $destructivePatterns) {
    if ($command -match $pattern) {
        Write-GuardLog "BLOCKED pattern=$pattern command=$command"
        # PreToolUse 차단 정식 코드: exit 2 + stderr
        [Console]::Error.WriteLine("BLOCKED: Destructive command detected")
        [Console]::Error.WriteLine("Pattern: $pattern")
        [Console]::Error.WriteLine("Command: $command")
        [Console]::Error.WriteLine("This command requires explicit user approval.")
        exit 2
    }
}

# GATE-06 (2026-06-10): 임의 변수 타깃 재귀 rm은 차단 대신 사용자 확인(ask) —
# 변수가 루트로 해석될 수 있으나 합법 정리 작업일 수도 있어 인적 게이트로 위임.
# ($(, ${, $PWD, $HOME, 백틱 치환은 위 deny 패턴이 이미 차단)
if ($command -match ($rmRec + '["'']?\$[A-Za-z_]')) {
    Write-GuardLog "ASK variable-target rm: $command"
    $jsonOut = @{
        hookSpecificOutput = @{
            hookEventName            = "PreToolUse"
            permissionDecision       = "ask"
            permissionDecisionReason = "재귀 rm의 타깃이 변수입니다 — 해석 결과에 따라 파괴적일 수 있어 사용자 확인이 필요합니다: $command"
        }
    } | ConvertTo-Json -Compress -Depth 4
    [Console]::Out.WriteLine($jsonOut)
    exit 0
}

exit 0
