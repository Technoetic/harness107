---
name: step043
phase: review
---

# Step 43 - Awwwards 디자인 검증 및 CSS 보강 (독립 검증 루프)

## 목표

현재 분리된 CSS가 지속된 Awwwards 조사 증거와 선택된 layout을 충실히 반영하는지
작성자와 분리된 검증자가 직접 본다. 관찰 증거에 필요한 최소 보강만 허용하고 중요한
finding이 모두 해소된 경우에만 완료한다.

## 입력과 산출물

- 입력: `step_archive/step022_수집결과_chunk1.md`
- 입력: `step_archive/awwwards-step022-primary.txt`
- 입력: `step_archive/screenshots/research/step022-primary-desktop.png`
- 입력: `step_archive/step023_조사결과_chunk1.md`
- 입력: `step_archive/outputs/step024_검증_r1.md`
- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/screenshots/compare-impl-desktop.png`
- 입력: `step_archive/screenshots/compare-impl-tablet.png`
- 입력: `step_archive/screenshots/compare-impl-mobile.png`
- 입력: `step_archive/outputs/step040_검증.md`
- 입력: `step_archive/step042_css분리.md`
- 필수 선행 항목: `step022`, `step023`, `step024`, `step030`, `step040`, `step042`
- 산출물: `step_archive/screenshots/compare-awwwards-applied-r1.png`
- 산출물: `step_archive/outputs/step043_검증_r1.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수

## 실행 역할

가능한 경우 Awwwards 보정 구현자 역할과 Awwwards 독립 검증자 역할을 서로 다른 실행
주체에 맡긴다. 구현자는 검증 finding에 해당하는 source만 바꾸며, 독립 검증자는
산출물과 application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재
실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지
않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 증거 제한 보강 루프

22~24단계의 persisted collection, raw text, primary screenshot, 분석과 `PASS` 보고서만
사용한다. 새로운 browsing을 수행하지 않는다. 연구 screenshot과 40단계 구현 screenshot을
모두 실제로 열어 차이를 판정하고, 현재 화면은
`step_archive/screenshots/compare-awwwards-applied-r1.png`에 촬영한다.

판정마다 정확한 persisted evidence의 파일·섹션과 관찰한 screenshot 영역, severity,
해당 selector를 기록한다. 보정은 finding을 해소하는 최소 변경으로 제한하며 CSS를 먼저
사용하고, CSS만으로 의미나 data rendering을 고칠 수 있을 때에만 necessary visualization
JavaScript, 마지막으로 semantic HTML을 고려한다. 무관한 redesign이나 조사에 없는
장식은 추가하지 않는다.

`FAIL`이면 Awwwards 보정 구현자가 판정된 부분만 고치고 같은 선언 경로에 새 screenshot을
촬영한다. Awwwards 독립 검증자는 연구와 구현 이미지를 다시 실제로 열어 수정 여부와
부작용을 판정한다. 모든 라운드, 변경 digest와 판정은
`step_archive/outputs/step043_검증_r1.md`의 연속 섹션에 보존한다.

결정적 DOM, layout 수치, 접근성 검사는 함께 실행하지만 실제로 이미지를 여는 시각
검사를 대체하지 못한다. 시각 검사 기능을 사용할 수 없으면 현재 단계를 차단한다.
루프는 최대 5라운드다. `Critical` 또는 `Important` finding이 하나라도 미해결이면
현재 단계를 차단한다. 독립 검증자가 증거 제한과 화면 품질 전체에 `PASS`를 기록한
경우에만 완료한다.

## 완료 조건

- `awwwards-applied-screenshot`: 마지막 보강 뒤 구현 capture가 저장됐다.
- `awwwards-verification-report`: 모든 제한된 라운드와 최종 판정이 한 보고서에 있다.
- `persisted-research-only`: 지속된 조사 증거만 사용했고 새로운 browsing이 없었다.
- `minimal-evidence-bound-remediation`: 변경이 관찰 근거에 필요한 최소 범위다.
- `independent-awwwards-verifier`: 비수정 독립 검증자가 판정했다.
- `visual-inspection-required`: 연구와 구현 이미지를 실제로 열었다.
- `bounded-pass-loop`: 5라운드 안에 미해결 중요 finding 없는 `PASS`를 얻었다.

스크린샷과 보고서를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
