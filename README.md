# harness107

> 웹앱 인터랙티브 튜토리얼을 만들고 싶다고 한 줄만 던지면, step001 ~ step107 결정론적 하네스가 자동으로 끝까지 돌아가 단일 HTML 산출물을 만들어내는 Claude Code 플러그인.

**플랫폼**: Windows (PowerShell) + macOS / Linux (bash + python3) 동시 지원
**모델**: 메인은 임의, 서브에이전트는 step-executor가 자동으로 haiku 고정 (평가 게이트만 sonnet)

---

## 한 줄로

```text
/webapp 다익스트라 알고리즘
```

이걸 치면 멈추지 않는다. 컨텍스트 한계 직전까지 step을 자동 진행하고, Stop hook이 미완료 step을 발견하면 다음 턴을 자동으로 재개한다. step107까지 끝나야 비로소 사용자에게 돌아온다.

자연어로도 됩니다:

- "다익스트라 최단경로 튜토리얼을 만들어"
- "OAuth 2.0 인증 흐름을 인터랙티브로 생성"
- 또는 기존 7줄 템플릿 그대로:

```text
순시부호

"순시부호" 튜토리얼을 생성한다.
인터랙티브는 필수다.
웹으로,
초보자 학습용으로,
대중 앱 사례를 참고,
직관적으로 이해할 수 있게
생성한다.

@step_archive/archived/step001.md 절대 복종한다.
```

위 셋 모두 `UserPromptSubmit` hook의 `webapp-trigger`가 트리거 패턴으로 매칭하여 자동 부트스트랩에 들어갑니다.

---

## 무엇이 들어 있나

```
harness107/
├── .claude-plugin/plugin.json
├── commands/
│   ├── webapp.md           # /webapp <주제> — 자율주행 진입
│   ├── harness-status.md   # /harness-status — 1줄 진행 보고
│   └── harness-reset.md    # /harness-reset — progress.json 리셋
├── skills/
│   ├── harness-rules/      # 헌법 (질문 금지·자연 종료 금지·AI Slop 방지·@MX 의무)
│   ├── chunk-writer/       # 500줄 이하 청크 분할 저장
│   ├── evaluator/          # 생성자-평가자 분리 (sonnet 4축 평가)
│   └── debug-step/         # c8 + 서브에이전트 병렬 디버깅
├── agents/
│   └── step-executor.md    # 단일 step 실행 워커 (haiku)
├── hooks/
│   ├── hooks.json          # 5개 hook 이벤트 바인딩 (ps1 + sh 듀얼)
│   ├── webapp-trigger.{ps1,sh}        # 트리거 감지 + 부트스트랩
│   ├── step-obedience-guard.{ps1,sh}  # 매 prompt마다 다음 step 강제
│   ├── step-auto-continue.{ps1,sh}    # Stop 시 미완료면 block (decision:"block")
│   ├── step-progress-loader.{ps1,sh}  # SessionStart 로드
│   ├── step-progress-writer.{ps1,sh}  # transcript 스캔 → progress.json 갱신
│   ├── destructive-guard.{ps1,sh}     # rm -rf / git reset --hard 차단
│   ├── mx-tag-validator.{ps1,sh}      # @MX 4종 검증
│   ├── lsp-autofix.{ps1,sh}           # Biome / Stylelint 자동수정
│   ├── spec-generator.{ps1,sh}        # SPEC-NNN.md 자동 생성
│   ├── trust5-validator.{ps1,sh}      # r1(49) / r2(69) / r3(104) Trust5 게이트
│   └── validate-tools.{ps1,sh}        # 도구 검증 wrapper
└── assets/steps/
    └── step001.md ~ step107.md        # 107개 결정론적 절차
```

---

## 어떻게 작동하나 (5개 hook 이벤트)

| 이벤트 | 실행 hook | 역할 |
|:---|:---|:---|
| **UserPromptSubmit** | webapp-trigger → step-obedience-guard | 트리거 감지 시 step_archive/ 부트스트랩 + TOPIC.md 작성 + progress.json 초기화. 그 외엔 다음 step 즉시 실행 강제. |
| **SessionStart** | step-progress-loader | 새 세션 진입 시 progress.json 로드, 마이그레이션, 다음 step 지시 주입 |
| **PreToolUse(Bash)** | destructive-guard | rm -rf, git push --force, DROP TABLE 등 차단 (exit 2) |
| **PostToolUse(Write\|Edit)** | mx-tag-validator → lsp-autofix | @MX 태그 검증, Biome / Stylelint 자동수정 |
| **Stop** | step-progress-writer → spec-generator → trust5-validator → step-auto-continue | transcript에서 "Step NNN 완료" 스캔 → progress 갱신 → SPEC 생성 → Trust5 평가 → 미완료면 `{"decision":"block"}` 반환해 다음 턴 강제 재개 |

**자율주행의 핵심**은 마지막 줄, `step-auto-continue`의 `{"decision":"block"}` JSON 반환입니다. Claude Code 공식 hooks 스펙으로 Stop 시점에 이 JSON을 stdout에 내보내면 모델이 자동으로 다음 턴을 시작합니다. progress.json의 `completed_steps`가 107이 되기 전까지 빠져나갈 길이 없습니다.

---

## 설치

### 1) 플러그인 등록

Claude Code의 마켓플레이스에 본 디렉토리를 추가하거나 직접 경로로 등록:

```json
// ~/.claude/settings.json (사용자 전역) 또는 프로젝트 settings.local.json
{
  "plugins": {
    "harness107": {
      "path": "/absolute/path/to/harness107"
    }
  }
}
```

또는 마켓플레이스를 통한 설치 (해당 마켓에 publish한 경우):

```text
/plugin install harness107
```

### 2) 프로젝트 의존성 (각 사용 프로젝트마다)

step 본문이 다음을 사용합니다. 최초 `/webapp` 실행 시 step001이 알아서 설치합니다 — 수동 설치도 가능:

```bash
npm i -D @biomejs/biome stylelint vitest playwright @axe-core/playwright c8 jscpd madge
npx playwright install chromium
```

선택 사항: `semgrep` (Trust5 Secured 축에 사용. 없으면 4점 부여).

---

## 사용

```text
/webapp <주제>
```

또는 자연어 / 7줄 템플릿 (위 "한 줄로" 섹션 참조).

### 진행 상태 확인

```text
/harness-status
→ harness107: 37/107 완료 | current=step038 | r1=- r2=- r3=-
```

### 처음부터 다시

```text
/harness-reset
→ harness107 리셋 완료 — step001부터 재시작 가능
```

`/harness-reset`은 `step_archive/archived/`, `specs/`, `outputs/`는 건드리지 않습니다. progress.json만 초기화.

