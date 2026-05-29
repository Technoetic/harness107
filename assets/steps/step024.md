---
name: step024
persistence: session
---

# Step 24 - Awwwards 조사 충분성 검증

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-024.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step024_*.md` 저장 후 1줄 완료 보고 `Step 024/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

## 핵심 원칙: 분석 에이전트 ≠ 검증 에이전트

Step 23에서 분석한 에이전트가 스스로 "충분하다"고 판단하는 것을 **금지**한다. 독립된 검증 에이전트가 조사 품질을 평가한다.

## 실행 내용

Step 23의 조사결과가 이후 기획·설계에 반영 가능한 수준인지 검증한다.

**필요한 파일:**

- step023_조사결과_chunk*.md (디자인 패턴 분석 결과)
- step016_조사결과_chunk*.md (프로젝트 특성 참조)
- `step_archive/screenshots/research/awwwards-*.png` (원본 스크린샷)

## 검증 방법

검증 에이전트가 다음 축으로 판단한다:

- **데이터 기반**: 분석의 각 결론이 수집된 스크린샷/텍스트에 근거하는가
- **누락**: 프로젝트 특성상 필요한 디자인 요소가 분석에서 빠지지 않았는가
- **대안 충분성**: 각 조사 축마다 비교 가능한 대안이 제시되었는가
- **설계 가능성**: "이 데이터로 설계 결정이 가능한가?"

## 판정

결과를 `step_archive/outputs/step024_검증_rN.md`에 저장한다.

- **PASS** → step025.md로 진행
- **FAIL** → FAIL 유형에 따라 돌아갈 Step을 지정한다:
  - **"사이트 부족"** (더 다양한 참고 사이트 필요) → step020로 (재선정)
  - **"데이터 부족"** (선정된 사이트의 추가 페이지/뷰포트 필요) → step022로 (추가 수집)
  - **"분석 얕음"** (수집은 충분하나 패턴 추출이 부족) → step023로 (재분석)

## 반복 제한: 무한 반복 + 스마트 탈출

**최대 5라운드**까지 반복한다. 5라운드 후에도 PASS가 아니면 남은 FAIL 항목을 모두 스킵 처리한다.

**탈출 조건:**
1. **PASS** → 즉시 종료
2. **동일 항목 2연속 [미수정]** → 해당 항목만 스킵 처리하고 나머지 계속
3. **모든 FAIL 항목이 스킵 상태** → 종료 (스킵 사유 기록)

## 실패 패턴 기록

종료 시 (PASS 또는 스킵) `step_archive/progress.json`의 `failure_patterns` 배열에 FAIL 항목을 추가한다.
- PASS로 종료된 경우에도 도중 FAIL이 있었던 항목은 기록한다.
- 형식: `{ "step": 24, "항목": "FAIL 항목 요약", "해결": true/false }`

서브에이전트는 sonnet을 사용한다.

---

이 지침을 완료한 즉시 자동으로 step025.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


