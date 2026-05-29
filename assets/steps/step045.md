---
name: step045
persistence: session
---

# Step 45 - 코드 리뷰: semgrep 보안/품질 분석

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-045.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step045_*.md` 저장 후 1줄 완료 보고 `Step 045/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

구현된 코드의 품질을 검토한다. Class 지향 관점에서 코드 리뷰한다.

## 실행 내용

`semgrep --config auto src/` 실행하여 보안 취약점 및 코드 품질 문제를 자동 탐지한다. 발견된 경고는 심각도별(ERROR/WARNING/INFO)로 분류하여 리뷰 결과에 포함한다.

**리뷰 결과는 청크 단위로 저장한다:**

```text
step045_코드리뷰_chunk1.md (500줄 이하)
step045_코드리뷰_chunk2.md (500줄 이하)
...
```text

**작성 규칙**:
- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

**코드 리뷰 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

서브에이전트는 항상 haiku를 사용한다.

## CoVe (Chain-of-Verification)

검증 완료 후 체크리스트:
- [ ] 검증 기준이 모두 통과되었는가?
- [ ] 예외 케이스가 누락되지 않았는가?
- [ ] 검증 결과가 다음 Step에서 참조 가능한 형식으로 저장되었는가?

## Self-Calibration

- 이 검증 결과를 신뢰할 수 있는가? (Y/N)
- N이면 검증을 재실행한다.

---

이 지침을 완료한 즉시 자동으로 step046.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


