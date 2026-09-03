---
name: step033
phase: implementation
---

# Step 33 - jscpd 코드 중복 베이스라인 수집

## 목표

구현 변경 전 코드 중복 상태를 재현 가능한 로컬 증거로 기록한다. `jscpd`는 선택적
측정 수단이며, 도구가 없다는 이유로 summary 자체를 생략하지 않는다.

## 입력과 산출물

- 입력: `step_archive/step032_파일인덱스_chunk1.md`
- 필수 선행 항목: `step032`
- 필수 산출물: `step_archive/step033_jscpd베이스라인.md`
- 선택 산출물: `step_archive/jscpd-baseline/jscpd-report.json`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 중복 베이스라인 실행자 역할과 중복 베이스라인 독립 검증자 역할을 서로
나눈다. 실행자는 측정과 summary 작성을 맡고, 독립 검증자는 작성 산출물을 수정하지
않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로
수행하고, 별도 역할을 위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동
승인이나 권한 우회를 금지한다.

## 선택적 jscpd 베이스라인

구현 변경 전 상태와 `step032_파일인덱스_chunk1.md`의 대상 집합을 먼저 고정한다.
프로젝트에서 로컬로 해석되는 `jscpd`가 확인된 경우에만 네트워크를 사용하지 않는
`npm exec --offline -- jscpd src/ --reporters json --output step_archive/jscpd-baseline/`
명령을 정상 권한 흐름으로 실행한다. exit code, 대상 파일 수, 중복 block·line·비율과
제외 항목을 기록한다.

이 단계에서는 네트워크를 사용하지 않는다.

로컬 도구가 없으면 `SKIP`과 이유를 기록한다. 실행에 실패한 경우에도 같은 disposition과
실패 evidence를 남긴다. 이어서 파일 digest와
정규화한 연속 코드 block fingerprint를 같은 대상 집합에 적용하는 결정적 중복 fallback을
수행하고, 방법·최소 block 크기·후보 수를 남긴다. 어느 경우에도 summary는
`step_archive/step033_jscpd베이스라인.md`에 작성한다.

원시 JSON은 로컬 명령이 성공한 경우에만 `step_archive/jscpd-baseline/jscpd-report.json`에
두는 선택적 증거이다. 실패 출력, 임의 JSON 또는 fallback 결과를 원시 도구 보고서로
가장하지 않는다.

## 독립 검증

독립 검증자는 측정 시점이 구현 전인지, 대상 집합이 파일 인덱스와 일치하는지, 로컬
도구 판정과 exit code가 정확한지, `SKIP` 시 fallback이 결정적으로 재현되는지 확인한다.

## 완료 조건

- `jscpd-baseline-summary`: 필수 summary가 선언 경로에 존재한다.
- `jscpd-raw-report`: 로컬 도구 성공 시에만 원시 JSON이 존재한다.
- `local-jscpd-command`: 선택 명령은 로컬 해석과 offline 실행을 모두 충족한다.
- `preimplementation-duplication-snapshot`: 구현 변경 전 대상과 digest가 고정됐다.
- `optional-jscpd-disposition`: 측정 또는 이유 있는 `SKIP`이 기록됐다.
- `duplication-fallback`: 도구 부재 시 결정적 대안 측정이 기록됐다.

summary와 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
