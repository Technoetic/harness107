---
name: step049
phase: e2e
---

# Step 49 - Playwright 디자인 시각 검증 (독립 검증 루프)

## 목표

선택된 디자인 token과 persisted research evidence를 현재 application의 대표 화면과
component에 대조하고, 보정자와 독립 판정자를 분리한 최종 시각 품질 gate를 수행한다.

## 입력과 산출물

- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/outputs/step040_검증.md`
- 입력: `step_archive/screenshots/compare-awwwards-applied-r1.png`
- 입력: `step_archive/outputs/step043_검증_r1.md`
- 입력: `step_archive/step044_html컴포넌트화.md`
- 입력: `step_archive/outputs/trust5_r2.md`
- 입력: `step_archive/step047_keyboard검증.md`
- 입력: `step_archive/step048_마우스검증.md`
- 필수 선행 항목: `step030`, `step038`, `step040`, `step043`, `step044`, `step047`, `step048`
- 산출물: `step_archive/outputs/step049_검증_r1.md`
- 산출물: `step_archive/screenshots/design/step049-primary-r1.png`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수다.

## 실행 역할

가능한 경우 디자인 보정자 역할과 디자인 독립 검증자 역할을 서로 다른 실행 주체에
맡긴다. 보정자는 독립 판정에 근거한 최소 변경만 수행하며, 독립 검증자는 산출물과
application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두
역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.
정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 표본과 여덟 축

rendered semantic component를 stable sort하고 `min(10, component count)`만큼 표본을
선택한다. component 수가 10보다 작으면 전부 선택하며, 표본 key와 정렬 규칙을 보고서에
기록해 재실행 결과를 고정한다.

각 viewport, 대표 화면과 표본 component를 다음 여덟 축으로 검사한다.

1. `layout`
2. `color`
3. `typography`
4. `responsive`
5. `spacing`
6. `overlap/overflow`
7. `completeness`
8. `interaction/accessibility`

모든 판정은 selected design token, persisted research evidence와 관찰한 screenshot 영역에
연결한다. 특정 font family를 프로젝트 맥락이나 token 근거 없이 이름만으로 금지하지
않는다. 임의 preference나 새 외부 조사는 판정 근거가 아니다.

## 독립 디자인 검증 루프

현재 application을 설계된 viewport와 상태에서 촬영하고 primary 결과를
`step_archive/screenshots/design/step049-primary-r1.png`에 저장한다. 독립 검증자는
persisted evidence와 모든 최종 screenshot을 실제로 열어 여덟 축을 판정한다. 보정자는
그 판정을 받은 뒤에만 CSS, 필요한 interaction code 또는 semantic markup을 최소 범위로
수정하고 영향받는 화면 전체를 다시 촬영한다.

결정적 DOM, layout, 접근성 및 file 검사는 실제로 이미지를 여는 시각 검사를 대체하지
못한다. 시각 검사 기능을 사용할 수 없으면 차단한다. 필수 입력, 필수 증거 또는 실행
capability가 없거나 사용할 수 없으면 차단한다.

최대 5라운드 동안 보정과 독립 판정을 반복한다. `Critical` 또는 `Important` finding이
하나라도 미해결이면 차단한다. 모든 화면, 표본과 여덟 축이 증거와 함께 `PASS`인
경우에만 완료한다. 스킵이나 미해결 finding은 통과 또는 완료 증거가 아니다.

## 완료 조건

- `design-visual-report`: 표본, 여덟 축, 라운드와 판정이 기록됐다.
- `design-primary-screenshot`: 최종 primary 디자인 이미지가 저장됐다.
- `eight-axis-design-review`: 여덟 축을 모두 검증했다.
- `design-token-research-traceability`: 판정이 token·research·screenshot에 연결됐다.
- `stable-component-sample`: stable sorted min(10, component count) 표본을 사용했다.
- `independent-design-verifier`: 비수정 독립 검증자가 판정했다.
- `visual-inspection-required`: persisted evidence와 모든 최종 이미지를 실제로 열었다.
- `bounded-pass-loop`: 5라운드 안에 미해결 finding 없는 `PASS`를 얻었다.

보고서와 screenshot을 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
