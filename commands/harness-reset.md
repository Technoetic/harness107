---
description: harness107 진행 상태 리셋 — progress.json을 current_step=1, completed=[]로 초기화. step_archive/archived/ 본문은 건드리지 않는다.
---

# /harness-reset

`step_archive/progress.json`을 다음 형식으로 덮어쓴다:

```json
{
  "current_step": 1,
  "completed_steps": [],
  "skipped_steps": [],
  "failed_steps": [],
  "total_steps": 50,
  "metrics": { "total_duration_minutes": 0, "total_sessions": 0, "steps_per_session_avg": 0 },
  "trust5_results": { "r1": null, "r2": null, "r3": null },
  "eval_rounds": {
    "r1": { "step": 49,  "result": null, "score": null },
    "r2": { "step": 69,  "result": null, "score": null },
    "r3": { "step": 104, "result": null, "score": null }
  },
  "session_history": [],
  "last_updated": "<현재 ISO>"
}
```

## 보존 대상 (삭제 금지)

- `step_archive/archived/step001~050.md` (본문 그대로)
- `step_archive/specs/SPEC-*.md` (자동 생성된 SPEC들)
- `step_archive/outputs/trust5_r*.md` (Trust5 결과)
- `step_archive/TOPIC/TOPIC.md` (사용자가 명시 삭제 요청 시에만)

## 출력

1줄 보고: `harness107 리셋 완료 — step001부터 재시작 가능`

추가 출력·확인 질문 금지.
