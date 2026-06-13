---
name: chunk-writer
description: 조사/설계/구현 결과를 500줄 이하 청크 파일로 분할 저장하는 스킬. Step에서 청크 단위 저장이 요구될 때 자동 활성화.
disable-model-invocation: false
---

# Chunk Writer 스킬

## 트리거 조건
- Step 지시문에 "청크 단위로 저장" 문구가 포함될 때
- 출력 내용이 500줄을 초과할 때

## 청크 작성 규칙

### 파일명 패턴

`stepNNN_<주제>_chunkN.md` (NNN은 3자리 step 번호, N은 1부터 증가)

예: step001_context전략_chunk1.md, step035_파일인덱스_chunk2.md

### 저장 경로
- 기본: step_archive/
- .claude/에 저장하라는 지시가 있으면 step_archive/로 경로 치환

### 크기 제한
- 각 청크: 최대 499줄 (CLAUDE.md "500줄 이상 전체 읽기 금지" 규칙과 정합 —
  최대 크기 청크도 Read 1회로 전체 열람 가능해야 함)
- 각 청크: 최대 50KB
- 내용이 499줄을 초과하면 논리적 단위로 분할

### 인코딩
- UTF-8 (BOM 없음)
- LF 줄바꿈 (CRLF 금지)

### 검증
- 저장 후 research-chunk-validator.ps1이 PostToolUse(Write|Edit) 훅으로 자동 검증
  (2026-06-10부터 실바인딩 — 규격 위반 시 additionalContext로 교정 지시가 주입됨)
- 수동 재검증: `powershell -File .claude/hooks/research-chunk-validator.ps1 -FilePath <경로>`
- 검증 실패 시 즉시 수정하고 재저장

### 파일 쓰기 도구
- Write/Edit 도구를 기본으로 사용한다 (전역 CLAUDE.md 파일 쓰기 규칙).
- python -c + pathlib write_text는 Write/Edit 도구가 차단된 특수 상황에서만 보조 수단으로 허용.