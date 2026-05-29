---
name: step068
persistence: session
---

# Step 68 - 베이스라인 스냅샷 (최적화 전 기준 측정)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-068.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step068_*.md` 저장 후 1줄 완료 보고 `Step 068/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r2 게이트(step069) 전 구간

최적화 Phase 진입 전 현재 코드 품질/성능 수치를 baseline.json으로 저장한다.
이후 최적화 검증 Step(Step 075~083)에서 이 베이스라인과 비교하여 개선/퇴보를 판단한다.

## 실행 내용

### 1. 코드 품질 베이스라인

다음 도구를 실행하여 현재 수치를 측정한다:

1. 테스트 커버리지: `npx c8 --reporter=json vitest run`
2. 코드 중복률: `npx jscpd src/ --reporters json --output step_archive/`
3. 보안 경고: `semgrep --config auto --json src/` 결과를 step_archive/semgrep-baseline.json에 저장
4. 코드 라인 수: `tokei src/ --output json` 결과를 step_archive/tokei-baseline.json에 저장

### 2. 성능 베이스라인

1. Lighthouse CI: dist/index.html 대상으로 실행, 결과를 step_archive/lhci-baseline/에 저장

### 3. 통합 베이스라인 파일 생성

모든 측정 결과를 step_archive/baseline.json에 통합한다.

포함 항목:
- timestamp
- coverage (statements, branches, functions, lines)
- duplication (percentage, clones)
- semgrep (warnings, errors)
- tokei (total_lines, code_lines)
- lighthouse (performance, accessibility, best_practices)

### 4. 실패 처리

- 개별 도구 실패: 해당 항목을 null로 기록하고 계속 진행 (선택적 도구)
- baseline.json 생성 자체 실패: 사용자 개입 요청

### 5. 완료 기준

- step_archive/baseline.json 파일 존재
- 최소 1개 이상의 메트릭이 측정됨

서브에이전트는 항상 haiku를 사용한다.

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step069.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


