---
name: step041
persistence: session
---

# Step 41 - JavaScript 모듈화

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-041.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step041_*.md` 저장 후 1줄 완료 보고 `Step 041/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

구현된 JavaScript 코드를 Class 지향 모듈 시스템을 적용하여 **최대한** 분리한다.

## 비동기 처리 규칙 (필수)

모듈화와 동시에 모든 I/O·계산 경로를 **비동기(async)** 로 작성한다. 동기 블로킹 코드 금지.

### 적용 범위

- **데이터 로드**: `fetch()` + `await` 사용. 동기 XHR(`XMLHttpRequest` synchronous) 금지
- **파일/JSON 파싱**: `await response.json()` / `await response.text()`
- **이미지·폰트·아이콘 로드**: `Image.decode()`, `document.fonts.ready` 등 Promise 기반 API
- **무거운 계산**: 가능하면 `Web Worker` + `postMessage` 또는 `requestIdleCallback`로 분리
- **DOM 초기화**: `DOMContentLoaded` 이벤트 또는 `<script type="module" defer>` 활용
- **순차 의존성**: `await` 체인. 독립 작업은 `Promise.all()` 로 병렬화

### Class 설계 규칙

- 각 Class는 `async init()` 또는 `async load()` 메서드를 노출한다 (생성자에서는 동기 필드 초기화만)
- 외부 데이터가 필요한 메서드는 모두 `async` 키워드 명시
- 에러는 `try/catch` 또는 호출부 `.catch()`로 반드시 처리. unhandled Promise rejection 금지
- `constructor`에서 `await`/`fetch` 직접 호출 금지 → 정적 팩토리 `static async create()` 패턴 사용

### 앱 부트스트랩 패턴

```javascript
// 엔트리 모듈 (src/js/main.js 등)
async function bootstrap() {
  const [config, data, theme] = await Promise.all([
    ConfigLoader.load(),
    DataService.fetchAll(),
    ThemeManager.init(),
  ]);

  const app = await App.create({ config, data, theme });
  await app.render();
}

bootstrap().catch((err) => {
  console.error('[bootstrap]', err);
  document.body.dataset.bootError = err.message;
});
```

### 금지

- ❌ 최상위 동기 블로킹 (`while` 폴링, sync sleep)
- ❌ `.then()` 중첩 콜백 지옥 — 항상 `async/await`로 통일
- ❌ Promise를 만들어놓고 `await`/`then`/`catch` 없이 버리는 fire-and-forget (의도된 경우 반드시 `.catch(console.error)` 명시)
- ❌ 생성자에서 비동기 작업 시작 후 결과를 기다리지 않고 반환

## 파일 구조 규칙

- 소스 파일은 `src/` 디렉토리에 분리 유지 (개발 소스)
- 엔트리 HTML은 `src/index.html`에 작성하고 `<script src="js/...">`, `<link href="css/...">` 로 참조
- `dist/index.html`은 Step 81 빌드 단계에서 `.claude/hooks/html-bundler.ps1`이 자동 생성
- **직접 index.html에 인라인으로 합치는 것 금지** (번들러가 담당)

## 이유

file:// 프로토콜의 ES 모듈 CORS 제한은 번들러(html-bundler.ps1)가 dist/ 단계에서 해결한다.
소스 코드는 항상 분리된 파일로 유지한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) 모듈화를 수행한다.

**모듈화 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

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

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step042.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


