---
name: step103
persistence: session
---

# Step 103 - Playwright 접근성 검증 스크립트 참조

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-103.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step103_*.md` 저장 후 1줄 완료 보고 `Step 103/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

이 Step은 실행 단위가 아닌 **참조 자료**다. step102(접근성 테스트) 실행 중 WCAG 대비율 전수 검증에 필요한 Playwright 코드 스니펫을 §1~§10으로 정리한 것이다.

**진행 방식:** 이 파일을 Read한 뒤 별도 작업 없이 즉시 step104.md로 진행한다. 실제 스크립트는 step102 실행 중 필요할 때 복사하여 사용한다.

---

## §1 기본 대비율 계산 (모든 텍스트 요소)

페이지의 모든 텍스트 요소를 수집하여 computed color/background 기준으로 대비율을 계산하고 WCAG AA 위반 목록을 반환한다.

```javascript
const selectors = 'p, span, td, th, h1, h2, h3, h4, h5, h6, a, button, label, li';

const results = await page.evaluate((sel) => {
  function luminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map(c => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  function contrastRatio(rgb1, rgb2) {
    const l1 = luminance(...rgb1);
    const l2 = luminance(...rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function parseRgb(str) {
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  function getEffectiveBg(el) {
    let current = el;
    while (current) {
      const bg = window.getComputedStyle(current).backgroundColor;
      const rgb = parseRgb(bg);
      if (rgb && !(rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0
          && bg.includes('0)'))) {
        if (!bg.includes(', 0)') && bg !== 'transparent') return rgb;
      }
      current = current.parentElement;
    }
    return [255, 255, 255];
  }

  const elements = document.querySelectorAll(sel);
  const failures = [];
  for (const el of elements) {
    const text = el.innerText?.trim();
    if (!text) continue;
    const style = window.getComputedStyle(el);
    const fgRgb = parseRgb(style.color);
    if (!fgRgb) continue;
    const bgRgb = getEffectiveBg(el);
    const ratio = contrastRatio(fgRgb, bgRgb);
    const fontSize = parseFloat(style.fontSize);
    const fontWeight = parseInt(style.fontWeight) || 400;
    // WCAG 2.1 SC 1.4.3 large text 기준:
    //   - 18pt(24px) 이상 → large
    //   - 14pt(18.67px) 이상 + font-weight >= 700(bold) → large
    // font-weight 600(semi-bold)은 large text 미해당 → threshold 4.5 적용
    const isLarge = fontSize >= 24 || (fontSize >= 18.67 && fontWeight >= 700);
    const threshold = isLarge ? 3.0 : 4.5;
    if (ratio < threshold) {
      failures.push({
        text: text.substring(0, 50),
        fg: `rgb(${fgRgb})`,
        bg: `rgb(${bgRgb})`,
        ratio: Math.round(ratio * 100) / 100,
        threshold,
        selector: el.tagName + (el.className ? '.' + el.className.split(' ')[0] : '')
      });
    }
  }
  return failures;
}, selectors);
```

---

## §2 인터랙션 상태 검증 (hover / focus)

기본 상태만으로는 hover/focus 전환 시 색상 변화를 못 잡는다. 각 상태를 시뮬레이션한 뒤 §1의 계산 루프를 재실행한다.

```javascript
// hover
const interactiveSelectors = 'a, button, [role="button"], tr[data-hover], .role-card';
const interactiveEls = await page.$$(interactiveSelectors);
for (const el of interactiveEls) {
  await el.hover();
  await page.waitForTimeout(350); // transition 완료 대기
  // §1의 대비율 검증 로직 실행
}

// focus
const focusableSelectors = 'a, button, input, select, textarea, [tabindex]';
const focusableEls = await page.$$(focusableSelectors);
for (const el of focusableEls) {
  await el.focus();
  // 포커스 링 색상 + 텍스트 대비율 검증
}
```

---

## §3 배경 이미지 / 그라데이션 / 필터 / 블렌드 플래그

`backgroundColor`만으로는 잡히지 않는 시각 배경을 식별한다. 플래그된 요소는 스크린샷 기반 픽셀 샘플링 또는 수동 검토 목록으로 이관한다.

```javascript
function hasVisualBackground(el) {
  const style = window.getComputedStyle(el);
  const bgImage = style.backgroundImage;
  const hasGradient = bgImage && bgImage !== 'none';
  const hasFilter = style.filter && style.filter !== 'none';
  const hasOpacity = parseFloat(style.opacity) < 1;
  const hasBlend = style.mixBlendMode && style.mixBlendMode !== 'normal';
  return { hasGradient, hasFilter, hasOpacity, hasBlend };
}
```

