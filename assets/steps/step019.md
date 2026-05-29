---
name: step019
persistence: session
---

# Step 19 - 참고 레포지토리 클론 및 코드 분석

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-019.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step019_*.md` 저장 후 1줄 완료 보고 `Step 019/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

Step 17 조사결과에서 발견한 참고 레포지토리를 클론하고, 핵심 패턴을 실제 코드로 확인한다.

## Step-Back

실행 전에 먼저 답하라:
- 이 조사의 핵심 목적이 무엇인가? (한 문장)
- 이 조사 결과가 이후 어느 Step에 영향을 주는가?
- 조사에서 반드시 확인해야 할 핵심 항목 3가지는?

## 절차

1. `step_archive/step017_조사결과_chunk*.md` 파일들을 읽어 참고할 레포지토리 URL 목록을 추출한다
2. `step_archive/references/` 디렉토리에 shallow clone (`--depth 1`)으로 클론한다
3. 클론한 레포에서 다음을 분석한다:
   - 디렉토리 구조 (`tree` 또는 `ls -R`)
   - 핵심 설정 파일 (package.json, tsconfig.json, 빌드 설정 등)
   - 주요 진입점 및 라우팅 패턴
   - 컴포넌트/모듈 구조
   - 상태 관리 방식
4. 분석 결과를 청크 단위로 기록한다

## 규칙

- **shallow clone만 사용** (`git clone --depth 1`) — 용량 절약
- 클론 대상 디렉토리: `step_archive/references/<repo-name>/`
- 이미 클론된 레포는 스킵
- 클론 실패 시 에러 기록 후 다음 레포로 진행
- 최대 5개 레포까지만 클론 (가장 관련도 높은 순)
- 분석 결과는 이후 설계/구현 Step에서 직접 참조할 수 있도록 구체적으로 작성

**분석 결과는 청크 단위로 저장한다:**

```text
step019_조사결과_chunk1.md (500줄 이하)
step019_조사결과_chunk2.md (500줄 이하)
step019_조사결과_chunk3.md (500줄 이하)
...
```text

**작성 규칙**:
- 각 청크는 500줄 이하로 작성 (성능 최적화)
- `.claude/hooks/research-validator.ps1`에서 각 청크 검증 (BOM/CRLF/줄수/파일크기)
- 청크 그대로 유지 (병합 안 함)

## 분석 결과 파일 형식

```markdown
## Step 19 - 참고 레포 코드 분석 (chunk N)

## 클론 현황 (chunk1에만 포함)
| 레포 | 경로 | 상태 |
|------|------|------|
| owner/repo | step_archive/references/repo/ | 성공/실패 |

## 레포별 분석

### 1. owner/repo
- **디렉토리 구조**: ...
- **기술 스택**: ...
- **핵심 패턴**: ...
- **우리 프로젝트에 적용할 점**: ...
```text

서브에이전트는 항상 haiku를 사용한다.

## CoVe (Chain-of-Verification)

조사 완료 후 체크리스트:
- [ ] Step-Back에서 정의한 핵심 항목 3가지가 모두 조사되었는가?
- [ ] 조사 결과가 청크 파일에 빠짐없이 저장되었는가?
- [ ] 이후 Step에서 참조할 수 있는 형식으로 정리되었는가?

미완료 항목이 있으면 해당 항목만 재조사한다.

---

이 지침을 완료한 즉시 자동으로 step020.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


