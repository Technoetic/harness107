---
name: step029
persistence: session
---

# Step 29 - 기획 보강: Awwwards UX/UI·레이아웃 조사결과

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-029.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step029_*.md` 저장 후 1줄 완료 보고 `Step 029/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

## Memory-of-Thought

기획 전에 다음을 확인하라:
- step_archive/progress.json의 failure_patterns — 이전에 실패한 패턴을 반복하지 않는다
- 이전 기획 Step의 결과 파일 — 중복되거나 상충되는 내용이 없는지 확인한다
- 성공한 기획 패턴이 있으면 재활용한다

## 실행 내용

step025 기획 초안에 Awwwards 통합 조사결과를 반영하여 UX/UI·레이아웃 관련 기획을 보강한다.

**필요한 파일:**

- step025_planning_chunk*.md (기획 초안)
- step023_조사결과_chunk*.md (Awwwards 디자인 패턴 분석 결과)

step025 기획 초안을 읽고, Awwwards 조사결과에서 반영할 내용을 식별하여 기획 문서를 업데이트한다.

**보강 방법:**

1. Awwwards 조사결과에서 도출된 조사 축 목록을 확인한다.
2. 각 조사 축에서 비교된 대안들을 검토한다.
3. step025 기획의 기능 요구사항과 대상 사용자를 기준으로, 각 대안의 적합도를 평가한다.
4. 조사 축마다 최적안을 선정하고 근거를 명시한다.
5. 레이아웃 구조, UX/UI 패턴, 인터랙션, 시각 디자인 결정사항을 기획에 통합한다.
6. 텍스트 기반 와이어프레임을 작성한다.

**보강 축 생성 규칙:**

- Awwwards 조사에서 도출된 조사 축을 그대로 보강 축으로 사용한다
- 사전에 고정된 축 목록을 사용하지 않는다
- 조사 축에 없는 항목을 임의로 추가하지 않는다

**보강 원칙:**

- 기존 기획의 결정사항을 무효화하지 않는다 — 보강만 한다
- Awwwards 조사결과에 없는 대안을 임의로 도입하지 않는다
- 보강된 결과를 step025_planning_chunk*.md에 덮어쓴다

Class 지향으로 기획한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용해야 한다 (동시 실행 최대 10개).

**보강된 기획 결과는 기존 청크를 덮어쓴다:**

```text
step025_planning_chunk1.md (500줄 이하)
step025_planning_chunk2.md (500줄 이하)
step025_planning_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:

- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 haiku를 사용한다.


## Self-Calibration

기획 완료 후 다음을 스스로 평가하라:
- 이전 실패 패턴을 피하고 있는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step030.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


