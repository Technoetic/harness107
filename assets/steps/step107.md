---
name: step107
persistence: session
---
# Step 107 - 최종 보고

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-107.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step107_*.md` 저장 후 1줄 완료 보고 `Step 107/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: 최종 마무리 구간

## Memory-of-Thought

최종 보고 전에:

- step_archive/progress.json에서 전체 Step 실행 결과를 확인한다
- 실패한 Step과 그 원인을 보고에 포함한다
- 성공/실패 패턴을 다음 프로젝트를 위해 명시한다

지금까지 사용한 서브에이전트들의 사용내역을 보고하고 왜 더 병렬로 사용하지 않았는지를 보고한다.

서브에이전트는 항상 haiku를 사용한다.

## 결과 저장

결과를 step_archive/step107_최종보고.md에 저장한다.

---

이 지침을 수행했으면 모든 작업이 완료된다.

# EVAL

평가자 실행: 통합/성능 테스트 Step 096~105 완료 후 루브릭 최종 평가 수행

- 평가 대상: 최종 구현물 (src/)
- 참조 조사결과: step_archive/step10*_chunk*.md
- 이전 라운드 결과: step_archive/outputs/eval_r2b.md (있으면)
- 결과 저장: step_archive/outputs/eval_r3.md

EVAL 완료 후 모든 작업이 종료된다.


