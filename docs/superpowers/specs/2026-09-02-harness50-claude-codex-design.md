# Harness50 Claude + Codex 이중 플랫폼 설계

날짜: 2026-09-02
상태: 대화에서 섹션별 승인 완료, 작성된 설계 문서 검토 대기
대상 저장소: https://github.com/Technoetic/harness50
조사 기준 커밋: 492b0e0

## 1. 목적

기존 Technoetic/harness50 저장소 하나가 Claude Code와 Codex를 모두 지원하도록 확장한다.

- Claude Code에서는 기존 /webapp 흐름을 유지한다.
- Codex에서는 $webapp <topic>을 사용한다.
- Claude에서 일부 단계를 끝낸 프로젝트를 Codex에서 $webapp resume으로 이어갈 수 있다.
- Codex는 50단계 자동 진행을 제공하되 명령 자동 승인을 하지 않는다.
- 두 플랫폼의 어댑터, 상태 및 훅을 분리해 한쪽 변경이 다른 쪽을 손상하지 않게 한다.

이 작업은 별도 harness50-codex 저장소를 만들지 않는다. 동일한 Git 저장소 루트에 Claude와 Codex 진입점을 함께 둔다.

## 2. 설계 원칙

1. 기존 Claude 동작 우선 보존
   - commands/, agents/, skills/, hooks/, assets/steps/와 .claude-plugin/의 기존 실행 계약을 유지한다.
   - 현재 작업 트리에 있는 사용자 소유 미커밋 변경을 덮어쓰거나 되돌리지 않는다.

2. 플랫폼 어댑터 격리
   - Codex 전용 파일은 .codex-plugin/과 codex/ 아래에 둔다.
   - Codex manifest가 codex/hooks/hooks.json을 명시적으로 가리키게 해, 루트 hooks/hooks.json의 Claude 훅이 Codex에서 로드되지 않도록 한다.

3. 작업 산출물 공유, 제어 상태 분리
   - 양쪽 플랫폼은 step_archive/TOPIC, outputs, specs, screenshots 등 실제 작업 산출물을 공유한다.
   - Claude 제어 상태는 step_archive/progress.json이다.
   - Codex 제어 상태는 step_archive/.harness50-codex/이다.

4. 단방향 이전
   - Codex는 Claude 상태를 한 번 읽어 가져올 수 있다.
   - 가져온 뒤에는 Codex 상태만 기록한다.
   - Codex가 Claude progress.json을 수정하거나 Claude로 상태를 역동기화하지 않는다.

5. 명시적 완료
   - Codex는 대화 문구나 transcript를 파싱해 완료를 추정하지 않는다.
   - 현재 단계의 검증이 성공하고 상태 관리자가 완료 영수증을 기록한 경우에만 진척된다.

6. 기존 권한 체계 유지
   - 자동 승인을 추가하지 않는다.
   - 명백한 파괴 명령을 거부하는 deny-only 방어막만 추가하고, 그 외에는 Codex의 정상 권한 확인을 따른다.

## 3. 범위

### 포함

- 같은 저장소에 Codex plugin manifest 추가
- Codex용 webapp, harness50-status, harness50-reset skill
- Codex용 50개 단계 문서와 Claude 원본 대응표
- Claude에서 Codex로 진행 상태를 한 번 가져오는 importer
- 원자적 상태 저장, 완료 영수증, 실행 소유권 및 잠금
- SessionStart, UserPromptSubmit, Stop, PreToolUse Codex 훅
- Windows와 POSIX에서 동작하는 Node.js 기반 상태 및 훅 스크립트
- 구조, 상태 머신, 동시성, 훅 계약, 보안, 설치 테스트
- 기존 Claude 회귀 테스트 유지

### 제외

- Codex에서 /webapp slash command를 새로 만드는 것
- Claude와 Codex의 실시간 양방향 상태 동기화
- Codex가 Claude progress.json을 갱신하는 것
- 명령 또는 PermissionRequest 자동 승인
- 훅 신뢰 검토 우회
- MCP 서버, 원격 서비스, 계정, telemetry
- public plugin directory 등록
- 기존 Claude 단계 문서 전체를 지금 provider-neutral 형식으로 재작성하는 것
- Codex에서 끝낸 상태를 Claude로 내보내는 기능

