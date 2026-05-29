---
name: step006
persistence: session
---

# Step 6 - Vitest/Jest 유닛 테스트 러너 환경 설치

<!-- MOAI-ENRICHED v1 -->
> **🛠 TOOLING STEP** — 외부 도구 설치/검증. Plan-Run-Sync 분리 미적용.
> 모델 정책: **haiku** (조사·설치).
> SPEC 자동 생성: step_archive/specs/SPEC-006.md (Stop hook).

프로젝트의 빌드 도구를 분석하여 적합한 테스트 러너를 설치한다.

## 설치 판단 기준

1. `package.json`에서 빌드 도구 확인
   - **Vite 기반** → `vitest` 설치
   - **Webpack/CRA 기반** → `jest` + `ts-jest` 설치
   - **판단 불가** → `vitest` 설치 (경량, 설정 최소)

2. 이미 설치되어 있으면 건너뛴다

## Vitest 설치 시

```bash
npm install -D vitest @vitest/coverage-v8
```text

## Jest 설치 시

```bash
npm install -D jest ts-jest @types/jest
```text

## 설치 확인

```bash
## Vitest
npx vitest --version

## Jest
npx jest --version
```text

설치 확인 후 버전 번호가 출력되면 성공이다.

서브에이전트는 항상 haiku를 사용한다.

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step007.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.

