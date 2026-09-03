---
name: step050
phase: e2e
---

# Step 50 - 콘솔 에러 수집 및 해결

## 목표

모든 도달 가능 application 상태에서 browser 오류 표면을 검사하고 0개임을 독립적으로
확인한다. 그 뒤 current build와 최종 dist를 다시 검증하고 세 번째 quality milestone과
내구성 있는 완료 영수증의 순서를 보장한다.

## 입력과 산출물

- 입력: `step_archive/step038_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/step044_html컴포넌트화.md`
- 입력: `step_archive/outputs/trust5_r2.md`
- 입력: `step_archive/step045_e2e테스트결과.md`
- 입력: `step_archive/step046_screenshot_e2e.md`
- 입력: `step_archive/screenshots/e2e/step046-primary.png`
- 입력: `step_archive/step047_keyboard검증.md`
- 입력: `step_archive/screenshots/keyboard/step047-primary-before.png`
- 입력: `step_archive/screenshots/keyboard/step047-primary-after.png`
- 입력: `step_archive/step048_마우스검증.md`
- 입력: `step_archive/screenshots/mouse/step048-primary-before.png`
- 입력: `step_archive/screenshots/mouse/step048-primary-after.png`
- 입력: `step_archive/outputs/step049_검증_r1.md`
- 입력: `step_archive/screenshots/design/step049-primary-r1.png`
- 필수 선행 항목: `step038`, `step044`, `step045`, `step046`, `step047`, `step048`, `step049`
- 산출물: `step_archive/outputs/step050_콘솔에러.md`
- 산출물: `step_archive/outputs/trust5_r3.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 콘솔 오류 보정자 역할과 콘솔 오류 독립 검증자 역할을 서로 다른 실행
주체에 맡긴다. 보정자는 재현된 오류 원인만 수정하며, 독립 검증자는 산출물과
application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두
역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.
정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 도달 가능 상태와 오류 수집

application을 분석해 `reachable-state manifest`를 먼저 만든다. manifest에는 `initial`,
`navigation`, `input prerequisite`, `hidden` 상태, 각 진입 action, expected request와
종료 조건을 포함한다. 새 상태가 발견되지 않을 때까지 이미 확인한 stable key와 비교해
탐색하되, 무경계 탐색을 하지 않는다.

각 상태에서 `pageerror`, `unhandled rejection`, `console.error`, `required-request failure`,
browser 또는 application `crash`를 수집한다. 이 다섯 오류 범주는 모든 상태에서 모두
0개여야 한다. warning은 메시지, 상태와 call site 근거로 분류하고 오류를 warning으로
낮춰 기록하지 않는다.

각 전이에는 DOM condition, request completion, animation completion 또는 application
ready signal 같은 state-specific `bounded settle condition`을 사용한다. fixed sleep은
사용하지 않는다. credential, token, cookie, authorization header와 sensitive query
data는 저장 전에 redact하고 원문 비밀을 보고서에 남기지 않는다.

최대 5라운드 동안 독립 검증자가 전체 manifest를 실행해 오류를 판정하고, 보정자가
원인을 최소 변경한 뒤 전체 manifest를 다시 실행한다. `Critical` 또는 `Important`
finding이 하나라도 미해결이면 차단한다. 필수 입력, 필수 증거 또는 실행 capability가
없거나 사용할 수 없으면 차단한다. 모든 상태와 오류 범주가 증거와 함께 `PASS`인
경우에만 console 검증을 통과한다. 스킵이나 미해결 finding은 통과 또는 완료 증거가
아니다.

## 최종 build와 완료 순서

console 검증이 `PASS`인 뒤 project manifest에 선언된 정확한 build 명령을 정상 권한
흐름으로 실행하고 exit code 0만 성공으로 인정한다. build가 만든 `dist/index.html`은
symbolic link가 아닌 일반 파일이고 0바이트보다 크며, UTF-8 content에 `<html` opening과
`</html>` closing boundary가 있어야 한다. before/after metadata와 digest로 current
artifact임을 확인한다.

독립 검증자는 console, exact build, final dist와 보고서 evidence를 다시 확인한다. 모든
필수 gate가 `PASS`인 뒤에만 `step_archive/outputs/step050_콘솔에러.md`와
`step_archive/outputs/trust5_r3.md`를 최종 수락 증거로 제출한다.

현재 skill은 현재 attempt evidence만 제출한다. 상태 관리자가 evidence를 검증한 뒤
50단계 영수증을 내구성 있게 먼저 기록한다. 영수증이 기록된 뒤에만 `completed`,
`current_step:null`, `completed_at`을 반영한다. 그 사이 crash가 나면 상태 관리자는
영수증에서 앞으로 reconcile한다. 영수증 기록이나 complete operation이 실패하면
50/50을 보고하지 않는다.

영수증은 단계 artifact가 아니며 이 문서나 실행 역할은 직접 상태나 영수증을 쓰지
않는다. `Stop`은 유효한 영수증과 completed 상태를 모두 확인한 뒤에만 종료를 허용한다.
완료 뒤 continuation을 발행하지 않고 미래 단계 파일을 읽지 않는다.

## 완료 조건

- `console-error-report`: state manifest, redacted finding과 판정이 기록됐다.
- `final-quality-milestone`: 모든 gate 뒤 세 번째 milestone이 기록됐다.
- `final-dist-index-html`: final build가 만든 dist HTML이 존재한다.
- `console-errors-zero`: 다섯 오류 범주가 모든 상태에서 0개다.
- `final-build`: manifest의 exact non-optional build가 성공했다.
- `final-dist-html-boundary`: final dist가 regular·nonempty·HTML boundary 조건을 충족한다.
- `reachable-state-manifest`: initial, navigation, prerequisite와 hidden 상태를 탐색했다.
- `warning-classification`: 모든 warning을 근거와 함께 분류했다.
- `bounded-settle-no-fixed-sleep`: bounded condition만 사용했고 fixed sleep이 없다.
- `secret-redaction`: 저장된 증거에 credential이나 token이 없다.
- `independent-console-verifier`: 비수정 독립 검증자가 전체 gate를 확인했다.
- `receipt-first-completion`: durable receipt가 completed 상태와 50/50 보고보다 먼저다.
- `pass-only-final-milestone`: 모든 필수 gate가 `PASS`다.

보고서와 milestone을 수락 증거로 제출하고 현재 단계에서 멈춘다.
