---
name: step007
persistence: session
---

# Step 7 - 번들 분석 도구 환경 설치

<!-- MOAI-ENRICHED v1 -->
> **🛠 TOOLING STEP** — 외부 도구 설치/검증. Plan-Run-Sync 분리 미적용.
> 모델 정책: **haiku** (조사·설치).
> SPEC 자동 생성: step_archive/specs/SPEC-007.md (Stop hook).

프로젝트의 번들러를 분석하여 적합한 번들 분석 도구를 설치한다.

## 설치 판단 기준

1. `package.json`에서 번들러 확인
   - **Vite 기반** → `rollup-plugin-visualizer` 설치
   - **Webpack 기반** → `webpack-bundle-analyzer` 설치
   - **판단 불가** → `source-map-explorer` 설치 (범용)

2. 이미 설치되어 있으면 건너뛴다

## Vite 프로젝트 설치 시

```bash
npm install -D rollup-plugin-visualizer
```text

## Webpack 프로젝트 설치 시

```bash
npm install -D webpack-bundle-analyzer
```text

## 범용 설치 시

```bash
npm install -D source-map-explorer
```text

## 설치 확인

설치된 패키지가 `node_modules/`에 존재하는지 확인한다.

```bash
ls node_modules/rollup-plugin-visualizer 2>/dev/null || ls node_modules/webpack-bundle-analyzer 2>/dev/null || ls node_modules/source-map-explorer 2>/dev/null
```text

서브에이전트는 항상 haiku를 사용한다.

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step008.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.

