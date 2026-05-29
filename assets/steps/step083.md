---
name: step083
persistence: session
---

# Step 83 - Dead Code 점검 (최적화 후)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-083.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step083_*.md` 저장 후 1줄 완료 보고 `Step 083/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

최적화 구현 완료 후 사용되지 않는 코드(dead code)를 탐지하고 제거한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) dead code 점검을 수행한다.

**Dead code 점검 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**객관적 검증 기준:**
- 사용되지 않는 export 없음 (ts-prune, depcheck 등)
- 사용되지 않는 dependencies 없음
- 최적화 구현으로 새로 생긴 dead code 포함하여 점검
- **jscpd 중복 블록 탐지**: `npx jscpd src/ --reporters json` 실행하여 최적화 후 새로 생긴 중복 블록을 탐지한다. 중복 블록 쌍 중 한쪽이 dead code이면 제거 대상으로 지정한다.
- **Semgrep 취약 패턴 탐지**: `semgrep --config auto src/` 실행하여 최적화 후 새로 생긴 보안 취약 패턴을 탐지한다. dead code와 보안 취약점이 겹치는 코드는 우선 제거한다.
- **tokei 코드 라인 비교**: `tokei src/ --output json` 실행하여 dead code 제거 전후 코드 라인 수를 비교한다. 제거 효과를 정량적으로 기록한다.

**검증:**
- `.claude/hooks/deadcode-validator.ps1`에서 자동 검증

**검증 실패 시:**
- Dead code 탐지 결과 분석
- 탐지된 코드 제거
- 검증 통과할 때까지 반복

**점검 결과는 청크 단위로 저장한다:**

```text
step083_deadcode_chunk1.md (500줄 이하)
step083_deadcode_chunk2.md (500줄 이하)
step083_deadcode_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:
- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 haiku를 사용한다.

## Budget Forcing

서브에이전트가 구현을 너무 빨리 완료하려 할 때 다음을 강제한다:
- 구현 완료 선언 전에 "빠뜨린 엣지 케이스가 없는가?" 를 반드시 검토한다
- 검토 없이 완료 선언 시 해당 서브에이전트는 재실행한다

## Self-Calibration

구현 완료 후 다음을 스스로 평가하라:
- 요구사항이 100% 구현되었는가? (Y/N)
- 빌드가 통과하는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step084.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


