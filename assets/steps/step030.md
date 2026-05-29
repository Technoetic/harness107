---
name: step030
persistence: session
---

# Step 30 - 통합 설계 (레이아웃 + 전체)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-030.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step030_*.md` 저장 후 1줄 완료 보고 `Step 030/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

## 🚨 절대 규칙 (Hook이 자동 차단)

이 Step의 **첫 번째 도구 호출은 반드시**:

```
Skill(skill="superpowers:brainstorming")
```

이 호출 전에는 Write/Edit/Bash/Task 등 어떤 도구도 사용 금지.
`.claude/hooks/brainstorming-gate.ps1`이 자동으로 차단하며, 호출 확인 시 `step_archive/.brainstorming-fired-030` 플래그를 생성해 이후 통과시킨다.

## Step-Back

설계 전에 먼저 답하라:
- 이 설계가 해결해야 할 핵심 문제는? (한 문장)
- 조사/기획 결과에서 반드시 반영해야 할 제약 조건은?

## 실행 내용

step025 기획 결과를 기반으로 레이아웃 설계와 전체 설계를 superpowers:brainstorming에 진입하여 레이아웃을 포함한 전체 설계 문서를 작성한다.

**설계 시작 전 반드시 `step_archive/TOPIC/TOPIC.md`를 Read한다.** 인터랙티브 요구(`interactive`), 타깃(`audience`), 대중 앱 사례(`real_world_apps`)가 레이아웃·인터랙션 설계에 반영되어야 한다. 단, brainstorming 스킬의 사용자 옵션 질문은 `NEW-WORK-규칙.md` 2번에 따라 금지하고, 결정을 즉시 내려 설계 문서에 사유와 함께 기록한다.

**필요한 파일:**

- `step_archive/TOPIC/TOPIC.md` (필수, 가장 먼저 Read)

- step025_planning_chunk*.md (기획 결과)

**설계 범위:**

- 레이아웃 구조, 배치, 비율, 반응형 브레이크포인트
- 전체 아키텍처, 클래스 구조, 모듈 설계
- 위 항목을 하나의 설계 문서로 통합

**Class 지향으로 설계한다.** 그리고 **비동기(async)로 설계한다.**

### Class 지향 설계 원칙

- 모든 주요 기능 모듈은 **ES6+ Class**로 정의한다 (예: `LayoutManager`, `AnimationController`, `DataLoader`).
- Class는 **단일 책임 원칙(SRP)**을 따른다 — 한 Class는 하나의 명확한 책임만 가진다.
- **상속(extends)보다 합성(composition)을 우선**한다. 공통 동작은 Mixin 또는 베이스 Class로 분리한다.
- 외부 노출 API는 **public 메서드**로 명시하고, 내부 구현은 `#privateField` 또는 `_privateMethod` 컨벤션으로 캡슐화한다.
- 전역 변수·전역 함수 금지. 모든 상태는 **Class 인스턴스의 필드**로 관리한다.
- 의존성은 **생성자 주입(Constructor Injection)** 방식으로 받는다. `new Foo(dep1, dep2)` — 내부에서 `new` 직접 호출 금지.
- Class 간 통신은 **EventTarget / CustomEvent** 또는 **명시적 메서드 호출**로 한다. 암묵적 전역 상태 공유 금지.

### 비동기 설계 원칙

- 모든 I/O·네트워크·DOM 로딩·애니메이션·타이머 작업은 **async/await + Promise**로 처리한다.
- Class의 초기화는 **`async init()` 패턴**을 사용한다 — 생성자는 동기로 가볍게 유지하고, 무거운 초기화는 `await instance.init()`로 분리.
- 콜백 헬(callback hell) 금지. **Promise 체인**도 가급적 피하고 **async/await**로 통일한다.
- 병렬 처리가 가능한 작업은 **`Promise.all([...])`** 또는 **`Promise.allSettled([...])`**로 동시 실행한다.
- 에러 처리는 **try/catch**로 명시적으로 한다. unhandled rejection 금지.
- 취소 가능한 비동기 작업은 **AbortController/AbortSignal**을 지원한다.
- 무거운 동기 연산은 **`requestIdleCallback`** 또는 **Web Worker**로 오프로드한다.
- 이벤트 리스너도 가능한 한 **passive: true** 옵션과 **debounce/throttle**를 적용한다.

### 설계 문서에 반드시 포함할 내용

- 각 Class의 **클래스 다이어그램** (Mermaid 또는 ASCII 아트)
- 각 Class의 **public API 시그니처** (async 여부 명시: `async loadData(): Promise<Data>`)
- Class 간 **의존 관계도**
- 주요 **비동기 흐름의 시퀀스 다이어그램**
- 초기화 순서: `new` → `await init()` → `await start()` 등의 라이프사이클 명시

## 설계 대안 비교 (ToT)

단일 설계안을 바로 확정하지 않는다. 다음 순서로 진행한다.

### 1단계: 설계 대안 3개 생성 (에이전트 A)

에이전트 A가 기획 결과를 기반으로 **레이아웃 설계안 A/B/C**를 생성한다.
- 각 안은 레이아웃 구조, 모듈 분리 방식, 반응형 전략이 서로 달라야 한다.
- 결과: `step_archive/outputs/step030_설계대안.md`

### 2단계: 트레이드오프 비교 및 선택 (에이전트 B)

에이전트 B가 3개 안을 다음 기준으로 비교하고 **1개를 선택**한다. (수정 금지, 선택만)
- 유지보수성 (Class 구조 명확성)
- 반응형 구현 난이도
- Awwwards 조사 반영도 (step023/step024 결과 참조)

결과: `step_archive/outputs/step030_설계선택.md` — 선택된 안과 이유 명시

### 3단계: 선택된 안으로 최종 설계 문서 작성 (에이전트 A)

에이전트 B가 선택한 안을 기반으로 최종 설계 문서를 작성한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용해야 한다 (동시 실행 최대 10개).

**설계 결과는 청크 단위로 저장한다:**

```text
step030_레이아웃설계_chunk1.md (500줄 이하)
step030_전체설계_chunk1.md (500줄 이하)
step030_전체설계_chunk2.md (500줄 이하)
...
```text

**작성 규칙**:

- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 sonnet을 사용한다.


## CoVe (Chain-of-Verification)

설계 완료 후:
- [ ] 조사/기획의 모든 요구사항이 설계에 반영되었는가?
- [ ] 구현 가능한 설계인가?
- [ ] 이전 실패 패턴을 반복하지 않는가?

## Self-Calibration

- 이 설계를 그대로 구현해도 되는가? (Y/N)
- N이면 해당 부분을 재설계한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step031.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


