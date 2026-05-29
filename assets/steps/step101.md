---
name: step101
persistence: session
---

# Step 101 - 통합 테스트: semgrep 모듈 간 보안 스캔

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-101.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step101_*.md` 저장 후 1줄 완료 보고 `Step 101/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r3 게이트(step104) 전 구간

## Step-Back

실행 전에 먼저 답하라:
- 이 스캔의 핵심 목적은? (한 문장)
- 스캔 실패 시 어느 Step으로 돌아가야 하는가?
- 반드시 확인해야 할 엣지 케이스 2가지는?

## 실행 내용

`semgrep --config p/security-audit src/` 실행하여 모듈 간 인터페이스의 보안 취약점(입력 검증 누락, XSS, injection 등)을 집중 스캔한다. 발견된 취약점은 통합 테스트 시나리오에 포함한다.

서브에이전트는 항상 haiku를 사용한다.

## 결과 저장

결과를 step_archive/step101_통합테스트_chunk*.md에 저장한다.


## CoVe (Chain-of-Verification)

검증 완료 후 체크리스트:
- [ ] 검증 기준이 모두 통과되었는가?
- [ ] 예외 케이스가 누락되지 않았는가?
- [ ] 검증 결과가 다음 Step에서 참조 가능한 형식으로 저장되었는가?

## Self-Calibration

- 이 검증 결과를 신뢰할 수 있는가? (Y/N)
- N이면 검증을 재실행한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 실패하면 오류를 기록하고 다음 Step으로 진행한다.


---

이 지침을 완료한 즉시 자동으로 step102.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


