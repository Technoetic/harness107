---
name: step014
phase: tooling
---

# Step 14 - Biome 포매팅/린팅 환경 설치

## 목표

Biome CLI를 정확한 개발 의존성으로 준비하고, 기존 구성을 보존하면서 실행 가능한
버전과 구성 상태를 검증한다.

## 입력과 산출물

- 입력: `package.json`
- 입력: `step_archive/step001_preflight.md`
- 필수 선행 항목: `step001`
- 산출물: `step_archive/step014_biome_test.md`
- 네트워크: 패키지 설치가 필요할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.
- 기능 분류: 필수

## 설치와 검증

프로젝트 루트에서 먼저 다음 명령을 실행한다.

```text
npx biome --version
```

사용할 수 없으면 프로젝트의 패키지 관리 방식을 우선한다. npm 프로젝트에서는
다음 명령을 실행할 수 있다.

```text
npm install --save-dev --save-exact @biomejs/biome
```

기존 Biome 구성 파일이 있으면 바이트를 덮어쓰지 않고 호환성을 점검한다. 구성이
없을 때만 다음 초기화 명령을 실행하고 생성된 파일을 확인한다.

```text
npx @biomejs/biome init
```

정상 권한 확인을 유지하며 설치와 버전 확인을 합쳐 최대 세 번까지만 시도한다.
버전 또는 smoke 명령이 종료 코드 0으로 성공한 경우에만 도구를 `설치됨`으로
기록한다. manifest 변경이나 초기화 명령만으로 실행 성공을 주장하지 않는다.

제한된 시도 뒤에도 Biome을 사용할 수 없으면 비밀값이 제거된 오류 범주와 사용자
조치를 보고서에 기록하고 이 단계를 완료하지 않는다.

## 환경 보고서

`step_archive/step014_biome_test.md`에 다음 내용을 기록한다.

- 버전 명령, 종료 코드, 확인된 버전
- 설치 명령과 시도 횟수
- 기존 구성 보존 또는 새 구성 초기화 결과
- 실패했다면 비밀값이 제거된 오류 범주와 사용자 조치

## 완료 조건

- `biome-version`: 버전 명령이 종료 코드 0으로 끝난다.
- `biome-environment-report`: 환경 보고서가 존재한다.
- `biome-configuration`: 기존 구성이 보존되었거나 새 구성이 정상 초기화되었다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
