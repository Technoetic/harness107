---
name: step006
phase: tooling
---

# Step 6 - Vitest/Jest 유닛 테스트 러너 환경 설치

## 목표

프로젝트의 빌드 구성을 근거로 Vitest 또는 Jest를 하나 선택하고, 선택한 테스트
러너가 실제로 실행되는지 검증한다.

## 입력과 산출물

- 입력: `package.json`
- 입력: `step_archive/step001_preflight.md`
- 필수 선행 항목: `step001`
- 산출물: `step_archive/step006_test_runner_test.md`
- 네트워크: 패키지 설치가 필요할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.
- 기능 분류: 필수

## 선택과 설치

`package.json`의 scripts와 dependencies를 함께 조사한다.

- Vite 기반이면 Vitest와 `@vitest/coverage-v8`을 선택한다.
- Webpack 또는 Create React App 기반이면 Jest, `ts-jest`, `@types/jest`를
  선택한다.
- 어느 쪽인지 판단할 근거가 없으면 설정 부담이 작은 Vitest를 선택하고 그 이유를
  보고서에 기록한다.

이미 선택한 러너가 프로젝트 의존성으로 존재하면 설치를 건너뛰되 버전 확인은
반드시 수행한다. 없으면 프로젝트가 사용하는 패키지 관리 방식을 우선하고, npm
프로젝트에서는 다음 중 선택 결과에 맞는 명령 하나를 실행할 수 있다.

```text
npm install --save-dev vitest @vitest/coverage-v8
npm install --save-dev jest ts-jest @types/jest
```

정상 권한 확인을 유지하며 설치와 검증을 합쳐 최대 세 번까지만 시도한다.

## 검증과 실패 처리

선택한 러너에 맞는 명령 하나를 실행한다.

```text
npx vitest --version
npx jest --version
```

버전 또는 smoke 명령이 종료 코드 0으로 성공한 경우에만 도구를 `설치됨`으로
기록한다. manifest나 의존성 디렉터리에 이름이 있다는 사실만으로 성공을 주장하지
않는다. 제한된 시도 뒤에도 선택한 러너를 사용할 수 없으면 원인과 안전한 사용자
조치를 보고서에 기록하고 이 단계를 완료하지 않는다.

## 환경 보고서

`step_archive/step006_test_runner_test.md`에 다음 내용을 기록한다.

- 감지한 빌드 도구와 선택한 러너 및 선택 근거
- 설치 명령을 실행했다면 명령과 시도 횟수
- 버전 확인 명령, 종료 코드, 확인된 버전
- 실패했다면 비밀값이 제거된 오류 범주와 사용자 조치

## 완료 조건

- `test-runner-version`: 선택한 버전 명령이 종료 코드 0으로 끝난다.
- `test-runner-environment-report`: 환경 보고서가 존재한다.
- `test-runner-selection`: 빌드 근거, 선택 결과, 시도 횟수와 검증 결과가 기록된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
