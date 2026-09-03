---
name: step040
phase: review
---

# Step 40 - 조사 스크린샷 vs 구현 스크린샷 비교 검증 (독립 검증 루프)

## 목표

검증된 구현 화면을 지속된 조사 증거와 나란히 비교한다. 여덟 디자인 축의 판정을
증거와 화면 영역에 연결하고, 독립 검증자가 모든 중요한 차이가 해소됐다고 확인한
경우에만 완료한다.

## 입력과 산출물

- 입력: `step_archive/step022_수집결과_chunk1.md`
- 입력: `step_archive/awwwards-step022-primary.txt`
- 입력: `step_archive/screenshots/research/step022-primary-desktop.png`
- 입력: `step_archive/step023_조사결과_chunk1.md`
- 입력: `step_archive/outputs/step024_검증_r1.md`
- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/screenshots/layout-verify-desktop-r1.png`
- 입력: `step_archive/screenshots/layout-verify-tablet-r1.png`
- 입력: `step_archive/screenshots/layout-verify-mobile-r1.png`
- 입력: `step_archive/outputs/step039_검증_r1.md`
- 필수 선행 항목: `step022`, `step023`, `step024`, `step030`, `step039`
- 산출물: `step_archive/screenshots/compare-impl-desktop.png`
- 산출물: `step_archive/screenshots/compare-impl-tablet.png`
- 산출물: `step_archive/screenshots/compare-impl-mobile.png`
- 산출물: `step_archive/outputs/step040_검증.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수

## 실행 역할

가능한 경우 디자인 비교 보정자 역할과 디자인 비교 독립 검증자 역할을 서로 다른 실행
주체에 맡긴다. 보정자는 판정된 문제만 application source에 반영하며, 독립 검증자는
산출물과 application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재
실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지
않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 지속된 조사 증거 비교

22~24단계의 persisted collection, raw text, primary screenshot, 분석과 `PASS` 보고서만
조사 근거로 사용한다. 새로운 browsing을 수행하지 않는다. 30단계 레이아웃 설계와
39단계 최종 화면도 함께 고정하고, 현재 구현을 desktop, tablet, mobile viewport로
`compare-impl-desktop.png`, `compare-impl-tablet.png`,
`compare-impl-mobile.png`에 촬영한다.

독립 검증자는 연구 screenshot과 구현 screenshot을 모두 실제로 열어 다음 여덟 축을
각 viewport에 동일하게 적용한다.

1. 레이아웃 구조
2. 시각적 계층
3. 여백/간격
4. 색상/대비
5. 컴포넌트 완성도
6. 컨트롤 패널 배치
7. 시각화 영역 비율
8. 반응형 전환

판정마다 정확한 persisted evidence의 파일·섹션과 관찰한 screenshot 영역, severity,
expected와 actual을 연결한다. 파일 이름이나 metadata만으로 보았다고 주장하지 않는다.
`FAIL`이면 보정자는 지적된 차이에 한정한 최소 변경만 하고 구현 screenshot 세 개를
모두 다시 촬영한다. 독립 검증자는 갱신된 이미지와 근거를 다시 열고 판정한다. 모든
라운드는 `step_archive/outputs/step040_검증.md`의 연속 섹션에 기록한다.

결정적 DOM, layout 수치, 접근성 검사는 함께 실행하지만 실제로 이미지를 여는 시각
검사를 대체하지 못한다. 시각 검사 기능을 사용할 수 없으면 현재 단계를 차단한다.
루프는 최대 5라운드다. `Critical` 또는 `Important` finding이 하나라도 미해결이면
현재 단계를 차단한다. 독립 검증자가 여덟 축 전체에 `PASS`를 기록한 경우에만 완료한다.

## 완료 조건

- `comparison-desktop-screenshot`: 최종 desktop 구현 capture가 저장됐다.
- `comparison-tablet-screenshot`: 최종 tablet 구현 capture가 저장됐다.
- `comparison-mobile-screenshot`: 최종 mobile 구현 capture가 저장됐다.
- `research-comparison-report`: 모든 제한된 비교 라운드와 판정이 한 보고서에 있다.
- `persisted-research-only`: 지속된 조사 증거만 사용했고 새로운 browsing이 없었다.
- `eight-axis-comparison`: 여덟 축을 세 viewport 모두에 적용했다.
- `comparison-traceability`: 모든 판정과 보정이 정확한 근거와 화면 영역에 연결됐다.
- `independent-comparison-verifier`: 비수정 독립 검증자가 판정했다.
- `visual-inspection-required`: 연구와 구현 이미지를 실제로 열었다.
- `bounded-pass-loop`: 5라운드 안에 미해결 중요 finding 없는 `PASS`를 얻었다.

스크린샷과 보고서를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
