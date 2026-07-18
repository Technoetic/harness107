---
description: harness50 진행 상태 조회 — 현재 step / 완료 step 수 / Trust5 결과
---

# /harness-status

`step_archive/progress.json`을 읽어 한 줄로 보고:

```
harness50: <completed>/50 완료 | current=stepNNN | r1=AA/50 r2=BB/50 r3=CC/50
```

- progress.json 없으면: "harness50 비활성 — /webapp <주제> 로 시작"
- Trust5 결과는 `step_archive/outputs/trust5_r{1,2,3}.md` 존재 시에만 표기

추가 출력 금지. 1줄 보고만.
