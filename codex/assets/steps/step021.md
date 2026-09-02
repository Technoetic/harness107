---
name: step021
phase: research
---

# Step 21 - 의존성 게이트 검증

## 목표

현재 프로젝트가 선언한 선행 파일을 로컬에서 결정적으로 검사하고, 누락 항목을
명확한 상태 보고서로 남긴다. 설치나 자동 실행 경로 변경 없이 실제 존재와 내용을
근거로만 판정한다.

## 입력과 산출물

- 입력: `step_archive/step001_preflight.md`
- 필수 선행 항목: `step001`
- 산출물: `step_archive/step021_gate_status.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 필수 기반 증거

현재 workflow가 제공한 1단계 완료 영수증과
`step_archive/step001_preflight.md`를 모두 확인한다. 영수증의 workflow와 단계 번호,
성공 증거가 현재 실행과 일치해야 하며 프리플라이트 산출물도 실제로 존재해야 한다.
둘 중 하나라도 없거나 충돌하면 보고서에 기록하고 완료하지 않는다. 제어 metadata를
직접 변경하거나 완료 기록을 만들어 내지 않는다.

## 프로젝트 조건부 검사

먼저 현재 프로젝트가 실제로 선언한 package manager, build, test, runtime 전제를
찾는다. `package.json`과 `node_modules`는 프로젝트 조건부 항목이다. `package.json`이
존재하고 Node 의존성을 선언한 경우에만 해당 manifest와 프로젝트의 설치 전략을
검사한다. Plug'n'Play 등 다른 전략을 쓰면 `node_modules` 디렉터리를 일률적으로
요구하지 않고, 선언된 해석 명령의 성공 여부를 사용한다.

`step_archive/step-deps.json`은 선택 입력이다. 존재하면 현재 항목의 고정 경로와
와일드카드 선언을 로컬에서 확인한다. 없으면 오류로 만들지 않고 index에 선언된
현재 입력과 프로젝트 manifest에서 근거를 도출한 사실을 보고서에 기록한다. 잘못된
형식이나 작업 경계를 벗어나는 경로는 안전하게 해석할 수 없으므로 차단한다.

선언된 package script, config, source 또는 선행 파일이 누락되면 어떤 선언에서
요구되었는지와 안전한 사용자 조치를 기록하고 이 단계를 완료하지 않는다. 이
검사는 로컬이며 결정적이어야 한다. 네트워크 접근, 패키지 설치, 자동화 핸들러 생성
또는 수정은 수행하지 않는다.

## 상태 보고서

`step_archive/step021_gate_status.md`에 다음을 기록한다.

- 1단계 영수증과 프리플라이트 산출물의 확인 결과
- 발견한 프로젝트 유형과 조건부 전제
- 검사한 선언별 경로, 존재 여부와 결정적 명령 결과
- 선택 dependency map의 사용 또는 부재
- 누락 시 원인과 사용자 조치

비밀값, 인증 정보, 원시 환경 변수는 기록하지 않는다. 누락을 보고한 파일은 성공한
것처럼 표시하지 않으며 다른 작업을 자동으로 실행하지 않는다.

## 완료 조건

- `step001-preflight-artifact`: 프리플라이트 산출물이 실제로 존재한다.
- `dependency-gate-status`: 상태 보고서가 모든 검사 결과를 기록한다.
- `step001-receipt-and-artifact`: 1단계 완료 영수증과 산출물이 모두 일치한다.
- `project-conditional-prerequisites`: 프로젝트가 실제 선언한 전제가 모두 충족된다.
- `optional-step-deps`: 선택 dependency map의 사용 또는 부재가 정직하게 기록된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
