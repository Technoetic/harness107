---
name: step001
persistence: session
---

# Step 1 - 하네스 프리플라이트 체크

<!-- MOAI-ENRICHED v1 -->
> **🛠 TOOLING STEP** — 외부 도구 설치/검증. Plan-Run-Sync 분리 미적용.
> 모델 정책: **haiku** (조사·설치).
> SPEC 자동 생성: step_archive/specs/SPEC-001.md (Stop hook).

모든 도구 설치 검증, progress.json 초기화, .claude/ 경로 치환 맵을 확인한다.
**또한 본 세션의 사용자 프롬프트에서 튜토리얼 주제를 추출하여 `step_archive/TOPIC/TOPIC.md`에 고정한다 (이후 모든 Step이 참조).**

## 실행 내용

### 0. 튜토리얼 주제 픽업 (TOPIC.md 생성)

**이 Step의 가장 먼저 수행해야 할 작업이다.**

본 세션 진입 시 사용자가 던진 프롬프트에서 다음 항목을 추출한다:

- **주제(topic)**: 한 줄. 예) "데이터 압축과 부호화", "이미지 처리 알고리즘", "정규식 기초".
- **타깃 사용자(audience)**: "초보자 학습용" / "중급 개발자" 등.
- **인터랙티브 요구(interactive)**: 사용자가 명시한 경우 "필수" 등.
- **참고 사례(real_world_apps)**: "대중 앱 사례 참고" 등 사용자가 적시한 가이드.
- **기타 제약(constraints)**: "직관적", "단일 HTML", "다국어" 등.

**`step_archive/TOPIC/TOPIC.md`** 파일을 다음 형식으로 작성한다 (이미 있으면 덮어쓴다):

```markdown
---
created: <YYYY-MM-DD>
session_prompt: |
  <사용자 원문 프롬프트 전문 - 줄바꿈 그대로 보존>
---

# 튜토리얼 주제

- topic: <한 줄 요약>
- audience: <타깃>
- interactive: <필수/선택>
- real_world_apps: <참고 사례>
- constraints:
  - <제약 1>
  - <제약 2>

## 세부 의도

<2~5줄로 사용자 의도 정리>

## 후속 Step에서 본 파일을 참조하는 위치

- step016 (전체 조사): 주제를 기준으로 조사 키워드를 도출
- step025 (기획): 주제·타깃·제약을 기획 입력으로 사용
- step030 (통합 설계): 인터랙티브 요구와 디자인 제약 반영
- step037 (구현): 단일 HTML/번들 구조 결정에 반영
```

**사용자 프롬프트가 명확하지 않은 경우에도 질문하지 않는다.** `NEW-WORK-규칙.md` 1번 규칙에 따라 즉시 결정·기록한다. 모호한 항목은 "결정/사유" 줄에 1줄로 남긴다.

**`step_archive/TOPIC/TOPIC.md`가 이미 있고 본 세션 프롬프트와 모순되지 않으면** 그대로 둔다 (다른 세션에서 같은 주제로 재진입할 때 손실 방지).

### 1. 도구 설치 일괄 검증

다음 도구가 설치되어 있는지 확인한다. 미설치 시 자동 설치를 시도한다 (최대 3회 재시도).

| 도구 | 확인 명령 | 설치 명령 | 필수/선택 |
|:---|:---|:---|:---|
| Node.js | node --version | - | 필수 |
| npm | npm --version | - | 필수 |
| Playwright | npx playwright --version | npx playwright install chromium | 필수 |
| Biome | npx biome --version | npm i -D @biomejs/biome | 필수 |
| Stylelint | npx stylelint --version | npm i -D stylelint | 필수 |
| Vitest | npx vitest --version | npm i -D vitest | 필수 |
| c8 | npx c8 --version | npm i -D c8 | 선택 |
| jscpd | npx jscpd --version | npm i -D jscpd | 선택 |
| madge | npx madge --version | npm i -D madge | 선택 |
| tokei | tokei --version | scoop install tokei | 선택 |
| semgrep | semgrep --version | pip install semgrep | 선택 |

### 2. 실패 처리 정책

- **필수 도구 실패**: 3회 재시도 후에도 실패하면 사용자 개입 요청 (치명적 오류)
- **선택 도구 실패**: 경고 기록 후 계속 진행. 해당 도구가 필요한 Step에서 스킵 처리

### 3. progress.json 초기화 확인

step_archive/progress.json이 존재하면 로드하여 이전 진행 상태를 확인한다.
존재하지 않으면 step-progress-loader.ps1이 SessionStart 훅에서 자동 생성한다.

### 4. .claude/ 경로 치환 맵 확인

이후 Step에서 .claude/에 저장하라는 지시가 있으면 step_archive/로 경로를 치환한다.
치환 규칙:
- .claude/xxx.md -> step_archive/xxx.md
- step_archive/screenshots/ -> step_archive/screenshots/
- step_archive/ -> step_archive/ (이중 경로 방지)

### 5. 결과 기록

검증 결과를 step_archive/step001_preflight.md에 저장한다:
- 도구별 설치 상태 (OK/FAIL/SKIP)
- progress.json 상태 (NEW/RESUMED from stepNNN)
- 총 소요 시간

서브에이전트는 항상 haiku를 사용한다.

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step002.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.

