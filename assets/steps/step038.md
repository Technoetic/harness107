---
name: step038
persistence: session
---

# Step 38 - 빌드 스모크 테스트 (구현 완료 게이트)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-038.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step038_*.md` 저장 후 1줄 완료 보고 `Step 038/50 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: 구현·정리 구간 (E2E 검증 step045 전)

Step 37 구현이 완료된 후, 다음 단계로 진행하기 전 빌드 안전성을 검증하는 필수 게이트이다.

## 실행 내용

### 1. 빌드 검증 (필수 — 실패 시 차단)

다음을 순서대로 실행한다. 하나라도 실패하면 다음 Step으로 진행하지 않는다.

1. HTML 번들링: `step_archive/tools/html-bundler.ps1` 실행 (macOS/Linux는 `bash step_archive/tools/html-bundler.sh`)
2. dist/index.html 유효성: 직접 검사 — 파일 존재 + 크기 > 0 + `<html`/`</html>` 포함 확인
   (구 build-validator.ps1은 retired — 2026-06-10 하네스 감사 M07 정정)
3. 순환 의존성: `npx madge --circular src/` 실행

### 2. 린트/포매팅 검증 (경고 — 실패해도 진행)

1. Biome 포매팅+린팅: `npx biome check src/`
2. Stylelint CSS 검사: `npx stylelint "src/css/*.css"`
3. 타입 체크: jsconfig.json 기반

### 3. 실패 시 대응

| 검증 | 실패 시 |
|:---|:---|
| html-bundler.ps1 | Step 37 재실행 (src/ 구조 문제) |
| dist/index.html 직접 검사 | dist/index.html 수정 후 재검증 (최대 3회) |
| madge 순환 의존성 | 순환 고리를 구체적으로 보고, Step 37 서브에이전트로 수정 |
| biome/stylelint | 경고만 기록, 진행 허용 |
| tsc | 경고만 기록, 진행 허용 |

### 4. 완료 기준

- dist/index.html 존재 + 유효한 HTML 구조
- 순환 의존성 0개
- 위 2개 모두 통과해야 다음 Step 진행 가능

### 5. 결과 기록

step_archive/step038_smoke_test.md에 결과를 저장한다.

### 실제 품질 게이트

플러그인의 `docs/QUALITY.md`를 읽고 프로젝트에 `harness50.quality.json`을 구성한다.
실제 테스트·린트·타입·보안 명령과 커버리지 보고서 경로를 지정하며 성공을 흉내 내는
명령은 사용하지 않는다. `node "<plugin-root>/scripts/quality-gate.mjs" --workspace
"<project-root>"`를 정상 권한으로 실행한다. 종료 코드 0과 `quality-gate.json`의 PASS를
확인해야 이 마일스톤을 완료할 수 있다. 도구 미설치, 검사 실패, 커버리지 미달은 완료가 아니다.

서브에이전트는 항상 haiku를 사용한다.

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

## CoVe (Chain-of-Verification)

검증 완료 후 체크리스트:
- [ ] 검증 기준이 모두 통과되었는가?
- [ ] 예외 케이스가 누락되지 않았는가?
- [ ] 검증 결과가 다음 Step에서 참조 가능한 형식으로 저장되었는가?

## Self-Calibration

- 이 검증 결과를 신뢰할 수 있는가? (Y/N)
- N이면 검증을 재실행한다.

---

이 지침을 완료한 즉시 자동으로 step039.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.

