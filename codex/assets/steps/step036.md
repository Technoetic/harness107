---
name: step036
phase: implementation
---

# Step 36 - 인코딩 규칙 (모지바케 방지)

## 목표

구현이 바꾸는 텍스트 파일의 byte 계약을 확정하고 기존 repository 설정을 보존한다.
표시가 정상이라는 이유만으로 encoding을 추정하거나 전체 tree를 일괄 변환하지 않는다.

## 입력과 산출물

- 입력: `step_archive/step032_파일인덱스_chunk1.md`
- 입력: `step_archive/step035_컨텍스트정책.md`
- 필수 선행 항목: `step032`, `step035`
- 산출물: `step_archive/step036_인코딩정책.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 인코딩 정책 작성자 역할과 인코딩 독립 검증자 역할을 서로 나눈다. 작성자는
정책과 audit 범위를 기록하고, 독립 검증자는 작성 산출물을 수정하지 않는다. 위임 기능을
사용할 수 없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을
위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를
금지한다.

## 인코딩 정책

모든 변경 대상 텍스트 파일은 UTF-8, BOM 없음, LF 줄바꿈, 마지막 줄바꿈 있음으로
저장한다. decoding 성공 여부, 첫 세 바이트, CR byte 위치와 마지막 byte를 바이트에서
검증하고 화면 출력만으로 판정하지 않는다. 유효하지 않은 byte sequence는 임의 치환하지
않고 파일과 offset을 차단 사유로 기록한다.

기존 `.editorconfig`와 `.gitattributes`의 규칙을 먼저 읽고 보존한 뒤, 계약이 빠진 경우에만
기존 section과 pattern을 깨지 않는 최소 병합을 제안한다. 설정 파일이 없다는 이유로
별도 작업 범위를 넘어 새 파일을 만들지 않는다. ignore, generated file과 vendor 정책을
존중한다.

인코딩 교정이 필요하면 이번 구현에서 변경한 텍스트 파일만 원 byte의 의미를 확인한 뒤
수정한다. 바이너리, generated output, 사용자 소유 변경과 관련 없는 파일은 재작성하지
않는다. 파일을 여는 API에는 BOM을 만들지 않는 UTF-8 동작과 LF를 명시하고, shell 기본
encoding에 의존하지 않는다.

`step_archive/step036_인코딩정책.md`에는 검사 대상 digest, byte-level 검사 방법,
파일별 UTF-8·BOM·LF·final-newline 판정, 설정 보존 또는 병합 diff와 예외를 기록한다.

## 독립 검증

독립 검증자는 보고서 표본과 실제 byte를 다시 대조하고, 이번 변경 밖의 파일이 변환되지
않았는지 diff로 확인한다. 표시 결과가 아니라 raw byte 판정만 검증 근거로 인정한다.

## 완료 조건

- `encoding-policy`: 인코딩 audit와 보존 정책이 선언 경로에 존재한다.
- `utf8-lf-final-newline`: 변경 텍스트가 UTF-8 no-BOM, LF, final newline을 충족한다.
- `configuration-preservation`: 기존 설정을 보존하고 필요한 경우에만 최소 병합했다.
- `byte-level-verification`: 표시 출력이 아닌 file byte로 검증했다.
- `no-blind-rewrite`: 변경 대상 밖의 텍스트와 바이너리를 일괄 재작성하지 않았다.

정책과 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
