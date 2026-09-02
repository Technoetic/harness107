---
name: step007
phase: tooling
---

# Step 7 - 번들 분석 도구 환경 설치

## 목표

프로젝트의 번들러에 맞는 분석 패키지를 하나 선택하고, 로컬 의존성 트리에서
선택한 패키지의 버전을 정상적으로 확인한다.

## 입력과 산출물

- 입력: `package.json`
- 입력: `step_archive/step001_preflight.md`
- 필수 선행 항목: `step001`
- 산출물: `step_archive/step007_bundle_analyzer_test.md`
- 네트워크: 패키지 설치가 필요할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.
- 기능 분류: 필수

## 선택과 설치

`package.json`의 scripts, dependencies, configuration을 근거로 하나를 선택한다.

- Vite 또는 Rollup 기반: `rollup-plugin-visualizer`
- Webpack 기반: `webpack-bundle-analyzer`
- 번들러를 판별할 수 없음: `source-map-explorer`

이미 선택한 패키지가 로컬 의존성으로 확인되면 설치를 건너뛴다. 없으면 프로젝트가
사용하는 패키지 관리 방식을 우선하고, npm 프로젝트에서는 선택에 맞는 명령 하나를
실행할 수 있다.

```text
npm install --save-dev rollup-plugin-visualizer
npm install --save-dev webpack-bundle-analyzer
npm install --save-dev source-map-explorer
```

정상 권한 확인을 유지하며 설치와 검증을 합쳐 최대 세 번까지만 시도한다.

## 검증과 실패 처리

선택한 패키지에 맞는 명령 하나를 실행해 실제 해석된 버전을 확인한다.

```text
npm ls rollup-plugin-visualizer --depth=0
npm ls webpack-bundle-analyzer --depth=0
npm ls source-map-explorer --depth=0
```

버전 또는 smoke 명령이 종료 코드 0으로 성공한 경우에만 도구를 `설치됨`으로
기록한다. 디렉터리 존재 여부만으로 성공을 주장하지 않는다. 선택한 분석 패키지를
사용할 수 없으면 실패 원인과 안전한 사용자 조치를 보고서에 기록하고 이 단계를 완료하지 않는다.

## 환경 보고서

`step_archive/step007_bundle_analyzer_test.md`에 다음 내용을 기록한다.

- 감지한 번들러와 선택한 패키지 및 선택 근거
- 설치 명령과 시도 횟수
- 버전 확인 명령, 종료 코드, 확인된 패키지 버전
- 실패했다면 비밀값이 제거된 오류 범주와 사용자 조치

## 완료 조건

- `bundle-analyzer-version`: 선택한 버전 확인 명령이 종료 코드 0으로 끝난다.
- `bundle-analyzer-environment-report`: 환경 보고서가 존재한다.
- `bundle-analyzer-selection`: 번들러 근거와 정확히 하나의 분석 패키지 선택이
  기록된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