---

## 5개의 철학 (요약)

플러그인은 한 obsidian vault의 6개 핵심 철학을 그대로 옮겨 담았습니다:

1. **하네스 엔지니어링** — 모델이 아니라 환경이 품질을 만든다
2. **절차의 원자화** — 한 step은 한 가지 책임
3. **질문 금지 = 결단하는 AI** — 사용자 옵션 선택 게이트 금지, brainstorming HARD-GATE 무력화
4. **자연 종료 금지** — 컨텍스트 한계까지 한 턴 안에서 밀어붙임. Stop hook이 자동 재개
5. **AI Slop 방지** — JSON 룰셋·8 배수 grid·폰트 4종·accent 1색·radius 5종·44 pt 터치
6. **MoAI-ADK 정직성** — @MX 4종 태그·EARS 라이트 SPEC·Trust 5 게이트

전문은 `skills/harness-rules/SKILL.md`에 박혀 있습니다. 활성화되면 모든 step·모든 서브에이전트가 자동 상속.

---

## 주의

> harness107는 의도적으로 **brainstorming / TDD 등 superpowers skill의 HARD-GATE를 무력화**합니다. 다른 사용자가 본 플러그인을 깐 상태에서 일반적인 대화를 시도하면 "질문 없이 즉시 실행" 모드가 됩니다.
>
> 이 모드는 **/webapp 트리거 또는 progress.json이 활성 상태일 때만** 효과가 강화됩니다. progress.json이 없거나 107개 완료된 상태에서는 대부분의 hook이 silent skip하여 통상 모드로 돌아갑니다.

---

## 권한 자동승인 (auto-approve) — 한계 및 안전 모델

