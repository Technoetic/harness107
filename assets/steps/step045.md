---
name: step045
persistence: session
---

# Step 45 - E2E 테스트

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-045.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step045_*.md` 저장 후 1줄 완료 보고 `Step 045/50 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: E2E 검증 구간 (최종 게이트 step050)

## 사전 체크 (구 step084 프리플라이트 흡수)

E2E 시작 전 아래를 확인하고, 미비하면 사용자에게 묻지 않고 즉시 조치한다.

1. Playwright 브라우저: `npx.cmd playwright install --check chromium` — 실패 시 `npx.cmd playwright install chromium` (최대 3회)
2. `playwright.config.js` 존재 — 없으면 프로젝트 구조에 맞게 직접 생성한다
3. `dist/index.html` 존재 — 없으면 `npm.cmd run build`를 먼저 실행한다
4. 별도 테스트 파일 매핑 단계가 없으므로, E2E 테스트 스펙은 이 단계에서 직접 작성한다

## Step-Back

실행 전에 먼저 답하라:
- 이 테스트의 핵심 목적은? (한 문장)
- 테스트 실패 시 어느 Step으로 돌아가야 하는가?
- 반드시 확인해야 할 엣지 케이스 2가지는?

프로젝트 특성을 분석하여 테스트 범위와 검증 항목을 동적으로 결정한다.

Playwright를 사용하여 E2E 테스트를 수행한다.
"웹 앱"이 아니면 프로젝트 유형에 적합한 E2E 테스트를 수행한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개).

**E2E 테스트 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**검증:**
- `npx playwright test` 실행 결과 전체 PASS로 직접 검증 (구 e2e-validator.ps1은 retired — 2026-06-10 M07 정정)

**검증 실패 시:**
- 실패한 테스트 케이스 분석
- 테스트 실패 원인 수정
- 검증 통과할 때까지 반복

서브에이전트는 항상 haiku를 사용한다.

## 결과 저장

결과를 step_archive/step045_e2e테스트결과.md에 저장한다.


## Self-Calibration

테스트 완료 후:
- 모든 테스트가 통과했는가? (Y/N)
- Step-Back에서 정의한 엣지 케이스가 모두 커버되었는가? (Y/N)
- N이면 재실행한다.

---

이 지침을 완료한 즉시 자동으로 step046.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


