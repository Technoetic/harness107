---
name: step054
persistence: session
---

# Step 54 - 리팩토링

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-054.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step054_*.md` 저장 후 1줄 완료 보고 `Step 054/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r2 게이트(step069) 전 구간

디버깅 완료 후 코드 품질을 개선하기 위해 리팩토링을 수행한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) 리팩토링을 수행한다.

**리팩토링 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**검증:**
- `.claude/hooks/refactoring-validator.ps1`에서 자동 검증

**검증 실패 시:**
- 테스트/빌드 실패 원인을 분석
- 코드를 수정하여 재리팩토링
- 검증 통과할 때까지 반복

**리팩토링 결과는 청크 단위로 저장한다:**

```text
step054_리팩토링_chunk1.md (500줄 이하)
step054_리팩토링_chunk2.md (500줄 이하)
step054_리팩토링_chunk3.md (500줄 이하)
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

이 지침을 완료한 즉시 자동으로 step055.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