## 4. 저장소 구조

~~~text
harness50/
├─ .claude-plugin/
│  ├─ plugin.json
│  └─ marketplace.json
├─ commands/                    # 기존 Claude 명령
├─ agents/                      # 기존 Claude agent
├─ skills/                      # 기존 Claude skill
├─ hooks/                       # 기존 Claude 훅
├─ assets/steps/                # 기존 Claude 단계 001~050
├─ .codex-plugin/
│  └─ plugin.json               # 새 Codex 진입점
└─ codex/
   ├─ skills/
   │  ├─ webapp/SKILL.md
   │  ├─ harness50-status/SKILL.md
   │  └─ harness50-reset/SKILL.md
   ├─ hooks/
   │  ├─ hooks.json
   │  └─ *.mjs
   ├─ scripts/
   │  ├─ harness-state.mjs
   │  └─ lib/*.mjs
   ├─ assets/steps/
   │  ├─ index.json
   │  └─ step001.md~step050.md
   └─ tests/
~~~

.codex-plugin/plugin.json은 다음 경계를 명시한다.

- plugin name은 harness50으로 유지한다. Claude와 Codex가 각각 다른 이름으로 등록되는 것이 아니라, 두 host가 자기 manifest를 읽는 하나의 의도적인 package identity다.
- skills 경로는 ./codex/skills/이다.
- hooks 경로는 ./codex/hooks/hooks.json이다.
- Claude용 루트 hooks/hooks.json을 자동 탐색에 맡기지 않는다.
- 첫 Codex 호환 릴리스는 2.1.0으로 정하고 Claude manifest, Codex manifest, marketplace metadata의 버전을 함께 맞춘다.

OpenAI 공식 변환 지침에 따라 Claude commands와 reusable agents는 Codex skill로 옮기고, Claude 전용 훅은 Codex 훅 계약에 맞춰 별도 구현한다.

- https://developers.openai.com/plugins/guides/submit-claude-plugin
- https://developers.openai.com/plugins/build/plugins
- https://learn.chatgpt.com/ko-KR/docs/hooks

## 5. 사용자 인터페이스

### Claude Code

- /webapp <topic>
- /harness-status
- /harness-reset

기존 명령명과 기존 동작을 유지한다.

### Codex

- $webapp <topic>: 새 Codex workflow 시작
- $webapp resume: 기존 Codex 상태 재개 또는 Claude 상태 최초 가져오기
- $webapp pause: 다음 자동 continuation 중지
- $harness50-status: 상태를 읽기 전용으로 표시
- $harness50-reset: Codex 제어 상태를 복구 가능한 백업으로 보관하고 비활성화

Codex에는 /webapp을 가장하지 않는다. skill 호출 문법인 $webapp을 문서, 예제 및 오류 메시지에서 일관되게 사용한다.

새 topic 시작 시 현재 workspace에 활성 Codex 상태 또는 Claude progress.json이 있으면 덮어쓰지 않는다. 기존 Claude 작업이면 resume을 안내하고, unrelated topic이면 별도 workspace 사용을 안내한다.

## 6. 단계 문서와 동등성

기존 assets/steps/step001.md부터 step050.md까지는 Claude 동작 보존을 위해 그대로 둔다. Codex는 codex/assets/steps/에 적응된 사본을 사용한다.

Codex 단계 변환 규칙:

- Claude, Haiku, Sonnet 같은 provider 또는 model 고정 표현을 역할 중심 표현으로 바꾼다.
- Read, Write, Edit, Bash, Task, WebFetch, WebSearch를 특정 도구 이름이 아닌 행동과 capability로 표현한다.
- .claude 경로와 CLAUDE_PLUGIN_ROOT 의존성을 제거한다.
- $ARGUMENTS는 skill 입력 계약으로 바꾼다.
- 69, 104, 107처럼 50단계 체계와 맞지 않는 오래된 milestone을 복제하지 않는다.
- 결과 파일은 기존 작업과 이어질 수 있도록 step_archive 아래의 동일한 산출물 경로를 우선 유지한다.
- 단계 순서, 목적, acceptance evidence는 축소하거나 재배열하지 않는다.

codex/assets/steps/index.json은 각 단계에 대해 다음을 기록한다.

- canonical step number
- Claude source path
- Codex target path
- stable title과 phase
- expected output contract
- 변환 당시 Claude source SHA-256

정적 테스트는 양쪽에 정확히 50개 단계가 있고 번호가 001~050으로 연속인지 확인한다. 원본 hash가 바뀌면 자동으로 Codex 사본을 덮어쓰지 않고 review-required 오류를 낸다. 구조적 동등성은 자동 검증하되 의미적 변경은 명시적 검토를 요구한다.

## 7. 런타임 저장 구조

~~~text
<workspace>/step_archive/
├─ progress.json                         # Claude 소유, Codex read-only
├─ TOPIC/TOPIC.md                        # 공유 입력
├─ outputs/, specs/, screenshots/        # 공유 산출물
└─ .harness50-codex/
   ├─ state.json
   ├─ receipts/
   │  └─ step001.json~step050.json
   ├─ imports/
   │  ├─ claude-progress-<timestamp>.json
   │  └─ claude-progress-<timestamp>.meta.json
   ├─ events.jsonl
   ├─ run.lock
   ├─ import-error.json                  # 오류가 있을 때만
   └─ backups/
~~~

Codex metadata만 .harness50-codex 아래에 둔다. source code와 실제 tutorial 산출물은 기존 프로젝트 경로 및 step_archive 공유 경로에 남는다.

### state.json 핵심 필드

~~~json
{
  "schema_version": 1,
  "workflow_id": "uuid",
  "status": "running",
  "total_steps": 50,
  "current_step": 4,
  "completed_steps": [1, 2, 3],
  "topic_path": "step_archive/TOPIC/TOPIC.md",
  "topic_sha256": "hex-digest",
  "current_attempt": null,
  "consecutive_failures": 0,
  "blocked_reason": null,
  "owner": null,
  "continuation": null,
  "imported_from": null,
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "completed_at": null
}
~~~

status 값은 running, paused, blocked, completed 중 하나다. incomplete 상태의 current_step은 유효한 영수증으로 구성된 첫 미완료 단계이며, completed 상태에서는 null이다.

### 영수증

Codex-native 완료 영수증에는 workflow ID, step, attempt ID, completion time, summary, 검증 명령 결과 또는 workspace-relative artifact path가 포함된다. 비밀값과 원시 환경 변수는 저장하지 않는다.

Claude에서 가져온 prefix에는 import 영수증을 생성한다. 이 영수증은 Codex가 과거 결과를 재검증했다고 주장하지 않고 provenance=claude-progress-import, source SHA-256, imported timestamp를 기록한다. 가져온 prefix는 Claude의 구조화 상태에 근거한 historical completion으로 신뢰하며 기본적으로 다시 실행하지 않는다. 첫 Codex-native 단계는 자기 prerequisite와 필요한 artifact를 정상 검증하고, 누락되었다면 완료를 발명하지 않고 fail 또는 blocked 처리한다. status는 imported completion과 Codex-verified completion의 수를 구분해 보여준다.

영수증은 불변이다.

- 동일 내용의 중복 complete는 idempotent하다.
- 같은 step에 다른 내용의 영수증이 있으면 blocked 상태로 전환한다.
- Step 50도 영수증을 먼저 내구성 있게 기록한 뒤 전체 completed 상태를 쓴다.

## 8. Claude에서 Codex로 가져오기

$webapp resume의 우선순위:

1. 유효한 Codex state.json이 있으면 그것을 재개한다.
2. Codex 상태가 없고 Claude step_archive/progress.json이 있으면 importer를 실행한다.
3. 둘 다 없으면 재개할 작업이 없다고 보고 $webapp <topic>을 안내한다.

Importer는 Claude 원본을 절대 수정하지 않는다.

1. progress.json 원시 바이트를 imports/에 복사한다.
2. 원본 SHA-256, 크기, 수정 시간 및 import 시간을 metadata에 기록한다.
3. UTF-8 BOM을 허용하고 JSON schema를 검증한다.
4. total_steps가 50인지 확인한다. 107-step 상태는 자동 매핑하지 않는다.
5. completed_steps의 정수 또는 숫자 문자열을 정규화하고, 모든 값이 1~50 범위인지 검증한 뒤 중복 제거와 정렬을 한다. 범위 밖 값은 버리지 않고 import 오류로 처리한다.
6. 1부터 끊기지 않은 가장 긴 prefix만 신뢰한다.
7. prefix 뒤에 기록된 sparse completion, 중복, current_step 불일치를 warning metadata로 보존하되 완료로 가져오지 않는다.
8. next step은 source current_step을 믿지 않고 prefix의 첫 gap으로 다시 계산한다.
9. TOPIC/TOPIC.md와 필요한 단계 정의가 존재하는지 확인한다.
10. legacy auto-continue state 파일과 transcript는 진행 증거로 사용하지 않는다.
11. eval_rounds의 오래된 49/69/104 값을 복사하지 않고 50단계 milestone 38/44/50 계약을 사용한다.
12. prefix별 import 영수증과 Codex state를 만든 후 Codex가 소유권을 넘겨받는다.

잘못된 JSON, total_steps 불일치, 범위를 벗어난 완료 번호, 필수 topic 부재처럼 안전하게 정규화할 수 없는 상태는 가져오지 않는다. 원본은 보존하고 import-error.json에 진단과 사용자 조치를 남기며 자동 진행을 시작하지 않는다. $harness50-status는 이 경우 source가 보존되었음을 알리고 수동 수정 또는 별도 workspace 사용을 안내한다. 반면 numeric string, duplicate, sparse completion, current_step mismatch는 위 규칙에 따라 contiguous historical prefix로 정규화하고 warning을 표시한다.

한번 import된 workflow에서 Claude progress가 나중에 바뀌어도 Codex는 자동 merge하지 않는다. live bidirectional synchronization은 v1 범위 밖이다.

## 9. 상태 관리자와 원자성

codex/scripts/harness-state.mjs와 내부 library가 .harness50-codex의 유일한 writer다. skill과 hook은 JSON 파일을 직접 수정하지 않고 다음 operation을 호출한다.

- init
- show
- import-claude
- begin
- complete
- fail
- pause
- resume
- reconcile
- reset
- hook continuation 및 ownership operation

모든 mutation은 다음 규칙을 따른다.

- run.lock을 exclusive create로 얻은 뒤 읽기, 검증, 쓰기를 수행한다.
- lock 대기에는 짧은 상한을 둔다.
- 같은 host의 owner process가 확실히 종료됐거나 lease가 안전하게 만료된 경우에만 stale lock을 보관 후 회수한다.
- state는 같은 directory의 temporary file에 쓰고 flush한 다음 rename한다.
- Windows의 일시적 rename 오류는 제한적으로 retry하며 기존 valid state를 보존한다.
- receipt는 exclusive create로 먼저 쓰고 state를 나중에 진척한다.
- crash 후 reconcile은 contiguous receipt에서 state를 앞으로 복구할 수 있지만 state나 transcript에서 receipt를 발명하지 않는다.

장기 실행 소유권은 state의 owner record와 갱신 가능한 lease로 관리한다. 다른 Codex session은 status를 읽을 수 있지만 lease가 유효한 동안 continuation을 발행하거나 같은 step을 완료할 수 없다. 명시적 $webapp resume은 이전 continuation token을 폐기하고 새 owner transfer를 기록한다.

각 자동 continuation에는 workflow ID, step, one-use nonce가 있다. begin이 nonce를 원자적으로 소비하고 attempt ID를 발행한다. complete와 fail은 현재 attempt ID가 일치해야 한다. replay, wrong workflow, wrong step 요청은 진척 없이 실패한다.

## 10. Codex 실행 흐름

각 continuation prompt는 정확히 한 단계만 실행하도록 요청한다.

1. $webapp <topic> 또는 resume이 상태를 준비하고 현재 step을 선택한다.
2. executor가 begin을 호출해 current step과 attempt ID를 확정한다.
3. codex/assets/steps/stepNNN.md 한 개를 읽는다.
4. 해당 단계의 작업과 acceptance verification을 수행한다.
5. 성공하면 complete, 실패하면 fail을 명시적으로 호출한다.
6. successful non-final step 뒤 Stop hook이 다음 step용 follow-up prompt를 만든다.
7. Step 50 receipt와 completed state가 저장되면 Stop hook은 자연 종료를 허용한다.

모델이 한 턴에서 미래 단계의 작업을 미리 수행하지 않도록 skill 계약에 명시한다. 이는 best-effort orchestration policy이며 훅이 모델 행동 전체를 sandbox할 수 있다고 주장하지 않는다. 강제 가능한 invariant는 state manager가 current step 하나만 완료로 받을 수 있고 receipt가 한 단계씩 연속 진척된다는 것이다. 테스트는 prompt와 state transition을 검증하며 모델이 미래 파일을 절대로 읽지 않는다고 주장하지 않는다.

### SessionStart

startup, resume, compact 이후 활성 workflow가 있으면 topic, status, completed count, first incomplete step, 정확한 resume instruction을 짧은 additional context로 제공한다. 완료 상태를 변경하지 않는다.

### UserPromptSubmit

running 중에 다음 중 하나가 아닌 실제 사용자 prompt가 들어오면 prompt를 막지 않고 자동 진행만 paused로 바꾼다.

- 현재 state에 저장된 유효한 continuation marker
- $webapp, $harness50-status, $harness50-reset의 명시적 제어 호출

사용자 직접 요청이 항상 자동 workflow보다 우선한다.

### Stop

receipt를 reconcile한 뒤 다음 중 하나를 수행한다.

- running이고 다음 단계가 있으며 retry 한도 이내면 decision=block과 다음 step reason을 반환해 Codex follow-up prompt를 만든다.
- paused, blocked, completed이면 빈 정상 결과를 반환하고 종료를 허용한다.
- state가 불일치하면 blocked_reason을 기록하고 continuation을 만들지 않는다.

turn_id로 같은 Stop 입력을 deduplicate한다. stop_hook_active가 true인데 새 receipt가 없으면 blind continuation을 반복하지 않고 unsuccessful attempt로 계산한다.

Stop이 생성한 prompt가 UserPromptSubmit을 통과할 때 marker, nonce, replay 방지가 하나의 통합 계약으로 동작해야 한다. 실제 host에서 이 전달 방식이 확인되지 않으면 자동 chain은 fail-safe로 pause하며 설치 smoke test를 성공으로 판정하지 않는다.

## 11. 오류 처리와 loop 방지

### 단계 실패

- 명시적 fail 또는 progress 없는 Stop을 같은 attempt의 한 번 실패로 기록한다.
- 같은 단계에서 성공하면 consecutive_failures를 0으로 초기화한다.
- 같은 단계가 세 번 연속 실패하면 status=blocked가 되고 Stop continuation을 중단한다.
- 사용자가 원인을 수정하고 $webapp resume을 실행하면 이전 history는 유지하되 새 3회 retry window를 시작한다.

### 손상 상태

- Claude source 오류는 Claude 파일을 보존하고 import-error.json만 쓴다.
- Codex state.json을 파싱할 수 없으면 자동 overwrite하지 않는다.
- valid receipt와 state 사이 crash gap은 reconcile로 복구한다.
- malformed, conflicting 또는 wrong-workflow receipt는 blocked 처리한다.

### 동시 실행

- active owner가 있으면 두 번째 session의 mutation을 거부하고 owner와 갱신 시각을 진단한다.
- expired owner는 안전한 조건을 만족할 때만 회수한다.
- 여러 process가 동시에 complete를 호출해도 하나만 성공해야 한다.

### reset

$harness50-reset은 Codex metadata만 .harness50-codex/backups/<timestamp>/에 복구 가능하게 보관한다. Claude progress.json, TOPIC, application source, outputs는 삭제하거나 수정하지 않는다. 따라서 기존 Claude 작업을 다시 가져올 수 있다.

## 12. 권한과 보안

Codex adapter는 기존 Claude auto-approve를 로드하지 않는다. .codex-plugin/plugin.json이 별도 hook 경로를 명시하는 이유가 이것이다.

PreToolUse guard는 deny-only다.

- permissionDecision=allow를 반환하지 않는다.
- PermissionRequest 승인 hook을 제공하지 않는다.
- Codex permission mode를 변경하지 않는다.
- hook trust를 자동으로 승인하거나 우회하지 않는다.
- 판단하지 않은 안전 명령은 아무 결정도 반환하지 않아 Codex 정상 권한 흐름에 맡긴다.

guard가 차단할 명백한 사례:

- filesystem root, home, workspace root 또는 workspace 밖을 대상으로 하는 recursive delete/move
- git reset --hard, git clean -fd 또는 user work 강제 교체
- .git metadata, credential store, private key, shell profile, Codex configuration에 대한 쓰기
- disk format, partition, shutdown/reboot 같은 system-level 명령
- workspace 밖으로 나가는 apply_patch target

guard는 defense in depth이며 완전한 shell sandbox라고 문서화하지 않는다. Codex가 제공하는 supported hook event와 tool input 범위 안에서만 보장한다.

설치 후 사용자는 /hooks에서 정확한 plugin hook 정의를 검토하고 신뢰해야 한다. --dangerously-bypass-hook-trust는 사용하지 않는다.

## 13. 테스트 전략

### 기존 Claude 회귀

- active 사용자 working tree에서는 read-only 정적 검사를 먼저 수행한다.
- 실행형 Claude 테스트는 현재 파일을 보존한 격리된 임시 copy에서 실행한다.
- 기존 /webapp, progress 및 security behavior가 Codex 추가로 깨지지 않았는지 확인한다.
- 실행 전후 active working tree의 사용자 소유 미커밋 파일 hash가 동일한지 확인한다.
- Claude hook fixture를 Codex 계약으로 재사용하지 않는다. Codex behavior는 별도의 Codex fixture로 검증한다.

### package 및 static test

- .codex-plugin/plugin.json schema, name, version, relative path 검증
- manifest의 hooks 값이 정확히 ./codex/hooks/hooks.json이고 설치된 package root 안에서 그 파일로 resolve되는지 검증
- 세 skill frontmatter와 참조 파일 검증
- codex/hooks/hooks.json event와 command path 검증
- Claude와 Codex 양쪽의 정확한 50개 연속 step 검증
- index의 source hash 및 1:1 mapping 검증
- Codex 실행 문서에서 Claude-only tool/model/path와 stale 69/104/107 reference 금지

### state machine test

- init, import, begin, complete, fail, pause, resume, reconcile, reset
- contiguous prefix와 first-gap 계산
- numeric string, duplicate, sparse completion과 current_step mismatch
- malformed JSON, wrong total, missing topic
- imported receipt provenance
- receipt-first Step 50 completion
- idempotent duplicate 및 conflicting receipt
- crash between receipt and state
- stale lock, current owner conflict, multi-process concurrency
- 3회 실패 block과 explicit resume retry window

### hook fixture test

Codex 문서화 JSON fixture를 Windows와 POSIX path로 실행한다.

- SessionStart: startup, resume, compact, missing/completed/corrupt state
- UserPromptSubmit: valid marker, replay, direct user prompt, control skill
- Stop: normal advance, no-progress retry, duplicate turn, stop_hook_active, third failure, Step 50
- PreToolUse: PowerShell, cmd.exe, POSIX shell, apply_patch, traversal, quoted path, benign command

각 fixture는 exit code, stdout JSON schema, state mutation 및 unexpected allow 부재를 검증한다.

### workflow simulation

- Claude 1~17 완료 fixture를 Codex로 import하고 18~50을 완주한다.
- 50개 receipt를 state-only로 순서대로 생성해 completed invariant를 확인한다.
- interruption, compaction, application restart, pause/resume, ownership conflict를 재현한다.
- 대표 단계 1, 16, 30, 38, 45, 50은 실제 artifact contract까지 통합 검증한다.

CI에서 실제 웹앱을 매번 50단계 전체 생성하지 않는다. 상태 전이는 50/50 전체를 검증하고, 실제 파일 및 도구 integration은 대표 단계에서 검증한다.

### 설치 smoke test

1. 같은 harness50 checkout을 local/personal marketplace source로 연결한다.
2. 새 Codex session에서 harness50 plugin을 발견하는지 확인한다.
3. $webapp, $harness50-status, $harness50-reset이 노출되는지 확인한다.
4. pending-trust 상태에서 Codex 전용 hook이 표시되지만 실행되지 않는지 확인한다.
5. 사용자가 /hooks에서 현재 정의를 검토하고 신뢰한 뒤 같은 hook이 실제로 활성화되는지 다시 확인한다.
6. 깨끗한 임시 Git workspace에서 작은 topic으로 시작한다.
7. generated Stop prompt가 UserPromptSubmit marker를 통과하고 nonce replay는 거부되는지 확인한다.
8. one-step continuation request, status, pause/resume, destructive deny 및 normal permission prompt를 확인한다.
9. Claude partial-state import를 실제 host에서 한 번 검증한다.

## 14. 완료 기준

1. 하나의 harness50 저장소가 Claude manifest와 Codex manifest를 함께 가진다.
2. Claude /webapp과 기존 hook/test behavior가 유지된다.
3. Codex에서 세 skill이 새 session에 노출된다.
4. $webapp <topic>과 각 continuation이 한 단계 실행을 명시적으로 요청하고, state manager는 current step 하나의 receipt만 받아 한 단계씩 진척된다. 이는 모델의 모든 행동을 sandbox한다는 보장이 아니다.
5. $webapp resume이 Claude의 contiguous completed prefix를 가져와 첫 gap부터 계속한다.
6. imported receipt가 historical Claude provenance로 표시되고 Codex-native verification과 구분된다.
7. Codex가 Claude progress.json을 변경하지 않는다.
8. interruption, compact, restart 후 완료를 잃거나 만들어내지 않는다.
9. Step 50 receipt보다 completed state가 먼저 기록될 수 없다.
10. 같은 step 세 번 실패 시 무한 반복 대신 blocked 상태가 된다.
11. 두 session이 같은 step을 동시에 완료할 수 없다.
12. 설치된 manifest가 Codex 전용 hook path만 resolve한다.
13. plugin은 명령, permission request 또는 hook trust를 자동 승인하지 않는다.
14. pending-trust와 trusted-hook 상태를 모두 검증한다.
15. deny-only guard의 명시된 파괴 사례가 execution 전에 차단된다.
16. safe command는 hook에 의해 자동 승인되지 않고 정상 Codex permission flow를 따른다.
17. 구조, 상태, hook, security, concurrency, simulation, Claude regression 및 install smoke test가 통과한다.
18. 현재 사용자 소유 미커밋 변경은 보존된다.

## 15. 구현 순서 제약

향후 구현 계획은 다음 순서를 지킨다.

1. 별도 worktree 또는 사용자 변경과 충돌하지 않는 격리 전략을 확정한다.
2. Codex package/static test와 step mapping contract를 먼저 만든다.
3. state manager와 importer를 test-first로 구현한다.
4. hook을 fixture test에 맞춰 구현하고 실제 설치 전까지 활성화하지 않는다.
5. 50개 step을 review 가능한 batch로 변환한다.
6. skill과 manifest를 연결한다.
7. 전체 자동 test를 통과시킨다.
8. 기존 marketplace/config를 읽고 merge 방식으로 local install한다.
9. 사용자의 정상 /hooks 신뢰 검토 후 fresh-session smoke test를 수행한다.

어떤 구현 단계도 테스트를 통과시키기 위해 자동 승인, hook trust 우회, Claude 상태 덮어쓰기 또는 의미 없는 완료 영수증을 허용해서는 안 된다.
