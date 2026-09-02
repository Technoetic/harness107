---
name: step004
phase: preflight
---

# Step 4 - @axe-core/playwright 환경 설치

## 목표

프로젝트에서 `@axe-core/playwright` 패키지를 해석할 수 있고 현재 Playwright 환경과
호환되는지 확인한다.

## 입력과 산출물

- 입력: `step_archive/step003_playwright_test.md`
- 필수 선행 항목: `step003`
- 산출물: `step_archive/step004_axe_core_test.md`
- 네트워크: 패키지 설치가 필요할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.

## 실행

1. Playwright 환경 보고서가 성공을 기록했는지 확인한다.
2. 프로젝트 루트에서 다음 명령을 그대로 실행한다.

```text
node -e "require.resolve('@axe-core/playwright')"
```

패키지를 해석할 수 없으면 프로젝트의 패키지 관리 방식을 우선한다. npm 프로젝트라면
다음 설치 명령을 독립적으로 실행할 수 있다.

```text
npm install --save-dev @axe-core/playwright
```

정상 권한 확인을 유지하며 설치와 확인을 최대 세 번까지만 시도한다. 패키지의 peer
dependency 정보와 설치된 Playwright 버전을 비교하고, 접근성 검사 모듈을 불러올 수
있는지 확인한다. 호환되지 않으면 근거와 필요한 사용자 조치를 기록하고 완료하지
않는다.

## 환경 보고서

`step_archive/step004_axe_core_test.md`에 다음 내용을 기록한다.

- 패키지 해석 명령과 종료 코드
- 설치된 패키지 버전
- Playwright 버전과 호환성 판단 근거
- 재시도 횟수와 최종 결과
- 실패했다면 비밀값이 제거된 오류 범주

## 완료 조건

- `axe-package-resolves`: 선언된 패키지 해석 명령이 종료 코드 0으로 끝난다.
- `axe-environment-report`: 환경 보고서가 존재한다.
- `axe-playwright-compatibility`: 현재 Playwright 환경과의 호환성이 근거와 함께 확인된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
