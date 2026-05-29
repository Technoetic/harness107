---
name: step057
persistence: session
---

# Step 57 - 리팩토링 검증: jscpd 중복률

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-057.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step057_*.md` 저장 후 1줄 완료 보고 `Step 057/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r2 게이트(step069) 전 구간

## 실행 내용

**비교 기준 파일:

- step047_중복분석_chunk*.md**

- step_archive/step033_jscpd베이스라인.md (리팩토링 전 jscpd 베이스라인)
- step_archive/jscpd-baseline/ (리팩토링 전 jscpd 원본 데이터)

리팩토링 전후 `npx jscpd src/ --reporters json` 결과를 비교하여 중복률이 감소했는지 확인한다. Step 47 코드 리뷰에서 지적된 중복 블록을 공통 함수/모듈로 추출한다. 중복률 증가 시 리팩토링 실패로 간주한다.

**검증 결과는 청크 단위로 저장한다:**

```text
step057_중복률검증_chunk1.md (500줄 이하)
step057_중복률검증_chunk2.md (500줄 이하)
...
```text

**작성 규칙**:
- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 haiku를 사용한다.


## CoVe (Chain-of-Verification)

검증 완료 후 체크리스트:
- [ ] 검증 기준이 모두 통과되었는가?
- [ ] 예외 케이스가 누락되지 않았는가?
- [ ] 검증 결과가 다음 Step에서 참조 가능한 형식으로 저장되었는가?

## Self-Calibration

- 이 검증 결과를 신뢰할 수 있는가? (Y/N)
- N이면 검증을 재실행한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step058.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


