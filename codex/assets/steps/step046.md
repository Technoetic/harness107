---
name: step046
phase: e2e
---

# Step 46 - Playwright 스크린샷 기반 상세 E2E 테스트

## 목표

선택된 디자인과 현재 layout 검증을 기준으로 실제 화면·뷰포트·상태 조합을 실행하고,
스크린샷과 동작 증거를 함께 독립 검증한다.

## 입력과 산출물

- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/outputs/step039_검증_r1.md`
- 입력: `step_archive/step044_html컴포넌트화.md`
- 입력: `step_archive/outputs/trust5_r2.md`
- 입력: `step_archive/step045_e2e테스트결과.md`
- 필수 선행 항목: `step030`, `step038`, `step039`, `step044`, `step045`
- 산출물: `step_archive/step046_screenshot_e2e.md`
- 산출물: `step_archive/screenshots/e2e/step046-primary.png`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수다.

## 실행 역할

가능한 경우 상세 E2E 실행·보정자 역할과 상세 E2E 독립 검증자 역할을 서로 다른 실행
주체에 맡긴다. 실행·보정자는 test와 application의 관찰된 결함만 고치며, 독립 검증자는
산출물과 application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재
실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지
않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 화면·뷰포트·상태 행렬

30단계의 responsive·interaction 설계와 39단계의 layout 검증 증거에서 실제 viewport,
screen과 state를 추출한다. 반응형 breakpoint, 도달 가능한 화면, loading·empty·error·
disabled·active 같은 의미 있는 상태를 빠짐없이 조합해 `viewport × screen × state`
matrix를 만든다. 적용되지 않는 조합은 application evidence와 이유를 남기며, 단순한
시간 절약을 이유로 제외하지 않는다.

각 조합의 진입 전제, action, expected behavior, screenshot path와 검증 결과를 보고서
manifest에 고정한다. primary 조합은 최종 상태를
`step_archive/screenshots/e2e/step046-primary.png`에 저장한다.

## 스크린샷 E2E와 시각 검증

project manifest에 선언되어 acceptance pattern과 일치하는 정확한 E2E script를 로컬
Playwright로 실행하고 exit code 0만 성공으로 인정한다. matrix의 모든 조합을 실행해
최종 screenshot을 저장하며 primary 결과는
`step_archive/screenshots/e2e/step046-primary.png`에 둔다. 독립 검증자는 matrix의
모든 최종 screenshot을 실제로 열어 expected behavior, layout, content, responsive
transition과 state feedback을 비교한다.

결정적 DOM, layout, 접근성 및 file 검사는 실제로 이미지를 여는 시각 검사를 대체하지
못한다. 시각 검사 기능을 사용할 수 없으면 차단한다. 필수 입력, 필수 증거 또는 실행
capability가 없거나 사용할 수 없으면 차단한다.

최대 5라운드 동안 독립 검증자의 `FAIL`을 실행·보정자가 최소 변경으로 고치고 모든
영향 조합을 재실행·재촬영한다. `Critical` 또는 `Important` finding이 하나라도
미해결이면 차단한다. 모든 조합과 시각 판정이 증거와 함께 `PASS`인 경우에만 완료한다.
스킵이나 미해결 finding은 통과 또는 완료 증거가 아니다.

## 완료 조건

- `detailed-e2e-report`: matrix, command, screenshot manifest와 판정이 기록됐다.
- `e2e-primary-screenshot`: 최종 primary screenshot이 저장됐다.
- `screenshot-e2e-command`: 선언된 exact local screenshot E2E script가 성공했다.
- `viewport-screen-state-matrix`: 모든 적용 가능한 조합을 실행했다.
- `independent-screenshot-verifier`: 비수정 독립 검증자가 판정했다.
- `visual-inspection-required`: 모든 최종 이미지를 실제로 열어 검증했다.
- `bounded-pass-loop`: 5라운드 안에 미해결 finding 없는 `PASS`를 얻었다.

보고서와 screenshot을 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
