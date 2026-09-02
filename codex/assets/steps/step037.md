---
name: step037
phase: implementation
---

# Step 37 - 구현

## 목표

불변 주제 계약과 독립 선택된 통합 설계 하나를 실제 application으로 구현한다. 설계
대안을 다시 열지 않고, 파일 소유권과 incremental test 증거로 구현 범위를 추적한다.

## 입력과 산출물

- 입력: `step_archive/TOPIC/TOPIC.md`
- 입력: `step_archive/step022_수집결과_chunk1.md`
- 입력: `step_archive/awwwards-step022-primary.txt`
- 입력: `step_archive/screenshots/research/step022-primary-desktop.png`
- 입력: `step_archive/step023_조사결과_chunk1.md`
- 입력: `step_archive/outputs/step030_설계선택.md`
- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step031_환경준비.md`
- 입력: `step_archive/step032_파일인덱스_chunk1.md`
- 입력: `step_archive/step035_컨텍스트정책.md`
- 입력: `step_archive/step036_인코딩정책.md`
- 필수 선행 항목: `step022`, `step023`, `step030`, `step031`, `step032`, `step035`, `step036`
- 산출물: `step_archive/step037_구현manifest.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수

## 실행 역할

가능한 경우 파일 소유권이 겹치지 않는 모듈 구현자 역할과 구현 독립 검증자 역할을
서로 나눈다. 각 구현자는 선언된 module만 바꾸며, 독립 검증자는 작성 산출물을 수정하지
않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로
수행하고, 별도 역할을 위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동
승인이나 권한 우회를 금지한다.

## 선택 설계 구현

가장 먼저 `step_archive/TOPIC/TOPIC.md`를 확인하고 수정하지 않는다. `topic`,
`audience`, `interactive`, `real_world_apps`, `constraints`의 값을 요구 추적표에 고정한다.
초보 audience에는 용어를 즉시 설명하고, interactive가 필수이면 핵심 개념마다 직접
조작 가능한 control을 제공하며, `real_world_apps`에서 최소 한 사례를 본문에 반영한다.
모든 constraints는 구현 파일과 test에 연결한다.

`step030_설계선택.md`가 가리키는 선택된 30단계 설계만 구현하고 대안을 다시 선택하지 않는다.
`step032_파일인덱스_chunk1.md`의 파일/모듈 소유권을 지켜 각 work unit이
1~3개 파일만 수정하게 한다. 의존성 순서대로 unit을 실행하며 겹치는 파일이 발견되면
작업을 멈추고 소유권부터 해소한다.

각 기능은 실패하는 테스트를 먼저 실행해 요구가 아직 충족되지 않음을 확인하고, 최소
구현으로 통과시킨 뒤 중복만 리팩터링한다. Class 책임과 constructor dependency,
public/private boundary, async initialization·start·cancellation·error lifecycle, responsive
interaction과 키보드·focus·motion·touch·contrast 접근성을 설계 그대로 구현한다.

CSS를 바꾸기 전에 `step_archive/screenshots/research/step022-primary-desktop.png`를 시각
검사 기능으로 실제로 열어 capture manifest 및 `awwwards-step022-primary.txt`와 비교한다.
CSS 결정마다 관찰한 화면 영역, 색·간격·type·motion 근거와 구현 selector를 연결한다.
시각 검사 기능을 사용할 수 없으면 구현 완료를 주장하지 않고 이 단계를 차단한다.

`step_archive/step037_구현manifest.md`에는 work unit, 담당 파일, 변경 전후 digest,
요구 추적 ID, test의 RED·GREEN 결과, Class·async 계약, 시각 근거의 화면 영역과 CSS
selector, 미해결 항목을 기록한다. TOPIC과 선택 문서의 digest도 포함한다.

## 독립 검증

구현 독립 검증자는 TOPIC 다섯 필드, 선택된 설계 하나, 파일 소유권, 실제 test 결과,
Class·async·접근성 계약과 screenshot-to-CSS 추적을 처음부터 확인한다. 구현이나 manifest를
직접 고치지 않고 evidence가 빠진 항목을 `PASS`로 바꾸지 않는다.

## 완료 조건

- `implementation-manifest`: 구현 파일·digest·소유권·test·요구 추적이 기록됐다.
- `implementation-screenshot-input`: 필수 research screenshot이 존재한다.
- `topic-field-fidelity`: TOPIC 다섯 필드를 변경 없이 구현에 반영했다.
- `selected-design-only`: 선택된 통합 설계 하나만 구현했다.
- `class-async-accessibility`: Class·async·interaction·accessibility 계약을 구현했다.
- `incremental-test-evidence`: 각 module의 실패·최소 구현·통과 cycle이 기록됐다.
- `visual-evidence-inspection`: screenshot을 실제로 열고 CSS 근거를 추적했다.
- `independent-implementation-verifier`: 비수정 독립 검증이 모든 증거를 확인했다.

manifest와 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
