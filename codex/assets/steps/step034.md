---
name: step034
phase: implementation
---

# Step 34 - knip 미사용 코드 베이스라인 수집

## 목표

구현 변경 전 미사용 파일·export·dependency 후보를 재현 가능한 로컬 증거로 기록한다.
`knip`은 선택적 측정 수단이며, 도구 부재를 필수 summary 부재로 바꾸지 않는다.

## 입력과 산출물

- 입력: `step_archive/step032_파일인덱스_chunk1.md`
- 필수 선행 항목: `step032`
- 필수 산출물: `step_archive/step034_knip베이스라인.md`
- 선택 산출물: `step_archive/knip-baseline.json`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 미사용 코드 베이스라인 실행자 역할과 미사용 코드 베이스라인 독립 검증자 역할을
서로 나눈다. 실행자는 측정과 summary 작성을 맡고, 독립 검증자는 작성 산출물을
수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두 역할을 명확히 분리해
순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고
자동 승인이나 권한 우회를 금지한다.

## 선택적 knip 베이스라인

구현 변경 전 상태와 `step032_파일인덱스_chunk1.md`의 대상 집합을 먼저 고정한다.
프로젝트에서 로컬로 해석되는 `knip`이 확인된 경우에만 네트워크를 사용하지 않는
`npm exec --offline -- knip --reporter json` 명령을 정상 권한 흐름으로 실행한다.
exit code와 미사용 file·export·dependency 후보를 category별로 기록하되, 동적 참조는
확정 삭제 대상으로 단정하지 않는다.

이 단계에서는 네트워크를 사용하지 않는다.

로컬 도구가 없으면 `SKIP`과 이유를 기록한다. 실행에 실패한 경우에도 같은 disposition과
실패 evidence를 남긴다. project manifest의
entry와 script, source의 정적 import/export edge를 연결하는 결정적 import graph
fallback을 수행하고 도달하지 못한 후보와 불확실성을 구분한다. 어느 경우에도 summary는
`step_archive/step034_knip베이스라인.md`에 작성한다.

원시 JSON은 로컬 명령이 성공한 경우에만 `step_archive/knip-baseline.json`에 두는
선택적 증거이다. 실패 출력이나 fallback 결과를 원시 도구 보고서로 가장하지 않는다.

## 독립 검증

독립 검증자는 측정 시점과 대상 digest, 로컬 도구 판정과 exit code, category 합계,
동적 참조 불확실성, `SKIP` 시 fallback graph의 재현성을 처음부터 확인한다.

## 완료 조건

- `knip-baseline-summary`: 필수 summary가 선언 경로에 존재한다.
- `knip-raw-report`: 로컬 도구 성공 시에만 원시 JSON이 존재한다.
- `local-knip-command`: 선택 명령은 로컬 해석과 offline 실행을 모두 충족한다.
- `preimplementation-unused-code-snapshot`: 구현 변경 전 대상과 digest가 고정됐다.
- `optional-knip-disposition`: 측정 또는 이유 있는 `SKIP`이 기록됐다.
- `unused-code-fallback`: 도구 부재 시 manifest·import graph 대안이 기록됐다.

summary와 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
