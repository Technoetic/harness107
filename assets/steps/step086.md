---
name: step086
persistence: session
---

# Step 86 - Playwright 스크린샷 기반 상세 E2E 테스트

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-086.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step086_*.md` 저장 후 1줄 완료 보고 `Step 086/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

## Step-Back

실행 전에 먼저 답하라:
- 이 테스트의 핵심 목적은? (한 문장)
- 테스트 실패 시 어느 Step으로 돌아가야 하는가?
- 반드시 확인해야 할 엣지 케이스 2가지는?

프로젝트 특성을 분석하여 테스트 범위와 검증 항목을 동적으로 결정한다.

Playwright를 사용하여 스크린샷을 촬영하며 상세한 E2E 테스트를 수행한다.
"웹 앱"이 아니면 프로젝트 유형에 적합한 스크린샷 기반 테스트를 수행한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개).

**스크린샷 E2E 테스트 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

서브에이전트는 항상 haiku를 사용한다.

## 결과 저장

결과를 step_archive/screenshots/e2e/에 저장한다.



## Self-Calibration

테스트 완료 후:
- 모든 테스트가 통과했는가? (Y/N)
- Step-Back에서 정의한 엣지 케이스가 모두 커버되었는가? (Y/N)
- N이면 재실행한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step087.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


