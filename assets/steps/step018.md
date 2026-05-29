---
name: step018
persistence: session
---

# Step 18 - API 계약 문서 조사

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-018.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step018_*.md` 저장 후 1줄 완료 보고 `Step 018/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

프로젝트에서 사용하는 API 계약 문서를 조사한다.

## Step-Back

실행 전에 먼저 답하라:
- 이 조사의 핵심 목적이 무엇인가? (한 문장)
- 이 조사 결과가 이후 어느 Step에 영향을 주는가?
- 조사에서 반드시 확인해야 할 핵심 항목 3가지는?

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용해 (동시 실행 최대 10개) 오직 조사만을 수행한다.

## 🚨 절대 금지

- **이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**
- **이 단계에서 절대로 "planning.md"를 생성하지 않는다. 오직 조사만 한다.**
- **이 단계에서 절대로 "design.md"를 생성하지 않는다. 오직 조사만 한다.**

**조사결과는 청크 단위로 저장한다:**

```text
step018_조사결과_chunk1.md (500줄 이하)
step018_조사결과_chunk2.md (500줄 이하)
step018_조사결과_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:

- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 haiku를 사용한다.


## CoVe (Chain-of-Verification)

조사 완료 후 체크리스트:
- [ ] Step-Back에서 정의한 핵심 항목 3가지가 모두 조사되었는가?
- [ ] 조사 결과가 청크 파일에 빠짐없이 저장되었는가?
- [ ] 이후 Step에서 참조할 수 있는 형식으로 정리되었는가?

미완료 항목이 있으면 해당 항목만 재조사한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step019.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


