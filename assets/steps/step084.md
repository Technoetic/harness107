---
name: step084
persistence: session
---

# Step 84 - 테스트 환경 프리플라이트

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-084.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step084_*.md` 저장 후 1줄 완료 보고 `Step 084/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

테스트 Phase 진입 전 모든 테스트 도구의 설치 상태와 설정 유효성을 검증한다.

## 실행 내용

### 1. Playwright 환경 검증

1. 브라우저 설치 확인: `npx playwright install --check chromium`
2. 테스트 설정 파일 확인: playwright.config.js 존재 여부
3. smoke test: `npx playwright test --list`

### 2. axe-core 접근성 도구 확인

`node -e "require('@axe-core/playwright')"` 실행. 실패 시 `npm i -D @axe-core/playwright` 자동 설치.

### 3. 성능 테스트 도구 확인

`npx lhci --version` 실행. 실패 시 경고만 기록.

### 4. dist/index.html 서빙 가능 여부

dist/index.html 파일 존재 확인. 없으면 Step 38 빌드 스모크 테스트를 먼저 실행하라고 안내.

### 5. 베이스라인 존재 확인

step_archive/baseline.json 존재 확인. 없으면 Step 063이 미완료일 수 있다고 경고.

### 6. 실패 처리

| 검증 | 실패 시 |
|:---|:---|
| Playwright 브라우저 | npx playwright install chromium (자동 설치, 최대 3회) |
| playwright.config.js | 사용자 개입 요청 |
| dist/index.html | Step 38 재실행 안내 |
| axe-core | npm 자동 설치 |
| lhci | 경고만, 진행 허용 |

### 7. 완료 기준

- Playwright 브라우저 실행 가능
- dist/index.html 존재
- 위 2개 모두 통과해야 다음 Step 진행 가능

서브에이전트는 항상 haiku를 사용한다.

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step085.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


