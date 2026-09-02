---
name: step041
phase: review
---

# Step 41 - JavaScript 모듈화

## 목표

선택된 class architecture와 현재 behavior를 유지하면서 JavaScript를 책임별 외부
module로 정리한다. 모든 I/O와 무거운 계산의 비동기 계약, 취소·오류 경계, build
결과를 독립적으로 검증한다.

## 입력과 산출물

- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step037_구현manifest.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/outputs/step040_검증.md`
- 필수 선행 항목: `step030`, `step037`, `step038`, `step040`
- 산출물: `step_archive/step041_js모듈화.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 JavaScript 모듈 구현자 역할과 JavaScript 독립 검증자 역할을 서로 다른
실행 주체에 맡긴다. 구현자는 선언된 module 경계만 바꾸며, 독립 검증자는 산출물과
application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두
역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.
정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## JavaScript 모듈 경계

30단계의 selected architecture와 37단계 manifest를 기준으로 `src/js/*.js` 외부 module을
책임별로 만든다. `src/index.html`에는 module reference만 두고 inline script 구현을
금지한다. 각 Class는 하나의 응집된 책임을 갖고 dependency와 public/private boundary를
명시한다. constructor는 가벼운 동기 field 초기화와 dependency 보관만 하며 I/O, DOM
query, event registration 또는 계산을 시작하지 않는다.

변경 전후 behavior와 접근성 계약을 table로 고정한다. 추출 중 중복이 생기면 공통
module로만 합치고, 화면 상태·event 순서·오류 표시·keyboard interaction을 바꾸지 않는다.

## 비동기 lifecycle

application entry는 `async init()`과 `async start()` 순서를 명시한다. 모든 I/O 경로는
async API와 `await`를 사용하며, 서로 독립적인 작업은 `Promise.all`로 병렬화한다.
무거운 계산은 가능하면 Web Worker로 옮기고 그렇지 않으면 scheduler에 yield하여 UI
thread를 오래 점유하지 않는다.

각 operation은 cancel 신호, timeout과 partial failure를 처리하고 error를 사용자 상태와
진단에 연결한다. background promise에는 명시적 종료 처리를 붙여 unhandled rejection을
남기지 않는다. 실패한 initialization은 이후 start나 render를 실행하지 않는다.

## 빌드와 독립 검증

기존 behavior와 접근성 및 세 viewport 결과가 보존됐는지 실행 가능한 project test로
확인한다. project manifest에 선언된 정확한 build 명령을 정상 권한 흐름으로 실행하고
exit code 0만 성공으로 인정한다. build 뒤 `dist/index.html`의 현재 digest와 HTML
boundary를 38단계 기준에 다시 대조한다.

JavaScript 독립 검증자는 module graph, Class 책임, constructor, async lifecycle,
cancel·error 경로, behavior test, build와 report를 처음부터 확인한다. 결과는
`step_archive/step041_js모듈화.md`에 파일별 책임, dependency edge, 변경 digest,
test·build 결과와 finding을 기록한다. 하나라도 필수 검증이 실패하면 현재 단계를
차단한다.

## 완료 조건

- `javascript-modularization-report`: module·behavior·async·build·검증 증거가 기록됐다.
- `project-build-command`: manifest의 정확한 non-optional build가 성공했다.
- `external-javascript-modules`: JavaScript가 외부 module이고 inline 구현이 없다.
- `class-boundaries`: Class 책임과 가벼운 constructor가 설계와 일치한다.
- `async-lifecycle`: init·start·I/O·parallel·yield·cancel·error 계약을 충족한다.
- `behavior-preservation`: 기존 behavior·접근성·dist boundary가 보존됐다.
- `independent-javascript-verifier`: 비수정 독립 검증자가 전체 증거를 확인했다.

보고서와 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