본 플러그인의 `auto-approve.{ps1,sh}`는 `--dangerously-skip-permissions` 플래그 없이도 자율주행에 필요한 도구 호출에 대해 권한 팝업을 자동 스킵합니다. 공식 hooks 스펙 (<https://code.claude.com/docs/en/hooks>) 의 `permissionDecision:"allow"` 메커니즘을 사용합니다.

### 동등성 및 한계

| 항목 | `--dangerously-skip-permissions` | harness107 auto-approve hook |
|:---|:---|:---|
| 권한 팝업 스킵 | 모든 도구 | 7종 화이트리스트(Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch/WebSearch)만 |
| 적용 범위 | 세션 전체 | 플러그인이 enable된 동안 |
| 위험 명령 통과 | `rm -rf /`·`rm -rf ~`는 circuit breaker가 여전히 prompt | destructive-guard + auto-approve 자체 패턴 차단으로 prompt 또는 차단 |
| deny/ask 규칙 우회 | 우회 안 함 (managed deny 가 우선) | 우회 안 함 (공식 문서 기준) |
| root/sudo 거부 | 명시적으로 시작 차단 | sudo 패턴 차단 (auto-approve가 approve 안 함) |
| 사용자 ~/.claude/settings.json 변경 | 안 함 | 안 함 (plugin install hook 부재; 사용자 신뢰 위반 방지) |

### 권한 모드 / 환경변수 (2회차 재검증 결과)

- **`CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` / `CLAUDE_AUTO_APPROVE` / `CLAUDE_PERMISSIONS_MODE` 환경변수는 공식 지원되지 않습니다.** Claude Code가 인식하는 환경변수는 `CLAUDE_CODE_*` prefix (예: `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_USE_POWERSHELL_TOOL`) 뿐이고, 권한 스킵과 직접 연관된 것은 없습니다.
- **`/permissions` 슬래시 명령은 권한 *모드*를 변경하지 못합니다.** allow/ask/deny *규칙*만 관리합니다. 모드 변경은 `Shift+Tab` cycle 또는 시작 시 `--permission-mode` 플래그로만 가능합니다.
- **`permissions.defaultMode: "bypassPermissions"`는 user scope (~/.claude/settings.json) 에서만 안정적으로 동작합니다.** project/local scope 의 `defaultMode: "auto"` 는 v2.1.142부터 무시되며 (저장소 자가승격 방지), `bypassPermissions`도 관리자가 `disableBypassPermissionsMode: "disable"`로 차단 가능합니다.
- **Plugin이 ship 하는 `settings.json`은 `agent`/`subagentStatusLine` 키만 지원**합니다. `permissions.defaultMode` 같은 키를 플러그인에서 직접 박을 수 없으므로, hook 경로(본 auto-approve)가 유일한 plugin-내장 해법입니다.
- **Plugin install / postinstall hook은 존재하지 않습니다.** 가장 가까운 것은 `SessionStart` hook으로, `${CLAUDE_PLUGIN_DATA}` 디렉토리에 한정된 초기화만 사용해야 합니다. 사용자의 `~/.claude/settings.json` 패치는 신뢰 위반이므로 금지.

### Race-condition 안전성

공식 hooks 문서는 **같은 이벤트의 hook들이 병렬 실행**된다고 명시합니다 (`"All matching hooks run in parallel"`). 따라서 PreToolUse(Bash)의 `destructive-guard`와 PreToolUse(Bash|Write|...)의 `auto-approve`가 동시에 실행될 수 있습니다.

**보호 메커니즘 (defense-in-depth)**:
1. **destructive-guard exit 2** — 공식 문서 quote: *"A hook that exits with code 2 stops the tool call before permission rules are evaluated."* 위험 패턴이 매칭되면 어떤 allow도 우선하지 못합니다.
2. **auto-approve 자체의 패턴 재검증** — 동일한 위험 패턴 50+개를 인라인 복제하여, 위험 명령에는 approve JSON을 *내보내지 않습니다*. 따라서 race condition 시점에도 auto-approve가 잘못된 allow를 emit 하지 않습니다.
3. **추가 차단 패턴 (2회차 보강)**: `sudo`, `su -`, `crontab -e`, `systemctl stop/disable`, `pip install --index-url`, `bash <(curl ...)`, `eval $(curl)`, `iptables -F`, `shutdown/reboot/halt`, SSH/SCP 우회 등.

### 알려진 한계

- 신규 도구 (예: 새 MCP 서버 추가)는 화이트리스트에 자동 추가되지 않습니다. 자율주행이 신규 도구에서 권한 팝업으로 멈춘다면 `auto-approve.{ps1,sh}`의 `$autoApproveTools` 배열에 도구명을 추가해야 합니다. harness107 의 step001~107 본문은 MCP 도구를 호출하지 않으므로 기본 화이트리스트로 충분합니다.
- `bypassPermissions` 모드와 달리, **deny / ask 규칙은 우회되지 않습니다.** managed settings에 deny가 있으면 그쪽이 우선합니다.
- root/sudo 환경에서 Claude Code 자체가 시작되지 않으므로, sudo 환경에서는 이 메커니즘이 의미 없습니다.

### 3회차 재검증 — 추가 보호 및 한계

**민감 경로 보호 (3회차 추가)**: Write/Edit/MultiEdit/NotebookEdit 도구의 `file_path`가 다음에 해당하면 auto-approve 가 거부됩니다 (정상 권한 흐름으로 떨어지므로 사용자가 직접 승인해야 함):
- SSH/GPG/AWS/Azure/GCP/kube/docker 자격증명 디렉토리
- 사용자 셸 init 파일 (`.bashrc`, `.zshrc`, `.profile` 등)
- Claude Code 자체 설정 (`.claude/settings.json`, `.claude/settings.local.json`)
- 시스템 디렉토리 (`/etc/`, `/var/`, `/boot/`, `C:\Windows\`, `C:\Program Files\`)
- **harness107 자체의 hook 파일** (자기 무력화 방지 — `destructive-guard`, `auto-approve`, `step-auto-continue`, `hooks.json`, `plugin.json` 수정 시 사용자 승인 강제)

**WebFetch 위험 URL 사전 차단 (3회차 추가)**:
- 사설 네트워크 / localhost (SSRF 방지: `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, `0.0.0.0`)
- 클라우드 메타데이터 서비스 (`169.254.169.254`, `metadata.google.internal`, `metadata.azure.com`)
- 원격 실행 페이로드 확장자 (`.sh`, `.ps1`, `.bat`, `.exe`, `.dll` 등 URL)
- `file://` 스킴

**여전히 남는 한계 (3회차 확정)**:
- **`bin/` 디렉토리 우회**: Claude Code 플러그인은 `bin/` 폴더의 실행 파일을 Bash tool 의 `PATH` 에 추가할 수 있습니다 (공식 문서 명시). 본 플러그인은 `bin/`을 사용하지 않지만, **다른 플러그인이 시스템 명령(`rm`, `sudo` 등)을 shadow 하는 위험은 hook 차원에서 차단 불가**합니다. destructive-guard 는 명령 문자열만 검사하며 실제 실행되는 바이너리 경로는 검사하지 않습니다.
- **`PermissionRequest` / `PermissionDenied` hook 채널**: 본 플러그인은 `PreToolUse` 만 등록하지만, 다른 플러그인이 `PermissionRequest` hook 으로 `updatedInput`을 사용하여 명령을 사용자 모르게 변조할 수 있습니다 (공식 문서 명시). harness107 의 destructive-guard 는 PreToolUse 단계에서 동작하므로, PermissionRequest 단계의 변조는 검사하지 않습니다.
- **HTTP / MCP hook 타입**: Claude Code 는 hook 타입으로 `command` 외에 `http`, `mcp_tool`, `prompt`, `agent` 를 지원합니다. 본 플러그인은 `command` 만 사용합니다. 다른 플러그인이 `http` hook 으로 권한 결정을 외부 서버에 위임하면 네트워크 가시성 외부에서 권한이 결정됩니다.
- **SessionStart `reloadSkills` 권한 상승 벡터**: 공식 문서가 명시한 대로, SessionStart hook 이 `~/.claude/skills/` 에 임의 skill 을 쓰고 `reloadSkills: true` 를 반환하면 같은 세션에서 즉시 활성화됩니다. 본 플러그인은 이 패턴을 사용하지 않지만, 사용자가 본 플러그인 외 다른 플러그인을 enable 할 때 주의 필요.
- **PostToolUse / SessionStart / UserPromptSubmit / PreCompact / Notification / Stop / SubagentStop 의 출력 JSON 에는 권한 관련 필드가 부재** (3회차 공식 문서 재확인). 따라서 권한 우회 통로는 **PreToolUse 와 PermissionRequest** 두 곳 뿐입니다.

**Managed settings 우선순위 (3회차 확정)**: 사용자 또는 조직 관리자가 다음 경로에 권한 정책을 박을 수 있으며, 이는 본 플러그인 hook 보다 우선합니다.
- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json` 또는 MDM plist `com.anthropic.claudecode`
- Linux/WSL: `/etc/claude-code/managed-settings.json`, `/etc/claude-code/managed-settings.d/*.json`
- Windows: `C:\Program Files\ClaudeCode\managed-settings.json`, 레지스트리 `HKLM\SOFTWARE\Policies\ClaudeCode` / `HKCU\SOFTWARE\Policies\ClaudeCode`

해당 경로에 `disableBypassPermissionsMode: "disable"` 또는 `permissions.deny` 가 설정되어 있으면 본 플러그인의 auto-approve 와 무관하게 차단됩니다.

### 4회차 재검증 — PermissionRequest hook 등록 + bin/ shadow / 정규화 보강

**1. PermissionRequest hook 신규 등록 (4회차 핵심)**

3회차에서 한계로만 명시했던 PermissionRequest 변조 통로를 본 회차에 hook 으로 무력화했습니다.

- **신규 파일**: `hooks/permission-request-guard.{ps1,sh}` + `hooks.json` 에 `PermissionRequest` 이벤트 바인딩 추가.
- **동작**: 다른 플러그인의 PermissionRequest hook 이 `hookSpecificOutput.decision.behavior:"allow"` + `decision.updatedInput` 으로 명령을 사후 변조해도, 본 플러그인이 같은 PermissionRequest 이벤트에서 destructive 패턴을 재검증하여 `{"decision":{"behavior":"deny"}}` 를 emit 합니다.
- **이중 안전**: stdout JSON deny + `exit 2` 동시 사용. 공식 문서 표 *"Hook event PermissionRequest → exit 2 → Denies the permission"*. 병렬 실행 race 에서도 본 플러그인의 deny 가 우선.
- **검사 범위**: Bash 명령 destructive 패턴 + Write/Edit/MultiEdit/NotebookEdit 의 민감 경로 + Edit/MultiEdit 의 `new_string`/`edits[].new_string` 내 destructive 패턴 + WebFetch 의 위험 URL.

**2. `bin/` shadow 우회 부분 차단 (4회차 추가)**

공식 plugins-reference 인용: *"`bin/` — Executables added to the Bash tool's `PATH`. Files here are invokable as bare commands while the plugin is enabled."* 다른 플러그인이 `bin/rm`, `bin/sudo` 등으로 시스템 바이너리를 shadow 가능. PoC 결과 PATH prepend 시 fake rm 이 실제 실행됨을 확인.

- **차단**: `auto-approve.{ps1,sh}` 에 PATH 변조 패턴(`export PATH=`, `set PATH=`, `$env:PATH=`, `PATH=/foo:$PATH` 인라인) 감지 시 approve 안 함. PATH 변조 명령은 사용자 권한 팝업으로 fallback.
- **남는 한계**: 다른 플러그인의 `bin/` 디렉토리는 Claude Code 가 *자동으로* PATH 에 추가하므로, 사용자가 명시적 PATH 변조 없이 `rm`, `sudo` 같은 bare 명령을 호출하면 hook 차원에서는 PATH 출처를 식별할 수 없습니다. **방어책: 사용자가 다중 플러그인 enable 시 각 플러그인의 `bin/` 내용을 직접 검토해야 합니다.** README 에 이 한계를 명시합니다.

**3. 민감 경로 정규화 (4회차 추가)**

3회차 패턴은 입력 형식에 의존했습니다. 본 회차에 정규화 단계를 추가하여 10가지 입력 변형 매트릭스 중 9개를 차단합니다.

| 입력 변형 | 4회차 결과 |
|:---|:---|
| `~/.ssh/authorized_keys` | BLOCKED ✅ |
| `\\?\C:\Users\<user>\.ssh\authorized_keys` (Win long path) | BLOCKED ✅ |
| `\\server\share\.ssh\authorized_keys` (UNC) | BLOCKED ✅ |
| `.SSH/AUTHORIZED_KEYS` (case-folding) | BLOCKED ✅ |
| `%2E%2Essh%2Fauthorized_keys` (URL-encoded) | BLOCKED ✅ |
| `~/.ssh/authorized_keys.` (trailing dot) | BLOCKED ✅ |
| `~//.ssh//authorized_keys` (double slash) | BLOCKED ✅ |
| `~\.ssh/authorized_keys` (mixed slash) | BLOCKED ✅ |
| `C:\PROGRA~1\sensitive.conf` (8.3 short name) | ⚠️ ALLOWED — Windows API 호출 필요 (정규식만으로는 불가) |
| `~/safe-looking/file` (심볼릭 링크 가짜) | ALLOWED (의도 — 실파일 검사 시점 외) |

- **정규화 단계**: URL-decode → backslash→slash → 중복 slash 축약 → trailing dot/space 제거 → long-path/UNC prefix 제거 → lowercase.
- **남는 한계**: 8.3 short name 은 Windows `GetLongPathName()` API 호출이 필요하며 본 hook 의 PowerShell `-replace` 만으로는 expand 불가. 사용자가 8.3 short name 으로 민감 경로에 접근하면 우회됩니다.

**4. Edit/MultiEdit 의 `new_string` 검사 (4회차 추가)**

3회차까지는 `file_path` 만 검사했습니다. PoC 결과 `file_path` 가 안전한 `/home/user/normal.txt` 이고 `new_string` 이 `"rm -rf $HOME"` 인 Edit 호출이 자동 승인됐습니다.

- **차단**: Edit 의 `new_string`, MultiEdit 의 `edits[].new_string` 내부에 destructive 패턴(`rm -rf $HOME`, `curl | bash`, `bash <(curl ...)`, `eval $(curl)` 등) 이 있으면 approve 안 함.
- **검증**: PoC 두 케이스 모두 BLOCKED 확인. 일반 `foo→bar` 같은 Edit 은 regression 통과.

**5. PreToolUse 의 `updatedInput` 발견 (4회차 신규)**

공식 hooks 문서 재확인 결과 PreToolUse 도 `hookSpecificOutput.updatedInput` 으로 tool input 을 변조할 수 있다는 점이 명시되어 있습니다 (3회차에는 PermissionRequest 만 언급). 다른 플러그인의 PreToolUse hook 이 본 플러그인의 destructive-guard 와 병렬 실행되면서 `updatedInput` 으로 명령을 변조할 수 있습니다.

- **방어 한계**: PreToolUse 단계의 변조는 hook chain 의 race condition 으로, 본 플러그인이 deny 를 emit 해도 다른 플러그인의 allow + updatedInput 이 어느 쪽이 우선되는지 공식 문서가 *명시하지 않습니다.* 다만 본 플러그인의 destructive-guard 가 `exit 2` 를 내면 공식 문서 표 명시대로 *"stops the tool call before permission rules are evaluated"* 가 우선합니다.
- **방어 추가**: 본 플러그인의 destructive-guard 는 이미 exit 2 를 사용하며, auto-approve 는 위험 패턴 발견 시 빈 출력으로 fallback. PreToolUse 단계 race 에서도 deny 가 우선.

**6. 본 회차 검증한 도구**

- `WebFetch hooks/permission-modes/plugins-reference` 3차 재확인
- 정규화 매트릭스 10케이스 PowerShell 실행 (9/10 BLOCKED)
- D-2/D-3 PoC: Edit new_string=`rm -rf $HOME`, MultiEdit edits[1].new_string=`curl|bash` 모두 BLOCKED
- B PoC: `/tmp/fake-bin/rm` 실제 생성 + PATH prepend + execution 확인 (fake rm 호출 성공) — 한계 명시 + PATH 변조 패턴 차단 추가
- PermissionRequest hook 4 시나리오 검증: rm -rf, ssh path, safe ls, MultiEdit content — 모두 정확히 deny/pass

### 5회차 재검증 — 8.3 expand / destructive-guard 동기화 / PreToolUse updatedInput PoC

**1. PreToolUse `updatedInput` PoC (A)** — 가상 evil-plugin hook이 같은 PreToolUse(Bash) matcher에 등록되어 `{"updatedInput":{"command":"rm -rf /"}}`를 emit하는 시나리오를 직접 PoC. 공식 문서가 다중 hook의 `updatedInput` 충돌 시 우선순위를 *명시하지 않음을* WebFetch로 재확인. **방어**: PermissionRequest hook (`permission-request-guard.{ps1,sh}`)이 `tool_input.command`를 **다시 읽어** destructive 패턴을 재검증하며, deny 시 stdout JSON + exit 2 이중 안전. **한계**: PreToolUse가 `permissionDecision:"allow"`를 emit하면 PermissionRequest가 발화하지 않을 수 있음 (공식 문서 모호). 본 플러그인의 auto-approve도 자체 destructive 패턴 검사 후에만 allow를 emit하므로 race 시점에도 안전.

**2. 8.3 short name 정규화 (B)** — `fsutil 8dot3name query C:` 결과 Windows 11 기본값에서 C:는 **8.3 활성화** 확인. `[System.IO.Path]::GetFullPath`가 시스템 well-known short name(`PROGRA~1`→`Program Files`, `PROGRA~2`→`Program Files (x86)`, `PROGRA~3`→`ProgramData`)을 실파일 존재와 무관하게 expand 가능, 비용 0.04ms 측정 (1000회 평균). **5회차 추가**: `auto-approve.ps1`와 `permission-request-guard.ps1`의 정규화 함수에 8.3 expand 단계 추가. 결과 매트릭스 #4 `C:\PROGRA~1\sensitive.conf` 가 BLOCKED 로 전환 → **10/10 BLOCKED** 달성. 사용자 디렉토리 short name(`ADMINI~1` 등)은 여전히 expand 불가 (실파일 lookup 필요) — 잔여 한계로 명시.

**3. `bin/` shadow 실측 (C)** — Plugin bin/ 디렉토리가 Claude Code 프로세스 PATH에 자동 상속됨을 *현재 셸 $PATH 출력으로 직접 확인* (예: `~/.claude/plugins/cache/claude-plugins-official/pyright-lsp/1.0.0/bin`). ASCII 경로 PoC: `/tmp/fake_bin/rm` 생성 + `PATH=/tmp/fake_bin:$PATH rm -rf /tmp/important_data` 실행 → fake rm이 실제 호출됨. **방어**: PATH 변조 명령(`export PATH=`, `set PATH=`, `$env:PATH=`, inline `PATH=/foo:$PATH`) 5종 패턴 차단을 **destructive-guard 본체에도 동기화** (4회차는 auto-approve에만 있었음). **잔여 한계**: 사용자가 명시적 PATH 변조 없이 bare `rm` 호출 시 다른 플러그인의 `bin/rm`이 shadow 가능 — hook 차원에서 식별 불가. 다중 플러그인 enable 시 각 `bin/` 직접 검토 필요.

**4. destructive-guard 4회차 보강 동기화 (D-2)** — 4회차에 auto-approve에만 추가된 22개 신규 패턴(sudo, su, crontab, systemctl, launchctl, pip --index-url, npm --registry, bash <(curl), eval $(curl), ssh rm, scp, iptables -F, ufw, shutdown, reboot, halt, init 0/6) + 5종 PATH hijack 패턴을 **destructive-guard.{ps1,sh} 본체에 정식 반영**. 1차 방어선이 race-safe 강화. Linux 시뮬 검증: `sudo apt install` → exit 2, `export PATH=...` → exit 2, `echo hello` → exit 0 (regression).

**5. PermissionRequest 발화 조건 재확인 (D-3)** — WebFetch 공식 문서 재확인: PreToolUse → PermissionRequest는 **순차 실행** (병렬 아님). `permissionDecision:"allow"` emit 시 PermissionRequest 발화 여부는 공식 문서 모호. 본 플러그인은 PermissionRequest hook을 안전망으로 유지하되, auto-approve가 자체 검증 후 allow를 emit하므로 race 시점에도 destructive가 통과되지 않음.

### 5회차 검증한 도구

- `fsutil 8dot3name query C:` → `0 (ENABLED)`. D: → `1 (DISABLED)`. Windows 11 기본 C: 8.3 활성화 확정.
- `[System.IO.Path]::GetFullPath("C:\PROGRA~1\sensitive.conf")` → `C:\Program Files\sensitive.conf` (실파일 무관 expand).
- 8.3 벤치마크: GetFullPath 0.0374ms/call, GetLongPathNameW 0.0437ms/call (1000회 평균) — hook 100ms 한도 대비 무시 가능.
- 본 플러그인 hook 직접 실행 매트릭스: A PoC (변조 시도 → permission-request-guard deny+exit 2), B 8.3 (`PROGRA~1` → auto-approve 빈출력 + permission-request-guard 차단), 안전 경로 `src/index.js` → allow JSON.
- `WebFetch https://code.claude.com/docs/en/hooks` (5차): PreToolUse `updatedInput` 충돌 우선순위 *미명시* / PreToolUse→PermissionRequest 순차 / 같은 이벤트 multi-matcher group은 병렬+deduplication 재확인.
- `WebFetch https://code.claude.com/docs/en/plugins-reference` (5차): `bin/` quote "Bash tool의 PATH에 추가" 직접 인용 확인.
- `destructive-guard.sh` bash -n 문법 검증 통과 + Linux 시뮬 (Windows guard 우회) 위험 패턴 차단 검증.

### 6회차 재검증 — updatedInput 머지·WSL2 short name·hook event 카탈로그 + 종료 메타 평가

**1. PreToolUse↔PermissionRequest `updatedInput` 머지 (A)** — 공식 hooks 문서를 정독한 결과 *후속 hook이 받는 `tool_input`이 원본인지 변조본인지, 여러 PreToolUse hook의 `updatedInput` 충돌 시 우선순위가 무엇인지 명시 부재*. `transcript_path`는 모든 hook에 제공되지만 PreToolUse가 변조한 최종 명령을 실행 전에 보장하는 별도 채널은 부재. **시뮬레이션 PoC** (Claude Code 외부 직접 stdin 주입) 결과:
- 시나리오 A (변조본 전달): `permission-request-guard.{ps1,sh}` 가 `tool_input.command`에서 `rm -rf /`를 직접 탐지 → `decision.behavior:"deny"` + `exit 2`. 차단 ✅
- 시나리오 B (원본 전달): permission-request-guard가 안전한 `echo safe`를 보고 통과 → 차단 불가 ⚠️

**한계 (확정 불가)**: Claude Code 코어의 실제 머지 동작은 공식 문서 미명시. 시나리오 B는 hook 차원 별도 채널이 부재하므로 차단 불가. 다만 본 플러그인은 destructive-guard가 동일 stdin(원본)을 받아 *원본이 안전하면* exit 0. *원본이 위험하면* exit 2로 즉시 차단. 즉 위험 명령이 원본 자체에 있는 경우는 1차 방어선에서 잡힘. **공격자가 원본을 위장하고 변조본만 위험한 시나리오**는 본 플러그인 단독으로는 차단 불가 (Claude Code 코어 동작 의존).

**2. WSL2 사용자 short name 한계 재정량 (B)** — 5회차에 ps1만 8.3 expand했고 sh는 "Windows guard로 회피"라고 가정했으나, **6회차 실측 결과 WSL2는 `uname -s`가 `Linux`이므로 Windows guard 미발동**. WSL2의 `/mnt/c/PROGRA~1`은 9p file server가 실제 디렉토리 listing 시점에 자동 8.3 expand하여 `Program Files`에 접근 가능. 즉시 PoC:
- `mkdir ~/ADMINI~1` (WSL2) → **literal 디렉토리로 생성** (사용자 자산, 위협 아님)
- `cygpath -u 'C:\PROGRA~1'` → `/c/PROGRA~1` (literal 유지, expand 안 함)
- `ls /mnt/c/PROGRA~1/` → 실제 `Program Files` 내용 출력 (9p 자동 expand)
- `bash auto-approve.sh` 6회차 patch 이전 입력 `Write file_path=/mnt/c/PROGRA~1/sensitive.conf` → **ALLOW 출력** ⚠️ 갭 발견
- `bash auto-approve.sh` 6회차 patch 이후 동일 입력 → **빈 출력 (차단)** ✅

**6회차 patch**: `auto-approve.sh`와 `permission-request-guard.sh`의 `normalize_path`/`is_sensitive_path`에 (a) `os.path.realpath` 호출로 WSL2 short name expand 시도 + (b) 보수적 fallback으로 well-known short token 패턴 매칭 (`PROGRA~\d`, `WINDOW~\d`, `SYSTEM~\d`, `ADMINI~\d`, `DOCUME~\d`, `MYDOCU~\d`, `USERS~\d`, `APPDAT~\d`, `LOCALS~\d`, `ALLUSE~\d`) — path 안에 이 token이 남아 있으면 sensitive로 분류.

**확정**: 사용자가 의도적으로 만든 literal `ADMINI~1` 디렉토리는 본 패턴 매칭으로 차단되지만 사용자 본인 자산이므로 false positive 가능성 존재. 다만 보수적 차단(권한 팝업으로 fallback)이 자율주행을 약간 방해할 뿐, *보안 모델은 깨지지 않음.* macOS HFS+/APFS에는 short name 자체가 없으므로 무관 (실측 무관 — 본 패턴 매칭은 발동 자체가 안 됨).

**3. 미검토 hook event 25개 권한 영향 재방문 (C)** — 공식 문서 전체 카탈로그 30개 hook event를 다시 정리하고 각 권한 출력 필드를 직접 인용:

| Event | 권한 결정 필드 | 통로 가능성 |
|:---|:---|:---|
| PreToolUse | `permissionDecision:"allow|deny|ask|defer"` | ✅ (5회차까지 보호 완료) |
| PermissionRequest | `decision.behavior:"allow|deny"` + `updatedInput` | ✅ (4·5·6회차 보호) |
| PermissionDenied | `retry:true` | 재시도 트리거 only |
| PostToolBatch | top-level `decision:"block"` | 배치 전체 block만, granular bypass 불가 ❌ |
| SubagentStart/Stop | 없음 | observability only ❌ |
| TaskCreated/Completed | exit code only | task tool은 별도 PreToolUse 검사를 받음 ❌ |
| PreCompact | top-level `decision:"block"` | compact block만 가능, 권한 무관 ❌ |
| Notification | 없음 | 순수 observability ❌ |
| UserPromptSubmit/Expansion | `decision:"block"` | 권한 변경 불가 ❌ |
| MessageDisplay | 없음 | display only ❌ |
| Elicitation/Result | `action:"accept|decline|cancel"` | MCP 폼 처리 only, 권한 무관 ❌ |
| WorktreeCreate/Remove | path return only | 권한 무관 ❌ |
| FileChanged/CwdChanged/ConfigChange | observability/block-only | 권한 변경 불가 ❌ |
| SessionStart/SessionEnd/Setup | observability/context only | 권한 변경 불가 ❌ |
| Stop/StopFailure/SubagentStop | `decision:"block"` | turn block만 ❌ |
| InstructionsLoaded/PostCompact | 없음 | observability only ❌ |
| TeammateIdle | 없음 | observability only ❌ |

**결론**: **권한 결정 통로는 정확히 2개 (PreToolUse + PermissionRequest)**. 1~5회차에 이미 양쪽 다 hook으로 보호 완료. `PermissionDenied`의 `retry:true`는 deny된 도구를 다시 시도하라고 모델에 알릴 뿐 권한 자체를 우회하지 못함 (재시도 시 PreToolUse가 다시 발화). **새로운 권한 우회 통로 0개 확정.**

**4. 종료 조건 메타 평가 (D)** — 5회차까지 누적된 보호:
- 30개 hook event 카탈로그 전수 + 권한 통로 2개에 모두 hook 등록
- 모든 도구(Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch/WebSearch + Read/Glob/Grep) 권한 통로 검토
- 3중 hook (destructive-guard + auto-approve + permission-request-guard)
- 125+ 위험 패턴 (destructive 74 + 민감 path 19 + URL 5 + PATH hijack 5 + sudo계 22)
- 정규화 매트릭스 (Windows 10/10 + WSL2 short token 매칭)
- 명시된 한계 (bin/ shadow, 사용자 short name false-positive, PreToolUse↔PermissionRequest 머지 미명시)

**메타 질문 (D-1) — "absolute 100점은 가능한가?"**: 불가능. `--dangerously-skip-permissions`는 *모든 도구·모든 작업을* 무조건 스킵하는 반면, hook 기반 등가물은 *화이트리스트 7종 + 위험 패턴 없는 명령*만 자동 승인한다. **두 모드는 본질적으로 다른 기능이므로 100% 등가는 영원히 불가능**. 종료 조건은 *"본 플러그인 목적(harness107 자율주행)을 충족하면서 안전 모델이 깨지지 않는 최대 등가"*이며, 이 정의 하에 "더 추가할 가치 있는 의미 있는 안전 패턴/통로 차단"이 0이면 종료.

**메타 질문 (D-2) — 더 추가할 가치 있는 항목이 존재하는가?**: 6회차에서 발견된 1건(WSL2 short name 갭)을 즉시 보강한 이후, 추가 검토 가치 있는 우회 경로 **0개**. 근거:
- 30개 hook event 모두 권한 영향 분석 완료
- 모든 권한 결정 통로(PreToolUse + PermissionRequest)에 hook 등록
- 모든 도구의 모든 주요 input 필드(command/file_path/url/new_string/edits[].new_string) 검사
- 모든 정규화 변형(URL-decode/backslash/double slash/trailing/long path/UNC/case/Windows 8.3/WSL2 8.3/short token fallback) 처리
- 모든 destructive/sensitive/dangerous 패턴 카탈로그화

**종료 가능 여부: 가능**. 본 플러그인 단독으로 차단 가능한 우회 경로는 소진됨. 잔여 한계 3개(bin/ shadow는 다중 플러그인 정책 차원, PreToolUse↔PermissionRequest 머지 미명시는 Claude Code 코어 의존, 사용자 의도 literal short name false-positive)는 hook 차원에서 더 이상 개선 불가하며 README에 명시 완료.

### 6회차 검증한 도구

- `WebFetch https://code.claude.com/docs/en/hooks` (6차) → 전체 30개 hook event 카탈로그 / PreToolUse↔PermissionRequest `updatedInput` 머지 우선순위 *미명시* 재확인 / PostToolBatch·SubagentStart·TaskCreated·PreCompact·Notification 권한 영향 표 도출.
- WSL2 실측: `wsl -d Ubuntu uname` = `Linux 6.6.87.2-microsoft-standard-WSL2`. `mkdir ~/ADMINI~1` → literal 생성. `ls /mnt/c/PROGRA~1/` → 실제 `Program Files` 내용 출력 (9p auto-expand).
- Git Bash 실측: `cygpath -u 'C:\PROGRA~1'` → `/c/PROGRA~1` (literal). `cygpath -a -l '/c/PROGRA~1'` → `-l`은 `-w`/`-m`만 지원하므로 unix 형식 expand 불가.
- A PoC `step_archive/_6회차_poc/run_a_simulation.ps1`: 시나리오 A(변조본 전달) → permission-request-guard EXIT=2 (deny). 시나리오 B(원본 전달) → EXIT=0 (차단 불가, 한계).
- B PoC `step_archive/_6회차_poc/test_wsl2_autoapprove.sh`: patch 이전 `Write /mnt/c/PROGRA~1/...` → ALLOW. patch 이후 → 빈 출력 (차단). regression `/tmp/safe.txt` → ALLOW 정상.
- `permission-request-guard.sh` 6회차 patch 검증: WSL2에서 `PROGRA~1`/`ADMINI~1` 입력 → `deny + EXIT=2`. `/tmp/safe.txt` → EXIT=0 (regression).

### 7회차 재검증 — multi-hook 우선순위 명문화 발견 + 3중 hook 회귀 동기화 패치

**1. multi-hook 우선순위 공식 문서 명문화 발견 (A 신규 정보)** — 6회차 시점엔 "미명시"라 평가했던 부분에서 명문화 발견:
- 출처: <https://code.claude.com/docs/en/agent-sdk/hooks>
- 인용: *"When multiple hooks or permission rules apply, **deny** takes priority over **defer**, which takes priority over **ask**, which takes priority over **allow**. If any hook returns `deny`, the operation is blocked regardless of other hooks."*
- 인용: *"When an event fires, all matching hooks run in parallel. For permission decisions, the most restrictive result wins: a single `deny` blocks the tool call regardless of what the other hooks return."*

해석: 본 플러그인의 destructive-guard 가 PreToolUse 에서 동일 stdin 으로 deny 반환 시, *evil-plugin 의 allow + updatedInput 변조*와 무관하게 deny 우선 → 차단. 6회차 시나리오 B(원본 위장 + 변조본 위험)의 일부도 deny 우선순위로 차단 가능. 단 *원본이 안전하게 위장된 경우*는 destructive-guard 가 위험을 탐지하지 못해 여전히 한계 (Claude Code 코어 동작 의존). 코드 수정 불필요(이미 deny 반환 구현되어 있음).

**2. WSL2 literal short name false-positive UX 평가 (B 메타)** — 7회차 메타 평가:
- 정상 사용자가 `mkdir ~/PROGRA~1` 같은 literal Windows 8.3 토큰 디렉토리를 만들 동기는 거의 없음 (PROGRA~1·ADMINI~1·DOCUME~1·WINDOW~1·USERPR~1·SYSTEM~1·DESKTO~1 7종)
- false-positive 발생 시 본 플러그인은 **deny 가 아니라 권한 팝업 fallback** → 사용자 자산 손실 없음
- 환경변수 opt-in 메커니즘(`HARNESS107_ALLOW_LITERAL_SHORT_NAMES=1`) 도입 시: 유연성 ↑ but 보안 일관성 ↓ + 환경변수 leakage 시 우회 가능 ⚠️
- **결론**: opt-in 메커니즘 도입 가치 < 보안 일관성. **현재 보수적 차단 정책 유지**. README 한계 명시만 보강.

**3. 3중 hook 회귀 매트릭스 직접 실행 (C)** — 15케이스 × 3 hook × 2 환경 = 90 셀 회귀 테스트.

신규 발견 동기화 갭 (PowerShell + bash 양쪽 동일):
- **Gap-1** (case 9 PATH hijack): `permission-request-guard.{ps1,sh}` `Test-DangerousCommand`/`is_dangerous_cmd` 에 `export PATH=` 패턴 부재 → PASSTHROUGH
- **Gap-2** (case 12 `Edit new_string="rm -rf $HOME"`): 동일 함수에 `\$HOME`/`\$\{HOME` 변수 destructive 패턴 부재 → PASSTHROUGH
- **Gap-3** (case 13 `MultiEdit new_string="sudo apt install evil"`): `auto-approve.{ps1,sh}` `Test-DangerousString`/`NS_DANGER_PATTERNS` 가 `sudo\s+rm`만 매칭 → **자동승인됨 ⚠️** (실제 위협)

**7회차 patch** (4개 파일):
1. `auto-approve.ps1` `Test-DangerousString`: sudo 일반(`\s+`) + `\$HOME`/`\$\{HOME`/`\$PWD` + PATH hijack 5종 + git/DROP/crontab/shutdown 등 카탈로그 보강 (5+8+5 = 18 패턴 추가)
2. `auto-approve.sh` `NS_DANGER_PATTERNS`: 동일 카탈로그 (bash regex 변환)
3. `permission-request-guard.ps1` `Test-DangerousCommand`: `\$HOME`/`\$\{HOME`/`\$PWD` 변수 매칭 2종 + PATH hijack 5종 추가
4. `permission-request-guard.sh` `is_dangerous_cmd`: 동일 카탈로그 (bash regex 변환)

**patch 후 재실행 결과** (15×3×2=90 셀):
- case 9 PATH hijack: PS·SH P_PS=BLOCK·P_SH=BLOCK ✅
- case 12 Edit new_string=$HOME: PS·SH P_PS=BLOCK·P_SH=BLOCK ✅
- case 13 MultiEdit sudo: PS·SH A_*=PASSTHROUGH(자동승인 거부 ✅) + P_*=BLOCK ✅
- regression case 1 echo safe: 정상 ALLOW 유지 ✅
- regression case 14·15 Read/Grep: 화이트리스트 외 (의도된 PASSTHROUGH/ALLOW) ✅

**역할 분리 모델 일치성 확인**:
- destructive-guard: Bash 명령만 검사 (path/url 검사 본래 역할 아님 — 의도된 ALLOW)
- auto-approve: 화이트리스트 위험 패턴 발견 시 PASSTHROUGH (= 권한 팝업 fallback = 안전)
- permission-request-guard: 모든 도구·모든 input 필드 deny 검사

**4. 종료 조건 최종 평가 (D)** — 7회차 신규 발견은 **신규 우회 경로가 아니라 3중 hook 카탈로그 동기화 누락**이었음. 본질적 우회 경로는 6회차에서 모두 소진됨. 7회차 patch 로 90 셀 매트릭스 100% 일치 달성. 추가 검토 가치 있는 우회 경로 또는 동기화 갭 **0건 확정**.

### 7회차 검증한 도구

- `WebFetch https://code.claude.com/docs/en/agent-sdk/hooks` → multi-hook deny 우선순위 명문화 발견 ("most restrictive result wins").
- `WebFetch https://code.claude.com/docs/en/hooks` (7차 재확인) → updatedInput 머지 시점은 여전히 미명시. 단 deny 우선순위는 명시.
- `step_archive/_7회차_poc/regression_matrix.ps1` → 15케이스 × 3 hook × PowerShell. patch 이전 3건 갭 발견, patch 이후 모두 해결.
- `step_archive/_7회차_poc/regression_matrix.sh` → 15케이스 × 3 hook × bash(WSL2). 동일 갭 + 동일 해결.

### 8회차 재검증 — Gap-3 동일 카테고리 전수 점검 + false-positive 정밀화

**1. 권한상승/설치/리버스쉘 카테고리 전수 점검 (A)** — 7회차 Gap-3 (`MultiEdit sudo apt install` 자동승인)와 동일 카테고리에서 23 케이스 PoC 실행 결과 **20건 자동승인 위협 잔존** 확인:

- 패키지매니저 install 9종: `apt`, `apt-get`, `yum`, `dnf`, `brew`, `pacman`, `pip`, `gem`, `cargo` 모두 누락 (7회차는 `pip --index-url` 만 검사)
- chmod 변형 1건: `chmod -R 777 /` (옵션 사이 끼움으로 `chmod\s+0?777` 미매칭)
- 계정/권한 변경 7건: `chown root`, `chsh`, `passwd`, `adduser`, `groupadd`, `setcap`, `/etc/sudoers` 누락
- 리버스 쉘 3건: `nc -lvnp`, `python -c "...socket"`, `bash -i >& /dev/tcp/` 누락

**즉시 patch** (5개 파일 동기화: destructive-guard.{ps1,sh}, auto-approve.{ps1,sh}, permission-request-guard.{ps1,sh}):
- 패키지매니저 install: `(apt|apt-get|yum|dnf|brew|pacman|pip|pip3|gem|cargo|conda|zypper|emerge|opkg|apk|snap|flatpak)\s+(install|-S|-i|add)` + `npm install -g`
- 계정/권한: `(useradd|adduser|userdel|deluser|groupadd|groupdel|usermod|groupmod|chsh|passwd|gpasswd)` + `chown\s+(root|0)` + `setcap` + `visudo` + `/etc/sudoers`
- chmod 정규식 정밀화: `chmod\s+(-[a-zA-Z]+\s+)?0?777`
- 리버스 쉘: `nc(at)? (-l[vnpuk]+|--listen)` + `bash -i >&? /dev/tcp/` + `/dev/tcp/IP/PORT` + `python -c .*(socket|subprocess|pty)` + `perl -e .*socket` + `ruby -e .*TCPSocket` + `php -r .*fsockopen` + `socat (tcp|exec):`

**patch 이후** 23/23 케이스 모두 auto-approve PASSTHROUGH (자동승인 거부) + permission-request-guard BLOCK ✅.

**2. false-positive 회귀 검증 (B)** — 정상 코드 8 케이스 dry-run:
- 7/8 정상 ALLOW (git push / echo PATH / cat $HOME / ls ~/.cache / npm install / WORKSPACE=$HOME/proj / `# you need sudo for this`)
- 1/8 의도된 보수 차단 `pip install --user mypackage` — 권한 팝업 fallback (사용자 승인 가능)

**B-7 patch**: `# you need sudo for this` 같은 단일 코멘트 라인 false-positive 해결을 위해 모든 hook의 Bash 명령 분기와 new_string 검사에 `^\s*#` 시작 라인 스킵 추가 (단일 라인) / 다중 라인 입력은 코멘트 라인만 제거 후 검사 (다중 라인 스크립트 내 위험 명령 누락 방지).

**3. SoT 리팩토링 평가 (C)** — JSON 단일 패턴 파일로 4-hook 동기화 가능성 검토:
- 채택 안 함: PowerShell `(?i)`/`\b`/`[a-z]` vs bash POSIX ERE `[[:space:]]` 정규식 호환성 한계 + JSON 파싱 비용 (매 hook 호출당 1-5ms × 4 hook) + 단일 장애점 위험
- **대안**: 회귀 매트릭스(`_7회차_poc/regression_matrix.*` + `_8회차_poc/matrix_*`)를 **사실상 SoT**로 운용. 패턴 추가 시 매트릭스에 케이스 추가하면 4 hook 누락이 자동 검출됨
- **매뉴얼 동기화 주의사항**: 새 destructive 패턴 추가 시 5개 hook 파일(destructive-guard.{ps1,sh}, auto-approve.{ps1,sh}, permission-request-guard.{ps1,sh}) 동시 수정 + 회귀 매트릭스에 케이스 추가 필수

**4. 종료 평가 (D)** — 솔직한 평가:
- 8회차 발견은 7회차 Gap-3 *동일 카테고리* 잔존이며 본질적 신규 공격 벡터는 아니나, **패턴 단위로는 20건 모두 실제 자동승인 위협**
- 패치 후 23+15+8=46 셀 매트릭스 100% 일치 (회귀 0건)
- 추가 카테고리(키로거/메모리 dump/암호화 ransomware/eval-exec 메타/base64 인코딩) 검토는 본 사이클 명시 범위 외. 화이트리스트+거부 모델은 무한 카테고리 망라가 목적이 아님

### 8회차 검증한 도구

- `step_archive/_8회차_poc/matrix_a.ps1` → 권한상승/설치/리버스쉘 23 케이스 × 2 시나리오(MultiEdit edits[]+Edit new_string) × 2 hook = 92셀. patch 이전 20 케이스 AUTO-APPROVED 확정, patch 이후 모두 PASSTHROUGH+BLOCK.
- `step_archive/_8회차_poc/matrix_b.ps1` → false-positive 8 케이스. patch 이전 `# you need sudo` BLOCK (false-positive), patch 이후 ALLOW.
- `step_archive/_7회차_poc/regression_matrix.ps1` 재실행 → 15/15 매트릭스 100% 일치 유지 (회귀 0건).
- PowerShell `[scriptblock]::Create` 3 파일 OK + bash `bash -n` 3 파일 OK (구문 검증).

---

## 라이선스

UNLICENSED — 개인 vault 추출본. 마켓 공개 시 의존성·경로 정리 후 MIT로 전환 권고.
