---
name: step037
persistence: session
---

# Step 37 - 구현

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-037.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step037_*.md` 저장 후 1줄 완료 보고 `Step 037/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

**참조 파일:**

- `step_archive/TOPIC/TOPIC.md` (튜토리얼 주제 — **필수. 구현 서브에이전트 모두에게 본 파일 경로를 프롬프트로 전달한다**)
- step032_파일인덱스_chunk*.md

## 실행 내용

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) step030_레이아웃설계_chunk*.md (레이아웃 설계)와 step030_전체설계_chunk*.md (전체 설계)를 구현한다.

**모든 구현 서브에이전트 프롬프트의 첫 문단에 다음을 포함한다:**

> "먼저 `step_archive/TOPIC/TOPIC.md`를 Read하여 튜토리얼 주제·타깃·인터랙티브 요구·대중 앱 사례를 파악한다. 본 주제와 무관한 콘텐츠를 생성하지 마라. `audience`가 초보자이면 전문 용어 즉시 풀어 설명하고, `interactive`가 필수이면 모든 핵심 개념마다 사용자가 직접 조작 가능한 위젯(슬라이더·입력·실행 버튼)을 1개 이상 배치한다. `real_world_apps`의 사례는 본문 예시에 1개 이상 반영한다."

Class 지향으로 구현한다.

## 🚨 필수: CSS 작성 시 Awwwards 조사 결과 참조

CSS를 작성하는 서브에이전트에게는 반드시 아래 지시를 포함한다:

1. `step_archive/screenshots/research/awwwards-*.png` 패턴으로 Glob 검색하여 **모두** Read할 것
2. `step_archive/awwwards-*.txt` 패턴으로 Glob 검색하여 **모두** Read할 것
3. 스크린샷에서 직접 디자인 패턴을 추출하여 CSS에 반영할 것

CSS 담당 서브에이전트는 스크린샷을 읽어야 하므로 **haiku를 사용하지 않는다** (sonnet 이상 사용).

그 외 서브에이전트(JS, HTML)는 haiku를 사용한다.

**구현 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

## 구현 완료 후 자동 검증

구현이 완료되면 다음 Step(step038 빌드 스모크 테스트)에서 빌드 안전성을 자동 검증한다.
Step 38에서 빌드 실패 시 이 Step으로 돌아와 수정한다.

## Budget Forcing

서브에이전트가 구현을 너무 빨리 완료하려 할 때 다음을 강제한다:
- 구현 완료 선언 전에 "빠뜨린 엣지 케이스가 없는가?" 를 반드시 검토한다
- 검토 없이 완료 선언 시 해당 서브에이전트는 재실행한다

## Self-Calibration

구현 완료 후 다음을 스스로 평가하라:
- 요구사항이 100% 구현되었는가? (Y/N)
- 빌드가 통과하는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step038.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


