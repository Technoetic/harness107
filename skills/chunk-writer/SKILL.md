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

예: step001_context전략_chunk1.md, step035_파일인덱스_chunk2.md

### 저장 경로
- 기본: step_archive/
- .claude/에 저장하라는 지시가 있으면 step_archive/로 경로 치환

### 크기 제한
- 각 청크: 최대 500줄
- 각 청크: 최대 50KB
- 내용이 500줄을 초과하면 논리적 단위로 분할

### 인코딩
- UTF-8 (BOM 없음)
- LF 줄바꿈 (CRLF 금지)

### 검증
- 저장 후 research-chunk-validator.ps1이 PostToolUse 훅으로 자동 검증
- 검증 실패 시 즉시 수정하고 재저장

### Python write_text 사용