- `backgroundImage !== 'none'` → 스크린샷 기반 픽셀 샘플링으로 재검증
- `opacity < 1` 또는 `filter !== 'none'` → computed color와 실제 렌더 색이 달라질 수 있음, 플래그 출력
- `mix-blend-mode !== 'normal'` → 자동 검증 불가, 수동 검토 목록

---

## §4 pseudo-element 배경 검증

`::before` / `::after`가 배경 역할을 하는 경우를 잡는다. 불투명 pseudo 배경이 있으면 해당 색상을 기준으로 §1의 대비율을 재계산한다.

```javascript
function checkPseudoBg(el) {
  const before = window.getComputedStyle(el, '::before');
  const after = window.getComputedStyle(el, '::after');
  const pseudoBgs = [];
  for (const [name, ps] of [['::before', before], ['::after', after]]) {
    if (ps.content !== 'none' && ps.content !== '""') {
      const bg = ps.backgroundColor;
      if (bg && bg !== 'transparent' && !bg.includes(', 0)')) {
        pseudoBgs.push({ pseudo: name, bg });
      }
    }
  }
  return pseudoBgs;
}
```

---

## §5 스크롤 영역 검증

viewport 밖 요소도 검사 대상이다. 전체 높이를 viewport 단위로 스크롤하며 §1 루프를 반복한다.

```javascript
const totalHeight = await page.evaluate(() => document.body.scrollHeight);
const viewportHeight = 800;
for (let y = 0; y < totalHeight; y += viewportHeight) {
  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
  await page.waitForTimeout(200);
  // 현재 viewport에 보이는 요소들에 대해 §1 실행
}
```

---

## §6 반응형 브레이크포인트 검증

최소 3개 viewport(모바일/태블릿/데스크톱)에서 §1~§5를 반복한다.

```javascript
const viewports = [
  { width: 375, height: 812, name: 'mobile' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 1280, height: 800, name: 'desktop' },
];
for (const vp of viewports) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.waitForTimeout(500);
  // 각 viewport에서 전체 대비율 검증 실행
}
```

---

## §7 테마 전환 검증

다크/라이트 모드 지원 시 양쪽 모두 검증. 프로젝트 테마 토글과 `prefers-color-scheme` 에뮬레이션을 모두 수행한다.

```javascript
// 프로젝트 테마 토글이 있으면: 라이트 → 전체 검증 → 다크 → 전체 검증
// prefers-color-scheme 에뮬레이션:
await page.emulateMedia({ colorScheme: 'light' });
// 검증 실행
await page.emulateMedia({ colorScheme: 'dark' });
// 검증 실행
```

---

## §8 멀티 브라우저 검증

Chromium 외 브라우저에서 색상 렌더링이 다를 수 있다. Playwright 3개 엔진 모두 검증한다.

```javascript
const browsers = [
  { engine: chromium, name: 'Chromium' },
  { engine: firefox, name: 'Firefox' },
  { engine: webkit, name: 'WebKit' },
];
for (const { engine, name } of browsers) {
  const browser = await engine.launch();
  // 각 브라우저에서 §1~§7 실행
}
```

---

## §9 비동기 로딩 대기

API 응답 후 렌더링되는 요소를 놓치지 않도록 대기 체인을 적용한 뒤 §1을 실행한다.

```javascript
// 1. networkidle 대기
await page.goto(url, { waitUntil: 'networkidle' });

// 2. 로딩 스피너/스켈레톤 소멸 대기
await page.waitForSelector('[data-loading]', { state: 'detached', timeout: 5000 }).catch(() => {});

// 3. DOM 변경 정착 대기
await page.waitForTimeout(1000);

// 4. §1 실행
```

---

## §10 자동 검증 불가 → 수동 검토 목록

다음 케이스는 자동 대비율 계산이 불가능하다. 해당 요소 목록을 출력하여 수동 확인한다.

- `background-image: url(...)` 위의 텍스트 → 픽셀 샘플링 필요
- `mix-blend-mode`가 적용된 요소
- canvas / SVG 내부 텍스트
- 동영상 / 애니메이션 위 오버레이 텍스트
- CSS transition 중간 프레임 색상
- 사용자 시스템 설정(고대비 모드, 색상 반전, 다크 리더) 변형

---

이 지침을 완료한 즉시 자동으로 step104.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


