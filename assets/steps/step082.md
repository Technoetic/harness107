---
name: step082
persistence: session
---

# Step 82 - 빌드 검증: Lighthouse CI 성능 베이스라인 수집

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-082.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step082_*.md` 저장 후 1줄 완료 보고 `Step 082/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

빌드 결과물에 대해 Lighthouse CI를 실행하여 성능 베이스라인을 수집한다.

## 실행 내용

```bash
npx lhci autorun --collect.url=file://$(pwd)/dist/index.html --collect.numberOfRuns=3
```text

결과를 `step_archive/lhci-baseline/` 에 저장한다. 이 베이스라인을 이후 최적화/회귀 단계에서 비교 기준으로 사용한다.

**검증 결과는 청크 단위로 저장한다:**

```text
step082_성능베이스라인_chunk1.md (500줄 이하)
step082_성능베이스라인_chunk2.md (500줄 이하)
...
```text

**작성 규칙**:
- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 haiku를 사용한다.


## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step083.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


