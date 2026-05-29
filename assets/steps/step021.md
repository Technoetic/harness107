---
name: step021
persistence: session
---

# Step 21 - 의존성 게이트 검증

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-021.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step021_*.md` 저장 후 1줄 완료 보고 `Step 021/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

각 Step 실행 전 선행 파일이 존재하는지 자동 검증하는 게이트를 활성화한다.

## 실행 내용

### 1. step-deps.json 검증

step_archive/step-deps.json이 존재하는지 확인한다.
존재하면 내용을 로드하여 각 Step의 선행 파일 목록을 확인한다.

### 2. 이전 Phase 완료 검증

Phase 1 (초기화, step002~step020)의 핵심 산출물이 존재하는지 확인한다:

- step_archive/step001_preflight.md (프리플라이트 결과)
- package.json (npm 의존성 설정)
- node_modules/ 디렉토리 존재

하나라도 없으면 해당 Step을 먼저 실행하도록 안내한다.

### 3. 이후 Step에 대한 게이트 규칙

이후 모든 Step은 실행 시작 전 다음을 자동 수행한다:

1. step-deps.json에서 해당 Step의 required_files 확인
2. 와일드카드 패턴(*)은 Glob으로 확인 (최소 1개 매칭 필요)
3. 고정 경로는 직접 존재 확인
4. **누락 파일이 있으면**: 어떤 선행 Step이 미완료인지 보고하고, 해당 Step부터 재실행

이 검증은 .claude/hooks/step-dependency-gate.ps1이 PreToolUse 훅으로 자동 수행한다.

### 4. 결과 기록

검증 결과를 step_archive/step021_gate_status.md에 저장한다.

서브에이전트는 항상 haiku를 사용한다.

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step022.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


