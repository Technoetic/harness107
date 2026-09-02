---
name: step001
phase: preflight
---

# Step 1 - 하네스 프리플라이트 체크

## 목표

튜토리얼 주제를 안정된 공유 입력으로 정리하고, 작업에 필요한 도구의 가용성을
확인한다. 일반 권한 확인 절차를 유지하며, 이 문서에 선언된 산출물과 수락 증거만
만든다.

## 입력과 산출물

- 입력: `step_archive/TOPIC/TOPIC.md`
- 산출물: `step_archive/step001_preflight.md`
- 네트워크: 누락된 도구를 설치해야 할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.

## 1. 튜토리얼 주제 점검

현재 작업 요청에서 다음 항목을 추출해
`step_archive/TOPIC/TOPIC.md`에 기록한다.

- `topic`: 한 줄 주제
- `audience`: 대상 독자
- `interactive`: 상호작용 요구
- `real_world_apps`: 참고할 실제 사례
- `constraints`: 구현 및 표현 제약
- `decisions`: 모호한 항목에 대해 선택한 값과 짧은 이유

기존 파일이 현재 작업과 모순되지 않으면 보존하고 누락된 항목만 보완한다. 원문에
포함될 수 있는 자격 증명, 토큰, 개인 식별 정보는 옮기지 않는다. 정보가 모호하면
질문으로 작업을 멈추지 말고 합리적인 값을 결정해 `decisions`에 남긴다.

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
최대 세 번 시도한다. 매 시도에서 정상 권한 확인을 유지한다. 세 번 뒤에도 사용할
수 없으면 그 사실과 오류 범주를 기록하고 이 단계를 완료하지 않는다. 선택 도구는
설치 실패를 경고로 기록하고 `AVAILABLE`, `UNAVAILABLE`, `SKIPPED` 중 하나로
분류한다.

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

- `topic-contract`: 주제 파일
- `preflight-report`: 프리플라이트 보고서
- `node-runtime-version`: `node --version` 성공
- `npm-cli-version`: `npm --version` 성공
- `required-tool-inventory`: 모든 필수 도구 확인 또는 제한된 재시도 후 차단 기록
- `optional-tool-disposition`: 모든 선택 도구의 상태 분류

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
