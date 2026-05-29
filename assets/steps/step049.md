---
name: step049
persistence: session
---

# Step 49 - 테스트 파일 매핑

> **🏁 TRUST 5 게이트 r1 — Stop hook이 자동 평가**
>
> 이 Step 도달 시 `trust5-validator.ps1`가 5축 점수표를 자동 생성한다:
> - Tested / Readable / Unified / Secured / Trackable (각 10점, 총 50점)
> - 결과: `step_archive/outputs/trust5_r1.md`
> - 40점 미만 시 WARN (진행은 계속, fail-open).
> 보강이 필요한 축이 식별되면 본 Step 매핑 작업에 반영한다.

step045_코드리뷰_chunk*.md 기반으로 테스트 파일 매핑 및 서브에이전트 배정 계획을 수립한다.

**참조 파일:**

- step046_주석비율_chunk*.md

## Memory-of-Thought

기획 전에 다음을 확인하라:
- step_archive/progress.json의 failure_patterns — 이전에 실패한 패턴을 반복하지 않는다
- 이전 기획 Step의 결과 파일 — 중복되거나 상충되는 내용이 없는지 확인한다
- 성공한 기획 패턴이 있으면 재활용한다

## 실행 내용

0. **c8 커버리지 베이스라인 수집**: `npx c8 --reporter=json --reporter=text vitest run` 실행하여 현재 커버리지 0%인 파일 목록을 자동 추출한다. 이 목록을 테스트 우선순위 결정의 데이터 기반으로 사용한다.
1. **대상 파일 목록**: Glob으로 구현 파일 검색, step045_코드리뷰_chunk*.md에서 우선순위 추출, c8 커버리지 0% 파일을 최우선 대상으로 배정
2. **복잡도 분석**: 테스트 난이도, 외부 의존성(API/DB/파일), Mock 필요성 판단
3. **서브에이전트 배정**: 파일당 1개 배정, 규모별 개수 (소규모 10-20개, 중규모 20-50개, 대규모 50개 이상)
4. **읽기 전략**: 담당 파일 1개만 Read, 대용량은 Grep→offset/limit
5. **테스트 지침**: 프레임워크, 커버리지 목표, 네이밍, Mock 전략
6. **Context 격리**: 독립 context, 파일 1개만 읽고 테스트 1개만 작성

**매핑 결과는 청크 단위로 저장한다:**

```text
step049_테스트매핑_chunk1.md (500줄 이하)
step049_테스트매핑_chunk2.md (500줄 이하)
step049_테스트매핑_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:

- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개) (20-50개 이상).

서브에이전트는 항상 haiku를 사용한다.

**테스트 매핑 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**


## Self-Calibration

기획 완료 후 다음을 스스로 평가하라:
- 이전 실패 패턴을 피하고 있는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

# EVAL
평가자 실행: 구현 Step 035~049 완료 후 루브릭 평가 수행
- 평가 대상: 전체 구현물 (src/)
- 참조 조사결과: step_archive/step03*_chunk*.md, step04*_chunk*.md
- 결과 저장: step_archive/outputs/eval_r1.md

이 지침을 완료한 즉시 자동으로 step050.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.
