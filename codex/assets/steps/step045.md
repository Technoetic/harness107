---
name: step045
phase: e2e
---

# Step 45 - E2E 테스트

## 목표

현재 build를 실제 사용자 흐름으로 검증한다. 주제와 설계에서 동적으로 시나리오를
도출하고, 프로젝트에 이미 설치된 Playwright와 선언된 E2E script만 사용해 전체
suite가 재현 가능하게 통과하는지 독립적으로 확인한다.

## 입력과 산출물

- 입력: `step_archive/TOPIC/TOPIC.md`
- 입력: `step_archive/step001_preflight.md`
- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step031_환경준비.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/step044_html컴포넌트화.md`
- 입력: `step_archive/outputs/trust5_r2.md`
- 필수 선행 항목: `step001`, `step030`, `step031`, `step038`, `step044`
- 산출물: `step_archive/step045_e2e테스트결과.md`
- 네트워크: browser readiness에 필요한 경우에만 제한적으로 사용한다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 E2E 실행·보정자 역할과 E2E 독립 검증자 역할을 서로 다른 실행 주체에
맡긴다. 실행·보정자는 test와 application의 실패 원인을 최소 범위로 고치고, 독립
검증자는 산출물과 application source를 수정하지 않는다. 위임 기능을 사용할 수
없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을
위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를
금지한다.

## 사전 준비와 시나리오 설계

project manifest와 lockfile을 확인해 로컬 Playwright dependency, 선언된 E2E script,
기존 Playwright configuration과 browser readiness를 먼저 검증한다. implicit package
download을 금지하며, 프로젝트 밖 package나 임시 최신 버전을 가져오지 않는다. 기존
Playwright configuration은 보존하고 필요한 test만 현재 ownership에 맞춰 추가한다.

로컬 dependency가 없으면 필수 입력이 누락된 것으로 차단한다. dependency는 있지만
browser binary가 없으면 로컬 package가 제공하는 installer만 최대 3회 정상 권한 흐름으로
설치 시도한다. 각 시도의 exact command, exit code와 결과를 기록하며, 세 번 안에
준비되지 않으면 차단한다.

topic, design, built application과 실제 user flow를 읽고 성공 흐름, 실패 흐름, 상태
전이와 project-specific edge case 최소 2개를 포함하는 시나리오 manifest를 작성한다.
고정된 예제나 존재하지 않는 화면을 발명하지 않는다.

## 전체 E2E 실행과 독립 검증

project manifest에 선언되어 acceptance pattern과 일치하는 정확한 E2E script로 전체
suite를 실행하고 exit code 0만 성공으로 인정한다. 일부 spec만 선택하거나 optional
mode로 실행하지 않는다. 실패 원인과 exact failing scenario를 기록하고 최소 변경을
적용한 뒤 다시 전체 suite를 실행한다.

최대 5라운드 안에서 실행·보정과 독립 검증을 반복한다. 독립 검증자는 시나리오
manifest, 전체 command output, exit code, edge-case coverage와 변경 범위를 처음부터
확인한다. `Critical` 또는 `Important` finding이 하나라도 미해결이면 차단한다. 필수
입력, 필수 증거 또는 실행 capability가 없거나 사용할 수 없으면 차단한다. 모든 필수
항목이 증거와 함께 `PASS`인 경우에만 보고서를 확정한다. 스킵이나 미해결 finding은
통과 또는 완료 증거가 아니다.

`step_archive/step045_e2e테스트결과.md`에는 scenario manifest, 최소 두 edge case,
browser readiness 시도, exact E2E command, 전체 suite 결과, 각 라운드와 최종 독립
판정을 기록한다. credential이나 환경 비밀은 기록하지 않는다.

## 완료 조건

- `e2e-test-report`: project-specific scenario와 전체 suite 증거가 기록됐다.
- `project-e2e-command`: 선언된 exact local E2E script가 성공했다.
- `local-playwright-only`: 로컬 Playwright만 사용했고 implicit download가 없었다.
- `bounded-browser-readiness`: browser 설치 시도가 정상 권한으로 최대 3회 이내였다.
- `dynamic-scenario-coverage`: topic, design, build와 user flow가 시나리오에 반영됐다.
- `edge-case-coverage`: project-specific edge case를 최소 2개 검증했다.
- `independent-e2e-verifier`: 비수정 독립 검증자가 전체 증거를 확인했다.
- `bounded-pass-loop`: 5라운드 안에 미해결 finding 없는 `PASS`를 얻었다.

보고서를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와 영수증만이 이후
진행을 소유한다.
