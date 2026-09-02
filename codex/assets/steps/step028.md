---
name: step028
phase: planning
---

# Step 28 - 기획 보강: 참고 레포 코드 분석

## 목표

27단계 계약 기획에 19단계 격리 복제의 정적 구조·패턴 증거를 더한 별도 기획
스냅샷을 만든다. 신뢰하지 않는 코드를 실행하지 않고 적용 가능한 사실만 보강한다.

## 입력과 산출물

- 입력: `step_archive/step027_planning_chunk1.md`
- 입력: `step_archive/outputs/step027_검증.md`
- 입력: `step_archive/step019_조사결과_chunk1.md`
- 입력: `step_archive/references/clone-manifest.md`
- 필수 선행 항목: `step019`, `step027`
- 산출물: `step_archive/step028_planning_chunk1.md`
- 산출물: `step_archive/outputs/step028_검증.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 정적 구조 보강 작성자 역할과 참고 코드 근거 독립 검증자 역할을 나눈다.
작성자는 검증된 정적 관찰만 통합하고, 독립 검증자는 작성 산출물을 수정하지 않는다.
검증자는 clone manifest와 복제 파일을 다시 대조한다. 위임 기능을 사용할 수 없으면
현재 실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고
기록하지 않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 격리 증거 경계

27단계의 최종 `PASS`와 19단계 manifest를 확인한다. manifest에 기록된 검증된 격리
복제 경로만 읽고 새 복제나 네트워크 접근을 하지 않는다. 복제된 코드는 신뢰하지
않으며 코드 실행, 패키지 설치, 빌드, 테스트, 자동화 구성과 스크립트 실행을 모두
금지한다. 경로가 작업공간 밖을 가리키거나 commit이 manifest와 다르면 완료하지
않는다.

## 정적 기획 보강

`step_archive/step028_planning_chunk1.md`에 27단계 전체 계약을 유지한 완전한 별도
스냅샷을 작성한다. 적용 가능한 디렉터리 구조, Class·모듈 경계, composition 패턴,
상태·데이터 흐름과 빌드 구성의 선언을 보강한다. 각 구조, 패턴, 제약은 clone URL,
commit, 복제 파일 경로와 줄 범위로 추적한다. 프로젝트 주제나 계약과 맞지 않는
패턴은 복사하지 않고 제외 이유를 기록한다. 외부 프로젝트의 구현을 그대로 붙여
넣거나 실행 가능하다고 추정하지 않는다.

첫 청크 manifest에 입력 digest, 저장소·commit, 채택·거절 결정과 줄 수를 기록한다.
스냅샷은 500줄 이하이고 이전 기획 스냅샷을 덮어쓰지 않는다. 선언되지 않은 청크를
만들지 않는다.

## bounded 독립 검증

모든 라운드는 동일한 선언 보고서 `step_archive/outputs/step028_검증.md`에 라운드별 섹션으로
기록한다. 검증자는 격리 경계, commit 일치, 정적 근거, 주제 적합성, 계약 보존과
과도한 복제를 판정한다. 최대 5라운드만 수행한다.

- `PASS`: 모든 보강이 정확한 복제 파일과 줄 범위로 추적된 경우에만 완료한다.
- `FAIL`: 완료 증거가 될 수 없다. 작성자만 보정하고 독립 검증자가 재판정한다.
- 실행 결과나 설치 결과를 근거처럼 추가하지 않는다.
- 5라운드까지 `PASS`가 없으면 workflow를 차단하고 미해결 항목을 같은 보고서에
  남긴다.

## 완료 조건

- `repository-planning-snapshot`: 정적 분석을 반영한 별도 완전 스냅샷이 있다.
- `repository-planning-verification`: 단일 보고서에 모든 검증 라운드가 있다.
- `static-analysis-only`: 격리 복제의 코드를 실행하거나 설치하지 않았다.
- `decision-provenance`: 모든 구조·패턴·제약이 commit과 파일 줄에 연결된다.
- `planning-chunks-bounded`: manifest와 스냅샷이 일치하며 500줄 이하이다.
- `bounded-independent-review`: 검증은 다섯 번 안에서 독립적으로 수행됐다.
- `pass-verdict`: 최종 판정이 근거 있는 `PASS`다.

검증 결과와 두 산출물의 경로를 수락 증거로 제출하고 현재 단계에서 멈춘다.
workflow 상태와 영수증만이 이후 진행을 소유한다.
