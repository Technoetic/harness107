---
name: step088
persistence: session
---

# Step 88 - 마우스 인터랙션 시각 검증

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-088.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step088_*.md` 저장 후 1줄 완료 보고 `Step 088/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

Playwright로 마우스 인터랙션을 직접 수행하며 스크린샷을 촬영하고, Claude가 스크린샷을 직접 Read하여 시각적으로 확인한다.
문제 발견 시 코드를 수정하고 재검증을 반복한다. 모든 항목이 통과할 때까지 반복한다.

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**스크린샷 없이 통과 처리 금지. 반드시 Claude가 직접 스크린샷을 눈으로 확인한다.**

## 검증 항목

각 항목마다 인터랙션 전후 스크린샷을 쌍으로 촬영하여 `step_archive/screenshots/mouse/` 에 저장한다.

### 1. Hover
- 버튼, 링크, 카드 등 hover 가능한 요소에 마우스를 올린다
- hover 전 스크린샷 → hover 후 스크린샷
- 확인: 색상 변화, 툴팁 표시, 커서 변경, 애니메이션 동작

### 2. Click
- 버튼, 링크, 체크박스, 라디오 등 클릭 가능한 요소를 클릭한다
- click 전 스크린샷 → click 후 스크린샷
- 확인: 화면 전환, 상태 변화, 팝업/모달 표시, 선택 상태

### 3. Right Click (Context Menu)
- 우클릭 컨텍스트 메뉴가 있는 요소를 우클릭한다
- 우클릭 전 스크린샷 → 우클릭 후 스크린샷
- 확인: 컨텍스트 메뉴 표시, 메뉴 항목, 위치 정확성

### 4. Double Click
- 더블클릭으로 활성화되는 요소를 더블클릭한다
- 더블클릭 전 스크린샷 → 더블클릭 후 스크린샷
- 확인: 편집 모드 진입, 선택 상태, 특수 동작

### 5. Drag & Drop
- 드래그 가능한 요소를 드래그하여 대상 위치에 놓는다
- drag 전 → drag 중 → drop 후 스크린샷
- 확인: 드래그 시각 피드백, 드롭 결과, 원래 위치 변화

### 6. Scroll
- 페이지 및 스크롤 가능한 컨테이너를 마우스 휠로 스크롤한다
- 스크롤 전 → 중간 → 끝 스크린샷
- 확인: sticky 요소, 무한 스크롤, lazy load, 스크롤바 동작

## 실행 방법

각 항목마다 Playwright 스크립트를 작성하여 실행한다:

```javascript
// playwright-mouse-[항목명].js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file:///path/to/dist/index.html');

  // 인터랙션 전 스크린샷
  await page.screenshot({ path: 'step_archive/screenshots/mouse/[항목]-before.png', fullPage: true });

  // 마우스 인터랙션 수행 예시
  await page.hover('[selector]');                      // hover
  // await page.click('[selector]');                   // click
  // await page.click('[selector]', { button: 'right' }); // right click
  // await page.dblclick('[selector]');                // double click
  // await page.dragAndDrop('[from]', '[to]');         // drag & drop
  // await page.mouse.wheel(0, 300);                  // scroll

  // 인터랙션 후 스크린샷
  await page.screenshot({ path: 'step_archive/screenshots/mouse/[항목]-after.png', fullPage: true });

  await browser.close();
})();
```text

## 검증 절차 (항목마다 반복)

1. Playwright 스크립트 실행 → 스크린샷 저장
2. Claude가 스크린샷을 직접 Read하여 시각적으로 확인
3. **문제 발견 시:**
   - 어떤 요소가 어떻게 잘못 동작하는지 구체적으로 기록
   - 해당 소스 코드 수정
   - 스크립트 재실행 → 스크린샷 재촬영
   - Claude가 다시 직접 확인
   - **통과할 때까지 무한 반복**
4. 모든 항목 통과 확인 후 다음 단계 진행

### 반복 제한: 무한 반복 + 스마트 탈출

회차 제한 없이 PASS가 나올 때까지 반복한다.

**탈출 조건:**
1. **PASS** → 즉시 종료
2. **동일 항목 3연속 [미수정]** → 해당 항목만 스킵 처리하고 나머지 항목은 계속 반복
3. **모든 FAIL 항목이 스킵 상태** → 종료 (해결 불가 판정, 스킵 사유를 최종 보고에 기록)

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

이 지침을 완료한 즉시 자동으로 step089.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


