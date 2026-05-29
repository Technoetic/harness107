---
name: step020
persistence: session
---

# Step 20 - Awwwards 사이트 선정

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-020.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step020_*.md` 저장 후 1줄 완료 보고 `Step 020/107 완료`.
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

step016 전체 조사결과를 기반으로, Awwwards 수상작 중 방문할 사이트를 선정한다.

**필요한 파일:**

- step016_조사결과_chunk*.md (전체 조사결과)

## 선정 절차

사전에 고정된 선정 기준을 사용하지 않는다. 다음 절차로 동적으로 결정한다:

1. step016_조사결과_chunk*.md에서 프로젝트의 핵심 특성을 추출한다 (유형, 기능, 대상 사용자, UI 구성 요소)
2. 추출된 특성마다 "이 특성을 잘 구현한 Awwwards 수상작은?" 질문을 생성한다
3. 질문별로 관련 사이트를 탐색한다
4. **특정 카테고리를 사전에 배제하지 않는다** — 프로젝트 특성과의 관련성만으로 판단한다
5. 선정 이유를 사이트별로 명시한다 ("이 사이트를 선정한 이유: 프로젝트의 X 특성과 Y가 유사")

## 결과 저장

`step_archive/step020_선정URL.md`에 저장한다:

```markdown
## Awwwards 선정 URL 목록

## URL 1: https://example.com
- 선정 이유: ...
- 조사할 뷰포트: desktop, tablet, mobile

## URL 2: ...
```text

서브에이전트는 haiku를 사용한다.


## Self-Calibration

기획 완료 후 다음을 스스로 평가하라:
- 이전 실패 패턴을 피하고 있는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step021.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


