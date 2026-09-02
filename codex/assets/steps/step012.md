---
name: step012
phase: tooling
---

# Step 12 - Lighthouse CI 웹 성능 감사 환경 설치

## 목표

프로젝트에서 Lighthouse CI CLI를 실행할 수 있도록 준비하고 실제 버전 명령으로
설치 결과를 검증한다.

## 입력과 산출물

- 입력: `package.json`
- 입력: `step_archive/step001_preflight.md`
- 필수 선행 항목: `step001`
- 산출물: `step_archive/step012_lhci_test.md`
- 네트워크: 패키지 설치가 필요할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.
- 기능 분류: 필수

## 설치와 검증

프로젝트 루트에서 먼저 다음 명령을 실행한다.

```text
npx lhci --version
```

사용할 수 없으면 프로젝트의 패키지 관리 방식을 우선한다. npm 프로젝트에서는
다음 명령을 실행할 수 있다.

```text
npm install --save-dev @lhci/cli
```

정상 권한 확인을 유지하며 설치와 버전 확인을 합쳐 최대 세 번까지만 시도한다.
버전 또는 smoke 명령이 종료 코드 0으로 성공한 경우에만 도구를 `설치됨`으로
기록한다. 패키지가 manifest에 있다는 사실만으로 성공을 주장하지 않는다.

제한된 시도 뒤에도 Lighthouse CI를 사용할 수 없으면 비밀값이 제거된 오류 범주와
사용자 조치를 보고서에 기록하고 이 단계를 완료하지 않는다.

## 환경 보고서

`step_archive/step012_lhci_test.md`에 다음 내용을 기록한다.

- 버전 명령, 종료 코드, 확인된 버전
- 설치 명령과 시도 횟수
- Node.js 및 브라우저 관련 호환성 판단
- 실패했다면 비밀값이 제거된 오류 범주와 사용자 조치

## 완료 조건

- `lhci-version`: 버전 명령이 종료 코드 0으로 끝난다.
- `lhci-environment-report`: 환경 보고서가 존재한다.
- `lhci-installation-verified`: 실행 가능한 버전과 호환성 판단이 기록된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
