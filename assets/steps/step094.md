---
name: step094
persistence: session
---

# Step 94 - UI 회귀 테스트 (독립 검증 루프)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-094.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step094_*.md` 저장 후 1줄 완료 보고 `Step 094/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

UI 회귀 테스트를 구현한다.
웹 앱이 아니면 프로젝트 유형에 적합한 스냅샷/UI 회귀 테스트를 수행한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개).

**시각적 회귀 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

## 핵심 원칙: 작성 에이전트 ≠ 검증 에이전트

- **에이전트 B (검증 전문)**: Sonnet - 회귀 판정, 스냅샷 분석, 합격/불합격 결정만 담당. **코드 수정 금지**
- **에이전트 A (수정 전문)**: Sonnet - 에이전트 B의 판정에 따라 코드만 수정. **합격/불합격 판정 금지**

이 분리를 통해 검증자의 편견 없는 판정과 수정자의 빠른 피드백 루프를 보장한다.

---

## 검증 절차

### 1단계: 에이전트 B의 역할 (검증)

`.claude/hooks/ui-regression-validator.ps1`에서 자동 검증:
- 스냅샷 비교 수행
- **PASS/FAIL 판정만 수행** — **코드 수정 금지**
- 판정 결과:
  - **PASS**: 회귀 없음 → 종료
  - **FAIL**: 차이 분석 결과를 에이전트 A에 전달

### 2단계: 에이전트 A의 역할 (수정)

1. 에이전트 B의 FAIL 판정과 차이 분석 결과를 받는다 (test-results/, __diff_output__/)
2. **코드만 수정한다** — 회귀 원인 수정
3. UI 회귀 테스트 재실행
4. 결과를 에이전트 B에 전달

### 3단계: 반복 제한: 무한 반복 + 스마트 탈출

회차 제한 없이 PASS가 나올 때까지 반복한다.

**탈출 조건:**
1. **PASS** → 즉시 종료
2. **동일 항목 3연속 [미수정]** → 해당 항목만 스킵 처리하고 나머지 계속
3. **모든 FAIL 항목이 스킵 상태** → 종료 (스킵 사유 기록)

## 실패 패턴 기록

종료 시 (PASS 또는 스킵) `step_archive/progress.json`의 `failure_patterns` 배열에 FAIL 항목을 추가한다.
- PASS로 종료된 경우에도 도중 FAIL이 있었던 항목은 기록한다.
- 형식: `{ "step": 94, "항목": "FAIL 항목 요약", "해결": true/false }`

- **에이전트 B (검증)**: sonnet 사용 - 회귀 검증 담당
- **에이전트 A (수정)**: sonnet 사용 - 코드 수정 담당

## 결과 저장

결과를 step_archive/outputs/step094_회귀검증_rN.md에 저장한다.

---

이 지침을 완료한 즉시 자동으로 step095.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


