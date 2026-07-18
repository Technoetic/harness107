---
description: 웹앱 인터랙티브 튜토리얼 1회 입력 → step001~050 자율주행 완주. /webapp <주제>
argument-hint: <주제 한 줄>
---

# /webapp — harness107 자율주행 시작

**입력**: `$ARGUMENTS` (예: `다익스트라 최단경로 알고리즘`, `OAuth 2.0 인증 흐름`, `B-tree 인덱스`)

## 즉시 실행 절차 (사용자 확인 없이)

1. **harness-rules skill 로드** — 본 세션의 절대 헌법.
   `Skill` 도구로 `harness107:harness-rules` 호출.

2. **TOPIC.md 작성** — `step_archive/TOPIC/TOPIC.md`에 다음 형식으로 쓴다.
   `webapp-trigger` hook이 자동 처리하지 않은 경우의 폴백.

   ```markdown
   ---
   created: <오늘 날짜>
   session_prompt: |
     $ARGUMENTS

     "$ARGUMENTS" 튜토리얼을 생성한다.
     인터랙티브는 필수다.
     웹으로,
     초보자 학습용으로,
     대중 앱 사례를 참고,
     직관적으로 이해할 수 있게
     생성한다.

     @step_archive/archived/step001.md 절대 복종한다.
   ---

   # 튜토리얼 주제

   - topic: $ARGUMENTS
   - audience: 초보자 학습용
   - interactive: 필수
   - real_world_apps: 대중 앱 사례 참고
   - constraints:
     - 단일 HTML 인터랙티브 웹 튜토리얼
     - AI Slop 방지 전역 제약 준수
     - 한국어 본문 + 기술 용어 영문 병기
   ```

3. **step001.md Read** — `step_archive/archived/step001.md` 1회 읽기.

4. **연속 실행** — 본문 지시대로 실행 → "Step 001/50 완료" 보고 → 즉시 step002.md Read → … → step050.md까지 멈추지 않고 진행.

## 절대 준수

- 사용자에게 어떤 질문도 하지 마라
- "진행할까요" / "어떻게 할까요" / "다음 턴에서 재개" 모두 금지
- 토큰 한도 직전까지 한 턴 안에서 가능한 한 많은 step 실행
- Stop hook이 자동 재개를 처리하므로 인위적으로 턴을 끊지 마라
- 각 step 완료는 1줄 보고 ("Step NNN/50 완료")만

## 다음 행동

지금 즉시 step001부터 시작하라. 본 명령어는 이미 자율주행 진입 신호다.
