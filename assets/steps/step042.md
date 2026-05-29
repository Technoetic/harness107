---
name: step042
persistence: session
---

# Step 42 - CSS 파일 분리 (컨텍스트 최적화)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-042.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step042_*.md` 저장 후 1줄 완료 보고 `Step 042/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간


컴포넌트화된 HTML 구조에 맞춰 CSS를 **최대한** 분리하고 구조화한다.

## 파일 구조 규칙

- CSS는 `src/css/*.css` 로 분리 유지
- `src/index.html`에서 `<link rel="stylesheet" href="css/...">` 로 참조
- **`<style>` 태그 인라인 삽입 금지** — 빌드 시 html-bundler.ps1이 자동 번들링

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) CSS 파일 분리를 수행한다.

**CSS 분리 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

서브에이전트는 항상 haiku를 사용한다.


## Budget Forcing

서브에이전트가 구현을 너무 빨리 완료하려 할 때 다음을 강제한다:
- 구현 완료 선언 전에 "빠뜨린 엣지 케이스가 없는가?" 를 반드시 검토한다
- 검토 없이 완료 선언 시 해당 서브에이전트는 재실행한다

## Self-Calibration

구현 완료 후 다음을 스스로 평가하라:
- 요구사항이 100% 구현되었는가? (Y/N)
- 빌드가 통과하는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step043.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


