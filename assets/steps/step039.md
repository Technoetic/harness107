---
name: step039
persistence: session
---

# Step 39 - 레이아웃 스크린샷 검증 (독립 검증 루프)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-039.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step039_*.md` 저장 후 1줄 완료 보고 `Step 039/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

Step 37에서 구현된 레이아웃이 설계대로 구현되었는지 **작성자와 검증자를 분리하여** 검증한다.

## 핵심 원칙: 작성 에이전트 ≠ 검증 에이전트

같은 에이전트가 작성하고 스스로 통과 판정하는 것을 **금지**한다. 반드시 독립된 두 에이전트를 사용한다.

**필요한 파일:**

- step030_레이아웃설계_chunk*.md (레이아웃 설계)
- step030_전체설계_chunk*.md (전체 설계)

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**스크린샷 없이 통과 처리 금지. 반드시 Claude가 직접 스크린샷을 눈으로 확인한다.**

## 실행 순서

### 1단계: 구현 스크린샷 촬영

Playwright로 현재 구현의 스크린샷을 뷰포트별로 촬영한다:
- 데스크톱 (1920×1080): `step_archive/screenshots/layout-verify-desktop-r1.png`
- 태블릿 (768×1024): `step_archive/screenshots/layout-verify-tablet-r1.png`
- 모바일 (390×844): `step_archive/screenshots/layout-verify-mobile-r1.png`

### 2단계: 검증 에이전트 (에이전트 B) 실행

**에이전트 B의 역할: 비교 검증만 수행. 코드 수정 금지.**

에이전트 B에게 전달할 프롬프트 (N = 현재 라운드 번호):

```text
너는 레이아웃 검증자다. 코드를 수정하지 않는다. 비교 판정만 한다.

1. 설계 문서를 모두 Read한다:
   - `step_archive/step030_전체설계_chunk*.md` (Glob 검색)

2. 구현 스크린샷을 모두 Read한다:
   - `step_archive/screenshots/layout-verify-desktop-rN.png`
   - `step_archive/screenshots/layout-verify-tablet-rN.png`
   - `step_archive/screenshots/layout-verify-mobile-rN.png`

3. 이전 라운드 검증 결과가 있으면 모두 Read한다:
   - `step_archive/outputs/step039_검증_r*.md` (Glob 검색)
   - 이전 라운드에서 FAIL로 지적한 항목이 수정되었는지 반드시 확인한다

4. 설계와 구현을 비교하여 부족한 부분을 구체적으로 나열한다.
   각 항목마다: 설계의 어떤 명세가 구현에서 어긋나는지 명시한다.
   이전 라운드에서 지적한 항목은: [수정됨] 또는 [미수정]으로 표시한다.

5. 디자인 자연스러움도 검토한다:
   - 스크린샷에서 실제로 보이는 시각 요소를 하나씩 식별한다
   - 식별된 요소마다 "이 요소가 시각적으로 자연스러운가?"를 판단한다
   - 사소한 위화감도 놓치지 않는다

6. 결과를 `step_archive/outputs/step039_검증_rN.md`에 저장한다.
   - 부족한 부분이 없으면: "PASS"로 시작
   - 부족한 부분이 있으면: "FAIL"로 시작하고 구체적 피드백 나열
```text

에이전트 B는 sonnet을 사용한다 (스크린샷 분석 필요).

### 3단계: 판정 확인

`step039_검증_rN.md`를 Read한다.

- **PASS로 시작하면** → 종료, 다음 Step으로 이동
- **FAIL로 시작하면** → 4단계로 진행

### 4단계: 수정 에이전트 (에이전트 A) 실행

**에이전트 A의 역할: 검증 피드백을 반영하여 코드 수정만 수행. 통과 판정 금지.**

에이전트 A에게 전달할 프롬프트 (N = 현재 라운드 번호):

```text
너는 레이아웃 수정자다. 통과 여부를 판정하지 않는다. 피드백을 반영만 한다.

1. 최신 검증 피드백을 Read한다:
   - `step_archive/outputs/step039_검증_rN.md`

2. 이전 라운드 수정 내역이 있으면 Read한다:
   - `step_archive/outputs/step039_수정_r*.md` (Glob 검색)
   - 이전에 수정했는데 [미수정]으로 판정된 항목은 다른 방식으로 재수정한다

3. 설계 문서를 Read한다:
   - `step_archive/step030_전체설계_chunk*.md` (Glob 검색)

4. 피드백에 나열된 부족한 부분을 `src/css/*.css`, `src/index.html`, `src/js/*.js`에 반영한다.

5. 수정 내역을 `step_archive/outputs/step039_수정_rN.md`에 기록한다.
```text

에이전트 A는 sonnet을 사용한다 (스크린샷 문맥 필요).

### 5단계: 재촬영 → 2단계로 돌아가기

수정 후 Playwright로 스크린샷을 재촬영하고 (N = 다음 라운드), 2단계(에이전트 B 검증)부터 반복한다.

### 반복 제한: 무한 반복 + 스마트 탈출

회차 제한 없이 PASS가 나올 때까지 반복한다.

**탈출 조건:**
1. **PASS** → 즉시 종료
2. **동일 항목 3연속 [미수정]** → 해당 항목만 스킵 처리하고 나머지 항목은 계속 반복
3. **모든 FAIL 항목이 스킵 상태** → 종료 (해결 불가 판정, 스킵 사유를 최종 보고에 기록)

## 실패 패턴 기록

종료 시 (PASS 또는 스킵) `step_archive/progress.json`의 `failure_patterns` 배열에 FAIL 항목을 추가한다.
- PASS로 종료된 경우에도 도중 FAIL이 있었던 항목은 기록한다.
- 형식: `{ "step": 39, "항목": "FAIL 항목 요약", "해결": true/false }`

## 주의사항

- 에이전트 A가 스스로 "통과"라고 판단하는 것을 금지한다
- 에이전트 B가 코드를 수정하는 것을 금지한다
- 두 에이전트 모두 sonnet을 사용한다
- 에이전트 B의 PASS/FAIL 판정만이 루프 종료 조건이다

---

이 지침을 완료한 즉시 자동으로 step040.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


