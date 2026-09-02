---
name: step009
phase: tooling
---

# Step 9 - Semgrep 정적 분석 환경 설치

## 목표

Semgrep CLI의 가용성을 확인하고, 사용할 수 있으면 검증된 버전을 기록한다. 플랫폼
또는 Python 환경 때문에 사용할 수 없을 때는 선택 기능의 실패를 숨기지 않고 안전한
대체 검토를 선언한다.

## 입력과 산출물

- 입력: `step_archive/step001_preflight.md`
- 필수 선행 항목: `step001`
- 산출물: `step_archive/step009_semgrep_test.md`
- 네트워크: 패키지 설치가 필요할 때 사용할 수 있다.
- 시각 검토: 필요하지 않다.
- 기능 분류: 선택

## 설치와 검증

다음 명령을 먼저 실행한다.

```text
semgrep --version
```

명령이 없으면 프로젝트가 이미 사용하는 격리된 Python 환경과 패키지 관리 방식을
우선한다. 적합한 환경에서는 정상 권한 확인 아래 다음 설치 명령을 사용할 수 있다.

```text
python -m pip install semgrep
```

설치와 버전 확인을 합쳐 최대 세 번까지만 시도한다.
버전 또는 smoke 명령이 종료 코드 0으로 성공한 경우에만 도구를 `설치됨`으로 기록한다.
Python 패키지 metadata만 발견한 상태를 실행 성공으로 간주하지 않는다.

Semgrep을 사용할 수 없으면 `SKIP`으로 기록하고 이유와 안전한 대체 방법으로 기존
린터, 의존성 감사, 민감 패턴에 대한 범위 제한 검색을 명시한다. 이 `SKIP` 기록을
수락 증거로 제출할 수 있지만 Semgrep 검사가 실행되었다고 주장하지 않는다.

## 환경 보고서

`step_archive/step009_semgrep_test.md`에 다음 내용을 기록한다.

- 버전 명령, 종료 코드, 확인된 버전 또는 `SKIP`
- 설치 환경, 설치를 시도했다면 명령과 횟수
- `SKIP`이면 비밀값이 제거된 오류 범주, 이유와 대체 방법

## 완료 조건

- `semgrep-version`: 사용할 수 있을 때 버전 명령이 종료 코드 0으로 끝난다.
- `semgrep-environment-report`: 환경 보고서가 존재한다.
- `semgrep-disposition`: 검증된 버전이 있는 `OK` 또는 이유와 대체 방법이 있는
  `SKIP`이 기록된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
