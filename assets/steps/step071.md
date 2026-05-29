---
name: step071
persistence: session
---

# Step 71 - 최적화 설계

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-071.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step071_*.md` 저장 후 1줄 완료 보고 `Step 071/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

## Step-Back

설계 전에 먼저 답하라:
- 이 설계가 해결해야 할 핵심 문제는? (한 문장)
- 조사/기획 결과에서 반드시 반영해야 할 제약 조건은?

step070_최적화기획_chunk*.md에 따라 superpowers:brainstorming으로 최적화 설계 문서를 작성한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용해야 한다 (동시 실행 최대 10개).

**설계 결과는 청크 단위로 저장한다:**

```text
step071_최적화설계_chunk1.md (500줄 이하)
step071_최적화설계_chunk2.md (500줄 이하)
step071_최적화설계_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:
- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 haiku를 사용한다.


## CoVe (Chain-of-Verification)

설계 완료 후:
- [ ] 조사/기획의 모든 요구사항이 설계에 반영되었는가?
- [ ] 구현 가능한 설계인가?
- [ ] 이전 실패 패턴을 반복하지 않는가?

## Self-Calibration

- 이 설계를 그대로 구현해도 되는가? (Y/N)
- N이면 해당 부분을 재설계한다.

## 오류 발생 시

오류 발생 시 원인을 분析하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step072.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


