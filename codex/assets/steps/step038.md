---
name: step038
phase: implementation
---

# Step 38 - 빌드 스모크 테스트 (구현 완료 게이트)

## 목표

실제 project가 선언한 build와 zero-cycle 검증을 모두 통과한 경우에만 구현 완료
milestone을 기록한다. 진단 도구의 부재나 warning으로 필수 gate를 건너뛰지 않는다.

## 입력과 산출물

- 입력: `step_archive/step031_환경준비.md`
- 입력: `step_archive/step033_jscpd베이스라인.md`
- 입력: `step_archive/step034_knip베이스라인.md`
- 입력: `step_archive/step037_구현manifest.md`
- 필수 선행 항목: `step031`, `step033`, `step034`, `step037`
- 산출물: `step_archive/step038_smoke_test.md`
- 산출물: `step_archive/outputs/trust5_r1.md`
- 검증 artifact: `dist/index.html`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 빌드 게이트 실행자 역할과 빌드 게이트 독립 검증자 역할을 서로 나눈다.
실행자는 명령과 검사 결과를 기록하고, 독립 검증자는 작성 산출물을 수정하지 않는다.
위임 기능을 사용할 수 없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로 수행하고,
별도 역할을 위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한
우회를 금지한다.

## 필수 빌드와 순환 의존성 게이트

먼저 실제 `project manifest`에서 선언된 non-optional `build` script와 package manager를
찾아 정확한 명령을 기록한다. 임의 command나 optional flag를 만들지 않고 그 명령을
정상 권한 흐름으로 실행한다. exit code 0만 build 성공이며, script가 없거나 실행 실패면
현재 단계를 차단한다.

build 직후 `dist/index.html`이 symbolic link가 아닌 일반 파일이고 0바이트보다 크고,
UTF-8로 읽었을 때 대소문자와 attribute를 허용하는 `<html` opening과 `</html>` closing
boundary를 모두 가지는지 검사한다. stale artifact를 막기 위해 build 전후 metadata와
digest를 기록하며, empty 또는 non-HTML 파일은 실패이다.

순환 의존성이 0개인지 별도 필수 gate로 확인한다. project가 선언한 로컬 cycle script,
이미 project에 있는 로컬 `madge`, 또는 같은 대상 파일에 대한 결정적 정적 import graph
fallback 순으로 사용한다. 어느 방법도 remote package를 받지 않으며, parse하지 못한
edge를 0개로 간주하지 않는다. cycle이 하나라도 있거나 전체 graph를 검증하지 못하면
현재 단계를 차단한다.

lint, format, type 결과는 사용 가능한 project-declared local command로 수집해 경고와
exit code를 기록한다. 이 진단은 필수 게이트를 대체하지 않는다. 단, 실제 build script가
해당 진단을 포함해 실패하면 build 실패 자체이므로 차단한다.

두 필수 게이트가 모두 `PASS`인 뒤에만 `step_archive/step038_smoke_test.md`와
`step_archive/outputs/trust5_r1.md`를 작성한다. 보고서에는 build command·exit code,
dist metadata·digest·boundary 검사, cycle 방식·대상·0개 결과, advisory 결과를 기록한다.

## 독립 검증

플러그인 `docs/QUALITY.md`에 따라 `harness50.quality.json`에 실제 프로젝트 검사 명령을
설정하고 `node "<plugin-root>/scripts/quality-gate.mjs" --workspace "<project-root>"`를
정상 권한으로 실행한다. 테스트·린트·타입·보안 명령과 측정 커버리지의 PASS가 필요하다.
종료 코드가 0이 아니거나 결과가 현재 소스와 일치하지 않으면 완료하지 않는다.

독립 검증자는 manifest의 script와 기록된 command가 정확히 일치하는지, build 뒤 생성된
dist file인지, HTML boundary와 cycle graph가 전체 대상을 다루는지 다시 확인한다.
두 gate 중 하나라도 실패한 보고서나 milestone을 완료 증거로 인정하지 않는다.

## 완료 조건

- `build-smoke-report`: 두 필수 gate와 advisory 결과가 보고서에 있다.
- `implementation-milestone`: 두 필수 gate 뒤 첫 38단계 milestone이 기록됐다.
- `dist-index-html`: build가 만든 `dist/index.html`이 존재한다.
- `project-build-command`: project manifest의 non-optional build 명령이 성공했다.
- `dist-html-boundary`: dist file이 regular·nonempty·HTML boundary 조건을 충족한다.
- `zero-cycle-gate`: 전체 대상의 cycle이 0개이다.
- `advisory-diagnostics`: lint·format·type 결과가 별도로 기록됐다.
- `pass-only-build-gate`: build와 zero-cycle이 모두 `PASS`이다.

보고서와 milestone 및 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다.
workflow 상태와 영수증만이 이후 진행을 소유한다.
