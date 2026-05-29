---
name: step032
persistence: session
---

# Step 32 - 구현 파일 인덱싱 (tokei)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-032.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step032_*.md` 저장 후 1줄 완료 보고 `Step 032/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

## Memory-of-Thought

기획 전에 다음을 확인하라:
- step_archive/progress.json의 failure_patterns — 이전에 실패한 패턴을 반복하지 않는다
- 이전 기획 Step의 결과 파일 — 중복되거나 상충되는 내용이 없는지 확인한다
- 성공한 기획 패턴이 있으면 재활용한다

## 실행 내용

step030 설계 결과를 기반으로 파일별 구현 계획을 수립하고 서브에이전트를 배정한다.

**필요한 파일:**

- step030_레이아웃설계_chunk*.md (레이아웃 설계 결과)
- step030_전체설계_chunk*.md (전체 설계 결과)

1. **파일 목록 생성**: design.md에서 클래스/함수 추출, 파일 경로 결정, 신규/수정 구분
2. **복잡도 산출**: `tokei src/ --output json --files` 실행하여 파일별 실제 코드 라인 수를 측정한다. 대용량 파일(500줄 이상)을 자동 식별한다.
3. **서브에이전트 배정**: 파일/모듈별 독립 배정 (1개당 1-3개 파일), 의존성 고려
4. **읽기 전략**:
   - 신규 파일: Read 불필요, 바로 Write
   - 기존 파일: Grep→offset/limit Read→Edit
   - 대용량: Grep→offset/limit만 (전체 읽기 금지)
5. **Context 격리**: 담당 파일만 접근, 다른 파일은 Grep만

**구현 계획 결과는 청크 단위로 저장한다:**

```text
step032_파일인덱스_chunk1.md (500줄 이하)
step032_파일인덱스_chunk2.md (500줄 이하)
step032_파일인덱스_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:

- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개).

서브에이전트는 항상 haiku를 사용한다.

**구현 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

## Self-Calibration

기획 완료 후 다음을 스스로 평가하라:
- 이전 실패 패턴을 피하고 있는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다.

---

이 지침을 완료한 즉시 자동으로 step033.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


