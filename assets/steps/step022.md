---
name: step022
persistence: session
---

# Step 22 - Awwwards 데이터 수집

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-022.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step022_*.md` 저장 후 1줄 완료 보고 `Step 022/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

## Step-Back

실행 전에 먼저 답하라:
- 이 조사의 핵심 목적이 무엇인가? (한 문장)
- 이 조사 결과가 이후 어느 Step에 영향을 주는가?
- 조사에서 반드시 확인해야 할 핵심 항목 3가지는?

## 실행 내용

Step 20에서 선정된 URL을 Playwright로 방문하여 스크린샷과 텍스트를 수집한다.

**필요한 파일:**

- `step_archive/step020_선정URL.md` (선정된 URL 목록)

## 수집 방법

`step_archive/step020_선정URL.md`를 Read하여 URL 목록을 획득하고, 각 URL에 대해:

1. Playwright 스크립트 작성·실행
2. 뷰포트별 스크린샷 촬영
3. 텍스트 콘텐츠 추출
4. 원본 데이터 파일 저장

**스크린샷 규칙:**

- 각 참고 사이트의 **모든 페이지**를 Playwright로 방문하여 뷰포트별 스크린샷을 촬영한다.
- **페이지 수집 규칙:**
  - 랜딩 페이지뿐 아니라 네비게이션에서 접근 가능한 모든 페이지를 촬영한다
  - 각 페이지마다 뷰포트별로 촬영한다
  - **SPA 대응:** 네비게이션 링크가 1개 이하인 경우 SPA로 판단하고 다음을 수행한다:
    - 페이지 전체를 스크롤하며 **모든 섹션을 빠짐없이** 촬영한다 (섹션명: `section1`, `section2`, ...)
    - 뷰포트 높이 단위로 스크롤하며 페이지 끝까지 촬영한다 — 섹션 수를 제한하지 않는다
    - 버튼/메뉴 클릭 등 인터랙션으로 전환되는 화면이 있으면 전환 후 상태도 촬영한다 (상태명: `open`, `active`, `expanded` 등)
    - 예: `awwwards-stripe-section2-desktop.png`, `awwwards-stripe-menu-open-mobile.png`
- **뷰포트 결정 규칙:**
  - 프로젝트 특성을 분석하여 필요한 뷰포트를 동적으로 결정한다
  - 반응형 프로젝트: 데스크톱 (1920×1080) + 태블릿 (768×1024) + 모바일 (390×844)
  - 비반응형 프로젝트: 데스크톱 (1920×1080)만
- **파일명 규칙:** `awwwards-{사이트명}-{페이지명}-{뷰포트}.png`
  - 사이트명: 소문자, 하이픈 구분, 도메인명 기반
  - 페이지명: 소문자, 하이픈 구분 (예: `home`, `about`, `features`, `pricing`)
  - 뷰포트: `desktop`, `tablet`, `mobile`
  - 예: `awwwards-stripe-home-desktop.png`, `awwwards-stripe-pricing-mobile.png`
- 저장 경로: `step_archive/screenshots/research/`
- 스크린샷 파일명 충돌 방지 (에이전트별 고유 prefix)
- **원본 텍스트 데이터 파일명 규칙:** `awwwards-{사이트명}-{내용}.txt`
  - 저장 경로: `step_archive/`
  - 예: `awwwards-bequant-ux.txt`, `awwwards-utopiatokyo-layout.txt`
- **스크린샷과 원본 데이터가 없으면 조사 무효!**

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개, URL별 병렬).

서브에이전트는 haiku를 사용한다.


## CoVe (Chain-of-Verification)

조사 완료 후 체크리스트:
- [ ] Step-Back에서 정의한 핵심 항목 3가지가 모두 조사되었는가?
- [ ] 조사 결과가 청크 파일에 빠짐없이 저장되었는가?
- [ ] 이후 Step에서 참조할 수 있는 형식으로 정리되었는가?

미완료 항목이 있으면 해당 항목만 재조사한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step023.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


