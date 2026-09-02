---
name: step031
phase: implementation
---

# Step 31 - 환경 준비

## 목표

선택된 통합 설계와 실제 프로젝트 선언을 대조해 구현에 필요한 의존성만 준비한다.
설치가 필요할 때에도 프로젝트가 쓰는 package manager와 lockfile을 보존하며, 필수
의존성을 검증하지 못하면 성공을 추정하지 않고 차단한다.

## 입력과 산출물

- 입력: `step_archive/outputs/step030_설계선택.md`
- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 필수 선행 항목: `step030`
- 산출물: `step_archive/step031_환경준비.md`
- 네트워크: 조건부로 사용한다. 필요한 프로젝트 의존성을 설치할 때만 허용한다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 환경 준비 실행자 역할과 환경 준비 독립 검증자 역할을 서로 나눈다.
실행자는 선언된 의존성의 확인과 필요한 준비만 수행하고, 독립 검증자는 작성 산출물을
수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두 역할을 명확히 분리해
순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고
자동 승인이나 권한 우회를 금지한다.

## 환경 확인과 설치

먼저 `step030_설계선택.md`, `step030_레이아웃설계_chunk1.md`,
`step030_전체설계_chunk1.md`가 같은 선택안을 가리키는지 확인한다. 프로젝트 루트에서
존재하는 모든 project manifest와 대응 lockfile을 식별하고, 선언된 package manager,
script, dependency와 현재 설치 상태를 읽는다. 없는 manifest나 lockfile을 발명하지
않고 서로 충돌하는 선언은 차단 사유로 기록한다.

선택된 설계에 필수인 프로젝트 의존성만 준비 대상으로 삼는다. 이미 선언되고 해석되는
의존성은 다시 설치하지 않는다. 누락된 필수 항목이 있을 때만 프로젝트가 선언한 package
manager의 명령을 제안하고 정상 권한 확인을 거쳐 실행한다. 각 항목은 최대 3회까지만
시도하며, 매 시도 뒤 실제 resolve, version, 최소 smoke 결과와 exit code를 확인한다.
세 번 안에 모두 검증되지 않거나 lockfile이 예상 밖으로 바뀌면 이 단계를 실패로 차단한다.

`step_archive/step031_환경준비.md`에는 선택 설계 digest, 발견한 manifest와 lockfile,
필수 의존성 근거, 실행한 정확한 명령과 exit code, resolve 경로, version, smoke 결과,
변경된 선언 파일을 기록한다. 환경 변수 원문이나 credential은 기록하지 않는다.

## 독립 검증

독립 검증자는 설계에 없는 패키지가 추가되지 않았는지, 선언된 package manager와
lockfile이 유지됐는지, 모든 필수 항목의 resolve·version·smoke 증거가 일치하는지
처음부터 대조한다. 실패나 미확인을 `PASS`로 바꾸지 않는다.

## 완료 조건

- `environment-preparation-report`: 환경 준비 보고서가 선언 경로에 존재한다.
- `selected-design-and-manifests`: 선택 설계와 실제 project manifest를 모두 대조했다.
- `required-dependencies-only`: 선택 설계에 필수인 의존성만 대상으로 삼았다.
- `bounded-resolution-smoke`: 모든 필수 항목이 제한된 시도 안에 검증됐다.
- `permission-preservation`: 조건부 설치가 정상 권한 흐름을 유지했다.

보고서와 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
