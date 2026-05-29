---
name: step013
persistence: session
---

# Step 13 - stylelint CSS 린팅 환경 설치

<!-- MOAI-ENRICHED v1 -->
> **🛠 TOOLING STEP** — 외부 도구 설치/검증. Plan-Run-Sync 분리 미적용.
> 모델 정책: **haiku** (조사·설치).
> SPEC 자동 생성: step_archive/specs/SPEC-013.md (Stop hook).

**Hook**: `.claude/hooks/stylelint-validator.ps1`

## 설치

```bash
npm install -D stylelint stylelint-config-standard
```text

## 검증

Hook 실행 후 다음을 확인:
- `step_archive/step013_stylelint_test.md` 파일 생성 확인
- `.claude/hooks/stylelint-validator.log` 로그 확인
- Hook exit code 확인 (0: 성공, 1: 실패)

**검증 실패 시:**
1. 로그 파일 분석
2. 에러 원인 파악 (npm 설치 실패, Node.js 버전 문제 등)
3. 필요한 조치 수행 (npm install -D stylelint stylelint-config-standard 등)
4. Hook 재실행
5. 검증 통과할 때까지 반복

서브에이전트는 항상 haiku를 사용한다.

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step014.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.

