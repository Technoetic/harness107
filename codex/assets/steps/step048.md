---
name: step048
phase: e2e
---

# Step 48 - 마우스 인터랙션 시각 검증

## 목표

현재 application의 모든 적용 가능한 pointer interaction을 실제로 실행하고, 전후와
중간 상태의 시각 증거를 독립적으로 검증한다.

## 입력과 산출물

- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/step044_html컴포넌트화.md`
- 입력: `step_archive/outputs/trust5_r2.md`
- 입력: `step_archive/step046_screenshot_e2e.md`
- 입력: `step_archive/screenshots/e2e/step046-primary.png`
- 입력: `step_archive/step047_keyboard검증.md`
- 입력: `step_archive/screenshots/keyboard/step047-primary-before.png`
- 입력: `step_archive/screenshots/keyboard/step047-primary-after.png`
- 필수 선행 항목: `step030`, `step038`, `step044`, `step046`, `step047`
- 산출물: `step_archive/step048_마우스검증.md`
- 산출물: `step_archive/screenshots/mouse/step048-primary-before.png`
- 산출물: `step_archive/screenshots/mouse/step048-primary-after.png`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수다.

## 실행 역할

가능한 경우 마우스 실행·보정자 역할과 마우스 독립 검증자 역할을 서로 다른 실행
주체에 맡긴다. 실행·보정자는 재현된 pointer 결함만 고치며, 독립 검증자는 산출물과
application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두
역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.
정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 마우스 검증 행렬

rendered control과 설계된 interaction을 inventory해 아래 행을 application별로 만든다.

- `hover`: visual feedback, tooltip, cursor와 animation을 확인한다.
- `click`: navigation, selection, toggle, modal과 state transition을 확인한다.
- `context click`: application이 제공하는 context menu와 위치·항목을 확인한다.
- `double click`: 편집, 선택 또는 선언된 secondary action을 확인한다.
- `drag and drop`: 시작, drag 중간 상태, drop feedback와 최종 순서를 확인한다.
- `scroll`: 시작, scroll 중간 상태, 끝에서 sticky, lazy content와 overflow를 확인한다.

각 행은 target, prerequisite, pointer action, expected result와 screenshot path를 포함한다.
`N/A`는 application evidence가 해당 interaction이 실제로 존재하지 않음을 증명할 때만
허용하며, 단순히 자동화하기 어렵다는 이유는 인정하지 않는다.

## 스크린샷과 독립 시각 검증

각 적용 항목에 인터랙션 전후 screenshot을 만들고, drag와 scroll에는 중간 screenshot도
남긴다. 대표 pair는 `step_archive/screenshots/mouse/step048-primary-before.png`와
`step_archive/screenshots/mouse/step048-primary-after.png`에 저장한다. 독립 검증자는
manifest의 모든 최종 이미지를 실제로 열어 pointer feedback, state, layout과 content를
판정한다.

결정적 DOM, layout, 접근성 및 file 검사는 실제로 이미지를 여는 시각 검사를 대체하지
못한다. 시각 검사 기능을 사용할 수 없으면 차단한다. 필수 입력, 필수 증거 또는 실행
capability가 없거나 사용할 수 없으면 차단한다.

최대 5라운드 동안 실패 항목을 최소 변경으로 보정하고 영향받는 행을 다시 실행·촬영한
뒤 독립 검증한다. `Critical` 또는 `Important` finding이 하나라도 미해결이면 차단한다.
모든 행이 증거와 함께 `PASS`인 경우에만 완료한다. 스킵이나 미해결 finding은 통과
또는 완료 증거가 아니다.

## 완료 조건

- `mouse-verification-report`: applicability matrix와 모든 판정이 기록됐다.
- `mouse-primary-before-screenshot`: 대표 interaction 전 이미지가 저장됐다.
- `mouse-primary-after-screenshot`: 대표 interaction 후 이미지가 저장됐다.
- `mouse-interaction-matrix`: 여섯 pointer interaction 유형을 적용성에 맞게 검증했다.
- `intermediate-state-evidence`: 적용 drag와 scroll의 중간 시각 증거가 존재한다.
- `genuine-na-only`: application에 실제 없는 interaction만 N/A다.
- `independent-mouse-verifier`: 비수정 독립 검증자가 판정했다.
- `visual-inspection-required`: 모든 최종 이미지를 실제로 열어 검증했다.
- `bounded-pass-loop`: 5라운드 안에 미해결 finding 없는 `PASS`를 얻었다.

보고서와 screenshot을 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
