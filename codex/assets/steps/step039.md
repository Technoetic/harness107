---
name: step039
phase: review
---

# Step 39 - 레이아웃 스크린샷 검증 (독립 검증 루프)

## 목표

30단계의 레이아웃·전체 설계와 37단계 구현을 현재 build 결과에 대조한다. 세
viewport의 최종 화면을 작성자와 분리된 검증자가 직접 보고, 설계 충실도·반응형·접근성
문제가 모두 해소된 경우에만 완료한다.

## 입력과 산출물

- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step037_구현manifest.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `step_archive/outputs/trust5_r1.md`
- 입력: `dist/index.html`
- 필수 선행 항목: `step030`, `step037`, `step038`
- 산출물: `step_archive/screenshots/layout-verify-desktop-r1.png`
- 산출물: `step_archive/screenshots/layout-verify-tablet-r1.png`
- 산출물: `step_archive/screenshots/layout-verify-mobile-r1.png`
- 산출물: `step_archive/outputs/step039_검증_r1.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수

## 실행 역할

가능한 경우 레이아웃 보정자 역할과 레이아웃 독립 검증자 역할을 서로 다른 실행 주체에
맡긴다. 보정자는 판정된 문제만 application source에 반영하며, 독립 검증자는 산출물과
application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두
역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.
정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 촬영과 독립 검증 루프

먼저 smoke report와 첫 milestone이 `PASS`이고 `dist/index.html`이 현재 build의
artifact인지 확인한다. 브라우저를 결정적으로 구동해 다음 세 경로를 정확히 촬영한다.

- desktop 1920×1080: `step_archive/screenshots/layout-verify-desktop-r1.png`
- tablet 768×1024: `step_archive/screenshots/layout-verify-tablet-r1.png`
- mobile 390×844: `step_archive/screenshots/layout-verify-mobile-r1.png`

독립 검증자는 매 라운드 최종 스크린샷 세 개를 모두 실제로 열어 레이아웃 설계와 전체
설계에 대조한다. design fidelity, responsive 전환, accessibility, 시각적 계층, 간격,
overflow, keyboard focus와 reduced motion을 viewport별로 판정한다. 각 finding에는 설계
근거, 관찰 영역, severity, 재현 viewport를 기록한다.

`FAIL`이면 보정자는 finding에 한정한 최소 변경만 수행한다. 보정이 끝난 뒤 세 뷰포트
모두 다시 촬영하여 같은 선언 경로의 이미지를 최신 결과로 교체하고, 독립 검증자가
새로 연다. 모든 라운드와 변경·재촬영 digest는 하나의
`step_archive/outputs/step039_검증_r1.md`에 순서대로 보존한다.

결정적 DOM, layout 수치, 접근성 검사는 함께 실행하지만 실제로 이미지를 여는 시각
검사를 대체하지 못한다. 시각 검사 기능을 사용할 수 없으면 현재 단계를 차단한다.
루프는 최대 5라운드다. `Critical` 또는 `Important` finding이 하나라도 미해결이면
현재 단계를 차단한다. 독립 검증자가 전체 근거에 `PASS`를 기록한 경우에만 완료한다.

## 완료 조건

- `layout-desktop-screenshot`: 최종 desktop capture가 정확한 viewport와 digest로 기록됐다.
- `layout-tablet-screenshot`: 최종 tablet capture가 정확한 viewport와 digest로 기록됐다.
- `layout-mobile-screenshot`: 최종 mobile capture가 정확한 viewport와 digest로 기록됐다.
- `layout-verification-report`: 모든 제한된 라운드와 최종 판정이 한 보고서에 있다.
- `exact-layout-viewports`: 세 capture 크기가 선언값과 정확히 일치한다.
- `design-responsive-accessibility`: 설계 충실도·반응형·접근성을 모두 검증했다.
- `independent-layout-verifier`: 비수정 독립 검증자가 최종 판정을 내렸다.
- `visual-inspection-required`: 검증자가 최종 이미지 세 개를 실제로 열었다.
- `bounded-pass-loop`: 5라운드 안에 미해결 중요 finding 없는 `PASS`를 얻었다.

스크린샷과 보고서를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
