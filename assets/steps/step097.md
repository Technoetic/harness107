---
name: step097
persistence: session
---

# Step 97 - 비주얼 리그레션 테스트

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-097.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step097_*.md` 저장 후 1줄 완료 보고 `Step 097/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

코드 변경 전후의 스크린샷을 픽셀 단위로 비교하여 의도치 않은 UI 변경을 자동으로 감지한다.

Playwright의 스크린샷 비교 기능 또는 프로젝트에 적합한 비주얼 리그레션 도구를 동적으로 선택한다.

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**변경률 기준 초과 시 통과 처리 금지.**

## 사전 분석 (동적 결정)

1. **기준 스크린샷 수집**
   - 현재 상태의 모든 페이지/뷰/라우트 스크린샷을 기준(baseline)으로 촬영
   - 반응형 브레이크포인트별 촬영 (mobile 375px, tablet 768px, desktop 1280px)
   - 모달/토글 등 인터랙션 상태별 촬영

2. **비교 도구 선택**
   - Playwright `toHaveScreenshot()` (내장, 추가 설치 불필요)
   - 또는 `pixelmatch`, `reg-suit` 등 프로젝트 특성에 맞는 도구

3. **허용 임계값 결정**
   - 프로젝트 특성에 따라 동적 설정
   - 기본: 픽셀 변경률 **0.1% 이하** PASS
   - 폰트 렌더링/안티앨리어싱 노이즈 감안한 threshold 설정

## 실행 절차

### 1단계: 기준 스크린샷 촬영

Playwright로 전 페이지 기준 스크린샷 촬영 및 저장:

```javascript
// 각 페이지, 각 viewport에서 촬영
const viewports = [
  { width: 375, height: 812, name: 'mobile' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 1280, height: 800, name: 'desktop' },
];
```text

### 2단계: 코드 변경 후 비교 스크린샷 촬영

동일한 조건으로 재촬영

### 3단계: 픽셀 diff 비교

1. 기준 스크린샷 vs 비교 스크린샷 픽셀 단위 비교
2. 변경된 픽셀 수 / 전체 픽셀 수 = 변경률 산출
3. diff 이미지 생성 (변경 부분 강조 표시)

### 4단계: 판정

- **변경률 ≤ 임계값** → PASS
- **변경률 > 임계값** → FAIL
  - diff 이미지 분석하여 변경 위치 특정
  - 의도된 변경인지 확인
  - 의도하지 않은 변경이면 수정 후 재비교

### 5단계: 기준 스크린샷 갱신

의도된 UI 변경이 있었으면 기준 스크린샷을 새 버전으로 갱신

## 검증 대상

- ✅ 모든 페이지 기본 상태
- ✅ 반응형 브레이크포인트 (mobile, tablet, desktop)
- ✅ 모달/드롭다운/토글 열린 상태
- ✅ hover/focus 상태 (인터랙티브 요소)
- ✅ 스크롤 영역 (full-page 스크린샷)

## ❌ 금지

- 변경률 기준 초과 상태로 통과 처리 금지
- diff 이미지 확인 없이 "사소한 차이"로 무시 금지
- 기준 스크린샷 없이 비교 실행 금지
- 애니메이션/transition 중간 상태에서 촬영 금지 (안정 상태에서만)

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개).

서브에이전트는 항상 haiku를 사용한다.

## 결과 저장

결과를 step_archive/step097_비주얼리그레션_chunk*.md에 저장한다.

## CoVe (Chain-of-Verification)

검증 완료 후 체크리스트:
- [ ] 검증 기준이 모두 통과되었는가?
- [ ] 예외 케이스가 누락되지 않았는가?
- [ ] 검증 결과가 다음 Step에서 참조 가능한 형식으로 저장되었는가?

## Self-Calibration

- 이 검증 결과를 신뢰할 수 있는가? (Y/N)
- N이면 검증을 재실행한다.

---

이 지침을 완료한 즉시 자동으로 step098.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


