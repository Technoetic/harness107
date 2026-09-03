---
name: step027
phase: planning
---

# Step 27 - 기획 보강: API 계약 문서 조사결과

## 목표

26단계 기획을 18단계 공식 계약 증거와 결합해, 구현자가 추측 없이 사용할 수 있는
구체적 API 계약을 포함한 별도 기획 스냅샷을 만든다.

## 입력과 산출물

- 입력: `step_archive/step026_planning_chunk1.md`
- 입력: `step_archive/outputs/step026_검증.md`
- 입력: `step_archive/step018_조사결과_chunk1.md`
- 입력: `step_archive/research-raw-step018-api-contract.txt`
- 필수 선행 항목: `step018`, `step026`
- 산출물: `step_archive/step027_planning_chunk1.md`
- 산출물: `step_archive/outputs/step027_검증.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 API 계약 보강 작성자 역할과 API 계약 독립 검증자 역할을 나눈다.
작성자는 계약을 기획에 통합하고, 독립 검증자는 작성 산출물을 수정하지 않는다.
검증자는 공식 원본의 절과 스키마를 직접 대조해 판정만 한다. 위임 기능을 사용할 수
없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을
위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를
금지한다.

## 계약 근거 경계

26단계 검증의 최종 `PASS`, 18단계 조사 청크와 보존 원본을 확인한다. 새 네트워크
수집은 하지 않는다. 원본이 식별한 구체적인 계약 대상, 버전, endpoint 또는 message,
data schema를 먼저 고정한다. 대상과 버전이 모호하거나 입력이 손상됐으면 임의로
선택하지 않고 이 단계를 완료하지 않는다.

## 설계 계약 통합

`step_archive/step027_planning_chunk1.md`는 이전 기획을 보존하면서 다음을 완전히
포함하는 별도 스냅샷이다.

- endpoint와 message 흐름, 요청·응답 또는 이벤트 data schema
- 각 구조의 필수 필드와 선택 필드, 타입, 기본값과 유효성 경계
- 인증 방식, 권한 범위와 비밀값 비보존 규칙
- rate limit, 오류 분류, 재시도 조건, backoff와 취소 조건
- payload·pagination·timeout 등 명시된 제한과 알려지지 않은 항목

각 항목에는 공식 원본 경로, 문서 제목·버전, 절 또는 줄 범위를 붙인다. 원본에 없는 필드,
상태 코드, 기본값과 제한은 발명하지 않는다. 아키텍처 결정도 계약 항목과
연결하고 계약이 지원하지 않는 동작은 비목표로 명시한다.

첫 청크 manifest에 입력 digest, 계약 subject/version, 포함 절, 미확정 항목과 줄 수를
기록한다. 스냅샷은 500줄 이하이고 이전 스냅샷을 덮어쓰지 않는다. 선언되지 않은
파일로 분산해야 한다면 차단한다.

## bounded 독립 검증

모든 라운드는 동일한 선언 보고서 `step_archive/outputs/step027_검증.md`에 라운드별 섹션으로
기록한다. 검증자는 대상·버전, 구조, 필드, 인증, rate limit, 오류, 재시도와
제한을 원본에 대조하고 누락 또는 발명을 판정한다. 최대 5라운드만 수행한다.

- `PASS`: 모든 계약 결정이 공식 원본에 연결된 경우에만 완료한다.
- `FAIL`: 완료 증거가 될 수 없다. 작성자 보정 뒤 독립 검증을 반복한다.
- 미확정 항목을 성공이나 선택 필드로 바꾸지 않는다.
- 5라운드까지 `PASS`가 없으면 workflow를 차단하고 미해결 항목을 같은 보고서에
  기록한다.

## 완료 조건

- `api-contract-planning-snapshot`: 공식 계약을 통합한 별도 스냅샷이 있다.
- `api-contract-planning-verification`: 단일 보고서에 모든 검증 라운드가 있다.
- `concrete-contract-provenance`: 대상, 버전과 모든 계약 결정이 원본에 연결된다.
- `schema-contract-completeness`: 구조·필드·인증·오류·재시도·제한이 빠짐없이 있다.
- `planning-chunks-bounded`: manifest와 스냅샷이 일치하며 500줄 이하이다.
- `bounded-independent-review`: 검증은 다섯 번 안에서 독립적으로 수행됐다.
- `pass-verdict`: 최종 판정이 근거 있는 `PASS`다.

검증 결과와 두 산출물의 경로를 수락 증거로 제출하고 현재 단계에서 멈춘다.
workflow 상태와 영수증만이 이후 진행을 소유한다.
