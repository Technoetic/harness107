---
name: step047
phase: e2e
---

# Step 47 - 키보드 인터랙션 시각 검증

## 목표

현재 application의 모든 적용 가능한 keyboard interaction과 accessibility behavior를
실제로 실행하고, 전후 시각 증거를 독립적으로 검증한다.

## 입력과 산출물

- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/step044_html컴포넌트화.md`
- 입력: `step_archive/outputs/trust5_r2.md`
- 입력: `step_archive/step046_screenshot_e2e.md`
- 입력: `step_archive/screenshots/e2e/step046-primary.png`
- 필수 선행 항목: `step030`, `step038`, `step044`, `step046`
- 산출물: `step_archive/step047_keyboard검증.md`
- 산출물: `step_archive/screenshots/keyboard/step047-primary-before.png`
- 산출물: `step_archive/screenshots/keyboard/step047-primary-after.png`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수다.

## 실행 역할

가능한 경우 키보드 실행·보정자 역할과 키보드 독립 검증자 역할을 서로 다른 실행
주체에 맡긴다. 실행·보정자는 재현된 interaction과 accessibility 결함만 고치며, 독립
검증자는 산출물과 application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면
현재 실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고
기록하지 않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 키보드 검증 행렬

rendered control과 설계된 interaction을 inventory해 아래 행을 application별로 만든다.

- `Tab`: forward focus order, visible focus와 focus trap을 확인한다.
- `Shift+Tab`: reverse focus order와 trap의 일관성을 확인한다.
- `Enter`와 `Space`: button, link, checkbox, radio 등 적용 control의 activation을 확인한다.
- `arrow`: menu, radio group, slider, tab 같은 composite control 이동을 확인한다.
- `Escape`: modal, menu, tooltip 또는 popover 종료와 focus return을 확인한다.
- `shortcut`: application이 선언한 shortcut의 action과 feedback을 확인한다.
- `input`: text, number, date 등 적용 field에서 입력 전, 입력 중, 입력 완료 후의 value,
  validation과 feedback을 확인한다.

각 행은 target, prerequisite, keys, expected result, accessibility assertion과 screenshot
path를 포함한다. `N/A`는 application evidence가 그 interaction이 실제로 존재하지 않음을
증명할 때만 허용한다. keyboard access, focus order, visible focus 같은 accessibility
항목에는 N/A를 허용하지 않는다.

## 스크린샷과 독립 시각 검증

각 적용 항목에 인터랙션 전후 screenshot을 만들고, input 항목은 세 상태인 입력 전·
입력 중·입력 완료 후를 모두 남긴다. 대표 pair는
`step_archive/screenshots/keyboard/step047-primary-before.png`와
`step_archive/screenshots/keyboard/step047-primary-after.png`에 저장한다. 독립 검증자는
manifest의 모든 최종 이미지를 실제로 열어 focus, control state, content와 feedback을
판정한다.

결정적 DOM, layout, 접근성 및 file 검사는 실제로 이미지를 여는 시각 검사를 대체하지
못한다. 시각 검사 기능을 사용할 수 없으면 차단한다. 필수 입력, 필수 증거 또는 실행
capability가 없거나 사용할 수 없으면 차단한다.

최대 5라운드 동안 실패 항목을 최소 변경으로 보정하고 영향받는 행을 다시 실행·촬영한
뒤 독립 검증한다. `Critical` 또는 `Important` finding이 하나라도 미해결이면 차단한다.
모든 행과 accessibility 판정이 증거와 함께 `PASS`인 경우에만 완료한다. 스킵이나
미해결 finding은 통과 또는 완료 증거가 아니다.

## 완료 조건

- `keyboard-verification-report`: applicability matrix와 모든 판정이 기록됐다.
- `keyboard-primary-before-screenshot`: 대표 interaction 전 이미지가 저장됐다.
- `keyboard-primary-after-screenshot`: 대표 interaction 후 이미지가 저장됐다.
- `keyboard-interaction-matrix`: 일곱 keyboard interaction 유형을 적용성에 맞게 검증했다.
- `input-three-state-evidence`: 적용 input의 전·중·후 시각 증거가 존재한다.
- `genuine-na-only`: 실제 부재만 N/A이고 accessibility는 N/A가 아니다.
- `independent-keyboard-verifier`: 비수정 독립 검증자가 판정했다.
- `visual-inspection-required`: 모든 최종 이미지를 실제로 열어 검증했다.
- `bounded-pass-loop`: 5라운드 안에 미해결 finding 없는 `PASS`를 얻었다.

보고서와 screenshot을 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
