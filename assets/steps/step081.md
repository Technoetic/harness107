---
name: step081
persistence: session
---

# Step 81 - 빌드 검증: HTML 프로젝트 번들링

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-081.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step081_*.md` 저장 후 1줄 완료 보고 `Step 081/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

프로덕션 빌드가 정상적으로 되는지 확인한다.

## 실행 내용

`src/index.html` + `src/js/*.js` + `src/css/*.css` 구조인 경우:

1. `.claude/hooks/html-bundler.ps1` 실행 → `dist/index.html` 자동 생성
2. `dist/index.html`이 file:// 프로토콜에서 정상 동작하는지 Playwright로 확인

```powershell
powershell -ExecutionPolicy Bypass -File .claude/hooks/html-bundler.ps1
```text

**번들러 역할:**
- `src/js/*.js` → `<script>` 인라인 (export/import 자동 제거)
- `src/css/*.css` → `<style>` 인라인
- 결과물: `dist/index.html` (단일 파일, file:// 호환)

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) 빌드 검증을 수행한다.

**빌드 검증 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**검증:**
- `.claude/hooks/build-validator.ps1`에서 자동 검증
- HTML 프로젝트는 `dist/index.html` 존재 여부로 검증

**검증 실패 시:**
- 빌드 에러 분석
- 빌드 실패 원인 수정
- 검증 통과할 때까지 반복

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

이 지침을 완료한 즉시 자동으로 step082.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


