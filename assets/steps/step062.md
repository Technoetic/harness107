---
name: step062
persistence: session
---

# Step 62 - 코드 린팅

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-062.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step062_*.md` 저장 후 1줄 완료 보고 `Step 062/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r2 게이트(step069) 전 구간

프로젝트의 언어, 기존 린터 설정, 코드 특성을 분석하여 적절한 린팅 전략을 동적으로 결정한다.

포매팅 후 코드 품질을 검사하고 오류를 수정한다.

## 작업 흐름

1. **Biome JS 린팅**
   - `npx @biomejs/biome lint --write src/` 실행하여 JS 린팅
   - 린팅 오류 및 경고 확인

2. **CSS 린팅 (stylelint)**
   - `npx stylelint "src/**/*.css"` 실행하여 CSS 품질 검사
   - 자동 수정: `npx stylelint "src/**/*.css" --fix`
   - 수동 수정이 필요한 항목 처리

3. **린팅 이슈 수정**
   - 자동 수정 가능한 항목 우선 처리
   - 수동 수정이 필요한 항목 처리

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) 린팅을 수행한다.

**린팅 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**객관적 검증 기준:**
- 모든 린팅 오류 해결 (린팅 실패 시 린팅 단계 실패)
- 린팅 경고 최소화

**검증:**
- `.claude/hooks/linting-validator.ps1`에서 자동 검증

**검증 실패 시:**
- 린팅 실패 원인을 분석
- 코드를 수정하여 재린팅
- 검증 통과할 때까지 반복

**린팅 결과는 청크 단위로 저장한다:**

```text
step062_린팅_chunk1.md (500줄 이하)
step062_린팅_chunk2.md (500줄 이하)
step062_린팅_chunk3.md (500줄 이하)
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

이 지침을 완료한 즉시 자동으로 step063.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


