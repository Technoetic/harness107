---
name: step001
phase: preflight
---

# Step 1 - 하네스 프리플라이트 체크

## 목표

미리 준비된 튜토리얼 주제 입력이 현재 작업에 충분한지 검증하고, 작업에 필요한
도구의 가용성을 확인한다. 일반 권한 확인 절차를 유지하며, 이 문서에 선언된
산출물과 수락 증거만 만든다.

## 입력과 산출물

- 입력: `step_archive/TOPIC/TOPIC.md`
- 산출물: `step_archive/step001_preflight.md`
- 네트워크: 누락된 도구를 설치해야 할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.

## 1. 튜토리얼 주제 점검

`step_archive/TOPIC/TOPIC.md`는 workflow가 미리 준비하고 해시로 고정한 읽기 전용
입력이다. 이 단계에서는 해당 파일을 절대 수정하지 않는다. 다음 필드가 존재하고
현재 작업에서 밝힌 주제와 제약을 충분히 표현하는지만 확인한다.

- `topic`: 한 줄 주제
- `audience`: 대상 독자
- `interactive`: 상호작용 요구
- `real_world_apps`: 참고할 실제 사례
- `constraints`: 구현 및 표현 제약
- `decisions`: 이미 결정된 모호한 항목과 짧은 이유

파일이 누락되었거나 필수 필드가 현재 주제와 제약을 설명하기에 불충분하면 이
단계를 실패로 처리한다. 파일 바이트를 변경하지 않은 채 원인과 안전한 사용자
조치만 프리플라이트 보고서에 남긴다. 입력에서 발견한 자격 증명, 토큰, 개인 식별
정보는 보고서로 옮기지 않는다.

## 2. 도구 인벤토리

각 명령은 독립적으로 실행하고 결과를 기록한다.

| 분류 | 도구 | 확인 명령 |
|:---|:---|:---|
| 필수 | Node.js | `node --version` |
| 필수 | npm | `npm --version` |
| 필수 | Playwright | `npx playwright --version` |
| 필수 | Biome | `npx biome --version` |
| 필수 | Stylelint | `npx stylelint --version` |
| 필수 | Vitest | `npx vitest --version` |
| 선택 | c8 | `npx c8 --version` |
| 선택 | jscpd | `npx jscpd --version` |
| 선택 | madge | `npx madge --version` |
| 선택 | tokei | `tokei --version` |
| 선택 | semgrep | `semgrep --version` |

필수 도구가 없으면 프로젝트가 이미 사용하는 패키지 관리 방식을 우선해 설치를
최대 세 번 시도한다. 매 시도에서 정상 권한 확인을 유지한다. 필수 도구가 모두
실제로 사용 가능해야 `required-tool-inventory`를 충족한다. 하나라도 사용할 수
없으면 이 단계를 완료하지 않고 `required-tool-inventory`에 `ok: true`를 제출하지
않는다. 차단 또는 실패 보고서는 진단 자료일 뿐 필수 도구의 수락 증거가 아니다.

선택 도구는 확인 결과를 `OK`로 기록하거나, 사용할 수 없는 이유와 이후 작업의
안전한 대체 방식을 명시한 `SKIP`으로 기록한다. `SKIP`은 선택 도구에만 허용하며
필수 도구 누락을 숨기는 데 사용할 수 없다.

## 3. 프리플라이트 보고서

`step_archive/step001_preflight.md`에 다음 내용을 기록한다.

- 주제 파일의 존재 여부와 필수 필드 충족 여부
- 필수 및 선택 도구별 명령, 종료 코드, 상태
- 설치를 시도했다면 시도 횟수와 최종 결과
- 총 소요 시간
- 비밀값을 포함하지 않은 오류 범주와 필요한 사용자 조치

환경 변수 값, 인증 정보, 명령 출력에 섞인 비밀값은 보고서에 저장하지 않는다.

## 완료 조건

다음 수락 증거가 모두 준비되어야 한다.

- `topic-contract`: 읽기 전용 주제 입력이 존재하고 충분하며 바이트가 변경되지 않음
- `preflight-report`: 프리플라이트 보고서
- `node-runtime-version`: `node --version` 성공
- `npm-cli-version`: `npm --version` 성공
- `required-tool-inventory`: 제한된 재시도 뒤 모든 필수 도구가 실제로 사용 가능함
- `optional-tool-disposition`: 모든 선택 도구가 `OK` 또는 이유가 있는 안전한 `SKIP`

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
