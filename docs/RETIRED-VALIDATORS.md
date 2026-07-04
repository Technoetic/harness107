# 참조되지만 번들되지 않는 검증기 (retired / 수동 폴백)

harness107의 일부 step 본문은 아래 `*-validator.ps1` / `*-checker.ps1` 스크립트 실행을
지시하지만, **플러그인은 이들을 번들하지 않는다.** 과거 원본 프로젝트(`.claude/hooks/`)에서
개발용으로 쓰이던 검증기들의 잔존 참조이며, 배포 플러그인의 `hooks/`에는 다음 3개만 실존한다:

- `mx-tag-validator.ps1` / `.sh` (PostToolUse 바인딩)
- `trust5-validator.ps1` / `.sh` (Stop 바인딩)
- `html-bundler.ps1` / `.sh` (step037/038/081에서 호출, 부트스트랩 시 `step_archive/tools/`로 복사)

## 정책 (약속-실제 정합, 2026-07 평가 반영)

- step 본문이 아래 검증기를 실행 지시하더라도 **부재 시 해당 단계는 fail-open**한다:
  검증기를 건너뛰고 다음 단계로 진행한다. 자율주행이 이로 인해 멈추지 않는다.
- 실제 품질 검증이 필요하면 사용자가 대응 **CLI를 수동 실행**한다. 대부분 표준 도구다:
  - `tokei` (LOC), `c8` (커버리지), `@biomejs/biome` (lint/format), `stylelint`,
    `semgrep` (보안), `playwright` + `@axe-core/playwright` (E2E/접근성),
    `jscpd` (중복), `madge`/`knip` (데드코드/의존성), `@lhci/cli` (Lighthouse)
- 이 목록은 `AGENTS.md`의 "프로젝트 의존성(1회)" 설치 명령과 일치한다.

## 참조되지만 미번들된 스크립트 (24종)

| 스크립트 | 대응 실제 도구 | 참조 step(예) |
|:---|:---|:---|
| tokei-validator.ps1 | `tokei` | step011 |
| dependency-checker.ps1 | `madge` / `knip` | step031 |
| research-chunk-validator.ps1 | (청크 500줄 규칙 — chunk-writer 스킬) | 조사 step 다수 |
| research-validator.ps1 | (수동 검토) | 조사 step |
| build-validator.ps1 | `html-bundler.ps1` + Playwright | step081 (본문에 retired 명시됨) |
| c8-validator.ps1 | `c8` | 디버깅 step |
| biome-validator.ps1 / linting-validator.ps1 / formatting-validator.ps1 | `biome check` | 구현 step |
| stylelint-validator.ps1 | `stylelint --fix` | CSS step |
| semgrep-validator.ps1 | `semgrep --config=auto` | 보안 step |
| playwright-validator.ps1 / e2e-validator.ps1 / ui-regression-validator.ps1 | `playwright test` | 검증 step |
| accessibility-validator.ps1 / axe-core-validator.ps1 | `@axe-core/playwright` | 접근성 step |
| jscpd-validator.ps1 | `jscpd` | 중복 검사 step |
| madge-validator.ps1 / knip-validator.ps1 / deadcode-validator.ps1 | `madge` / `knip` | 데드코드 step |
| lhci-validator.ps1 / load-test-validator.ps1 | `@lhci/cli` | 성능 step |
| type-safety-validator.ps1 | `tsc --noEmit` | 타입 step |
| refactoring-validator.ps1 / step03-validator.ps1 | (수동 검토) | 리팩터/조사 step |

> **정직성 노트**: 향후 이 검증기들을 실제 훅으로 구현하거나 step 본문을 위 CLI 직접 호출로
> 치환하는 것이 로드맵이다. 현재는 부재를 감추지 않고 fail-open으로 명시한다.
