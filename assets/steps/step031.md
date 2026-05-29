---
name: step031
persistence: session
---

# Step 31 - 환경 준비

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-031.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step031_*.md` 저장 후 1줄 완료 보고 `Step 031/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

## 🔒 사전 조건 확인

**자동 실행 Hook:** `.claude/hooks/dependency-checker.ps1`

- 프로젝트 기술 스택 자동 감지 (package.json, requirements.txt 등)
- step030_레이아웃설계_chunk*.md (레이아웃 설계)에서 필요 라이브러리 추출
- step030_전체설계_chunk*.md (전체 설계)에서 필요 라이브러리 추출
- 설치 여부 자동 확인
- 실행 로그: `.claude/hooks/dependency-checker.log`

**⚠️ 미설치 패키지 발견 시:**

- Hook이 강제 실패 (exit 1)
- 설치 명령 자동 제안
- Claude에게 오류 전달

---

## 실행 내용

`dependency-checker.ps1`의 자동 검증 결과를 확인하고, 필요 시 패키지를 설치한다.

## Self-Calibration

실행 완료 후 다음을 스스로 평가하라:

- 이 Step의 목표가 100% 달성되었는가? (Y/N)
- 불확실한 부분이 있는가? (있으면 구체적으로 명시)
- N 또는 불확실한 부분이 있으면 재실행한다. 3회 재시도 후에도 미달이면 오류 기록 후 다음 Step 진행.

---

이 지침을 완료한 즉시 자동으로 step032.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


