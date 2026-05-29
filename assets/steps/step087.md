---
name: step087
persistence: session
---

# Step 87 - 키보드 인터랙션 시각 검증

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-087.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step087_*.md` 저장 후 1줄 완료 보고 `Step 087/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

Playwright로 키보드 인터랙션을 직접 수행하며 스크린샷을 촬영하고, Claude가 스크린샷을 직접 Read하여 시각적으로 확인한다.
문제 발견 시 코드를 수정하고 재검증을 반복한다. 모든 항목이 통과할 때까지 반복한다.

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**스크린샷 없이 통과 처리 금지. 반드시 Claude가 직접 스크린샷을 눈으로 확인한다.**

## 검증 항목

각 항목마다 인터랙션 전후 스크린샷을 쌍으로 촬영하여 `step_archive/screenshots/keyboard/` 에 저장한다.

### 1. Tab 네비게이션
- Tab 키로 포커스를 순서대로 이동한다
- 포커스 이동 전 → 각 요소에 포커스된 후 스크린샷
- 확인: 포커스 링 표시, 포커스 순서(논리적 흐름), 포커스 트랩(모달 내 순환)

### 2. Shift+Tab 역방향 네비게이션
- Shift+Tab으로 포커스를 역방향으로 이동한다
- 역방향 이동 전 → 이동 후 스크린샷
- 확인: 역방향 포커스 이동, 포커스 순서 일관성

### 3. Enter / Space 활성화
- 버튼, 링크, 체크박스, 라디오 등에 포커스 후 Enter/Space를 누른다
- 활성화 전 → 활성화 후 스크린샷
- 확인: 버튼 클릭 효과, 체크박스 토글, 링크 이동, 드롭다운 열림

### 4. 방향키 조작
- 드롭다운, 라디오 그룹, 슬라이더, 탭 패널 등에서 방향키를 사용한다
- 조작 전 → 조작 후 스크린샷
- 확인: 선택 항목 이동, 값 변경, 시각적 피드백

### 5. Escape 키
- 모달, 드롭다운, 툴팁, 팝오버 등이 열린 상태에서 Escape를 누른다
- Escape 전 → Escape 후 스크린샷
- 확인: 닫힘 동작, 포커스 복귀 위치

### 6. 단축키
- 앱에서 제공하는 키보드 단축키(Ctrl+Z, Ctrl+S 등)를 실행한다
- 단축키 실행 전 → 실행 후 스크린샷
- 확인: 기능 정상 동작, 시각적 피드백

### 7. 입력 필드 키보드 입력
- 텍스트, 숫자, 날짜 등 입력 필드에 키보드로 값을 입력한다
- 입력 전 → 입력 중 → 입력 완료 후 스크린샷
- 확인: 입력 반영, 유효성 검사 표시, 자동완성 동작

## 실행 방법

각 항목마다 Playwright 스크립트를 작성하여 실행한다:

```javascript
// playwright-keyboard-[항목명].js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file:///path/to/dist/index.html');

  // 인터랙션 전 스크린샷
  await page.screenshot({ path: 'step_archive/screenshots/keyboard/[항목]-before.png', fullPage: true });

  // 키보드 인터랙션 수행 예시
  await page.keyboard.press('Tab');                    // Tab 이동
  // await page.keyboard.press('Shift+Tab');           // 역방향
  // await page.keyboard.press('Enter');               // 활성화
  // await page.keyboard.press('Escape');              // 닫기
  // await page.keyboard.type('입력할 텍스트');         // 텍스트 입력

  // 인터랙션 후 스크린샷
  await page.screenshot({ path: 'step_archive/screenshots/keyboard/[항목]-after.png', fullPage: true });

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

이 지침을 완료한 즉시 자동으로 step088.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


