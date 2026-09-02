---
name: step029
phase: planning
---

# Step 29 - 기획 보강: Awwwards UX/UI·레이아웃 조사결과

## 목표

28단계 기획과 검증된 로컬 시각 증거를 결합해 레이아웃, UX/UI, 상호작용,
반응형과 접근성 계약을 포함하는 별도 통합 기획 스냅샷을 만든다.

## 입력과 산출물

- 입력: `step_archive/step028_planning_chunk1.md`
- 입력: `step_archive/outputs/step028_검증.md`
- 입력: `step_archive/step022_수집결과_chunk1.md`
- 입력: `step_archive/awwwards-step022-primary.txt`
- 입력: `step_archive/screenshots/research/step022-primary-desktop.png`
- 입력: `step_archive/step023_조사결과_chunk1.md`
- 입력: `step_archive/outputs/step024_검증_r1.md`
- 필수 선행 항목: `step022`, `step023`, `step024`, `step028`
- 산출물: `step_archive/step029_planning_chunk1.md`
- 산출물: `step_archive/outputs/step029_검증.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수

## 실행 역할

가능한 경우 시각 기획 보강 작성자 역할과 시각 근거 독립 검증자 역할을 나눈다.
작성자는 근거 있는 대안을 기획에 통합하고, 독립 검증자는 작성 산출물을 수정하지
않는다. 검증자는 원본과 이미지를 직접 확인해 판정만 한다. 위임 기능을 사용할 수
없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을
위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를
금지한다.

## 시각 증거 확인

28단계와 24단계 보고서의 최종 판정이 모두 `PASS`인지 확인한다. 시각 검사 기능으로
`step_archive/screenshots/research/step022-primary-desktop.png`를 실제로 열어 수집
manifest의 URL, viewport, 화면 상태와 비교한다. manifest가 선언한 다른 필수 capture도
같은 방식으로 검사한다. 시각 검사 기능을 사용할 수 없으면 추정이나 원본 텍스트로
대체하지 않고 이 단계를 완료하지 않는다. 새 사이트 방문과 새 자료 수집은 하지
않는다.

## 증거 기반 시각 기획

23단계에서 실제로 이름이 붙은 조사 축과 근거 있는 대안만 평가한다. 사전에 정한
미학 축이나 관찰되지 않은 대안을 추가하지 않는다. 각 축의 선택은 28단계 기능,
대상 사용자와 구현 제약에 비춰 장단점과 출처를 기록한다.

`step_archive/step029_planning_chunk1.md`는 다음 내용을 포함하는 완전한 별도
스냅샷이다.

- 화면별 레이아웃, UX/UI 계층, 인터랙션과 반응형 변화
- desktop, tablet, mobile의 breakpoint와 콘텐츠 우선순위
- default, loading, empty, error, disabled와 완료 상태
- 키보드 순서, 포커스 표시·복원, 터치 target, reduced-motion, 명암 계약
- 실제 앱 사례와 동적 조사 축을 연결한 텍스트 와이어프레임
- 각 결정의 조사 축, 대안, URL, 원본·스크린샷 영역과 선택 이유

첫 청크 manifest에 입력 digest, 검사한 이미지, 축·대안, 결정 provenance와 줄 수를
기록한다. 스냅샷은 500줄 이하이고 이전 파일을 덮어쓰지 않는다. 선언되지 않은
청크가 필요하면 차단한다.

## bounded 독립 검증

모든 라운드는 동일한 선언 보고서 `step_archive/outputs/step029_검증.md`에 라운드별 섹션으로
기록한다. 독립 검증자는 이미지와 manifest 일치, 축·대안 충실성, 기능 적합성,
반응형, 접근성과 provenance를 확인한다. 최대 5라운드만 수행한다.

- `PASS`: 필수 시각·접근성 계약이 모두 실제 증거와 연결된 경우에만 완료한다.
- `FAIL`: 완료 증거가 될 수 없다. 작성자가 보정하고 독립 검증자가 이미지를 다시
  확인한다.
- 누락된 capture나 접근성 계약을 건너뛰지 않는다.
- 5라운드까지 `PASS`가 없으면 workflow를 차단하고 미해결 항목을 같은 보고서에
  기록한다.

## 완료 조건

- `visual-planning-snapshot`: 시각 연구를 통합한 별도 기획 스냅샷이 있다.
- `visual-planning-verification`: 단일 보고서에 모든 검증 라운드가 있다.
- `planning-screenshot-input`: 필수 primary 스크린샷이 존재한다.
- `evidence-axis-fidelity`: 실제 조사 축과 대안만 평가했다.
- `interaction-accessibility-contracts`: 반응형·상태·접근성 계약이 완전하다.
- `visual-evidence-inspection`: 필수 이미지를 실제로 열고 manifest와 비교했다.
- `planning-chunks-bounded`: manifest와 스냅샷이 일치하며 500줄 이하이다.
- `bounded-independent-review`: 검증은 다섯 번 안에서 독립적으로 수행됐다.
- `pass-verdict`: 최종 판정이 근거 있는 `PASS`다.

검증 결과와 필수 screenshot을 포함한 산출물 경로를 수락 증거로 제출하고 현재 단계에서 멈춘다.
workflow 상태와 영수증만이 이후 진행을 소유한다.
