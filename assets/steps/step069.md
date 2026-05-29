---
name: step069
persistence: session
---

# Step 69 - 최적화 조사

> **🏁 TRUST 5 게이트 r2 — Stop hook이 자동 평가**
>
> `trust5-validator.ps1`가 5축 점수표를 자동 생성한다.
> 결과: `step_archive/outputs/trust5_r2.md` (Tested/Readable/Unified/Secured/Trackable, 50점 만점).
> 40점 미만 시 부족 축을 본 최적화 조사 우선순위에 반영한다.

## Step-Back

실행 전에 먼저 답하라:
- 이 조사의 핵심 목적이 무엇인가? (한 문장)
- 이 조사 결과가 이후 어느 Step에 영향을 주는가?
- 조사에서 반드시 확인해야 할 핵심 항목 3가지는?

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용해 (동시 실행 최대 10개) 오직 최적화 관련 조사만을 수행한다.

**조사 단계에서 절대로 "optimize.md"를 생성하지 않는다. 오직 조사만 한다.**

**조사 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**조사결과는 청크 단위로 저장한다:**

```text
step069_최적화조사_chunk1.md (500줄 이하)
step069_최적화조사_chunk2.md (500줄 이하)
step069_최적화조사_chunk3.md (500줄 이하)
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

이 지침을 완료한 즉시 자동으로 step070.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.
