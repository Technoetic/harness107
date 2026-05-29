---
name: step070
persistence: session
---

# Step 70 - 최적화 기획

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-070.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step070_*.md` 저장 후 1줄 완료 보고 `Step 070/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

step069_최적화조사_chunk*.md를 기반으로 superpowers:brainstorming에 진입하여 최적화 기획 문서를 작성한다.

## 최적화 전략 대안 비교 (ToT)

단일 최적화 전략을 바로 확정하지 않는다. 다음 순서로 진행한다.

### 1단계: 전략 대안 3개 생성 (에이전트 A)

에이전트 A가 조사 결과를 기반으로 **최적화 전략 A/B/C**를 생성한다.
- 각 안은 우선순위(성능/번들크기/런타임), 적용 범위, 구현 난이도가 서로 달라야 한다.
- 결과: `step_archive/outputs/step070_전략대안.md`

### 2단계: 트레이드오프 비교 및 선택 (에이전트 B)

에이전트 B가 3개 전략과 `step_archive/progress.json`의 `failure_patterns`를 함께 Read하여 다음 기준으로 비교하고 **1개를 선택**한다. (수정 금지, 선택만)
- 구현 비용 대비 성능 개선 효과
- 기존 코드와의 충돌 위험
- 테스트 커버리지 유지 가능성
- 이전 실패 패턴(step051, step061, step063 등)이 반복될 위험이 낮은 전략 우선

결과: `step_archive/outputs/step070_전략선택.md` — 선택된 전략과 이유 명시

### 3단계: 선택된 전략으로 최적화 기획 문서 작성 (에이전트 A)

에이전트 B가 선택한 전략을 기반으로 최종 기획 문서를 작성한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용해야 한다 (동시 실행 최대 10개).

**기획 결과는 청크 단위로 저장한다:**

```text
step070_최적화기획_chunk1.md (500줄 이하)
step070_최적화기획_chunk2.md (500줄 이하)
step070_최적화기획_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:
- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 sonnet을 사용한다.


## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step071.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


