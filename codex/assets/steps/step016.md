---
name: step016
phase: research
---

# Step 16 - 전체 조사

## 목표

주제와 현재 프로젝트에 맞는 기술·학습·실제 적용 사례를 웹 근거로 조사하고, 이후
기획에서 다시 확인할 수 있는 원본 자료와 캡처를 남긴다. 사전 지식만으로 사실을
채우지 않으며 이 단계에서는 조사 외 산출물을 만들지 않는다.

## 입력과 산출물

- 입력: `step_archive/TOPIC/TOPIC.md`
- 입력: `step_archive/step001_preflight.md`
- 입력: `step_archive/step002_context전략_chunk1.md`
- 필수 선행 항목: `step001`, `step002`
- 선택 선행 항목: `step011`
- 산출물: `step_archive/step016_조사결과_chunk1.md`
- 산출물: `step_archive/research-raw-step016-primary.txt`
- 산출물: `step_archive/screenshots/research/step016-primary.png`
- 선택 산출물: `step_archive/tokei-baseline.json`
- 네트워크: 필수
- 시각 검토: 필요하지 않다. 스크린샷은 수집 증거로만 사용한다.

## 실행 역할

가능한 경우 조사 질문별 수집 역할과 수집 결과를 원본과 대조하는 독립 검토 역할을
현재 단계 범위 안에서 나눈다. 각 수집 역할은 맡은 출처만 조사하고, 독립 검토
역할은 URL·원본·캡처가 결론을 실제로 뒷받침하는지 확인한다. 역할을 나눠도
정상 권한 확인은 유지한다. 위임 기능을 사용할 수 없으면 현재 실행자가 수집과 독립
검토를 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.

## 조사 범위 결정

가장 먼저 주제 입력에서 `topic`, `audience`, `real_world_apps`, `constraints`를 확인하고
컨텍스트 전략에 기록된 프로젝트 구조와 연결한다. 시작 전에 다음 세 항목을 조사
청크에 적는다.

- 조사의 핵심 목적 한 문장
- 이후 의사결정에 제공할 근거
- 반드시 확인할 핵심 항목 세 가지

핵심 항목별로 서로 겹치지 않는 질문을 만들고, 실제 관련성이 있는 출처를 항목당
최대 세 개까지 수집한다. `real_world_apps`에 적힌 사례와 대상 독자에게 적합한 학습
자료를 우선한다. GitHub 저장소 검색은 별도의 조사 범위이므로 여기서는 수행하지
않는다.

## 웹 증거 수집

지원되는 웹 또는 브라우저 수집 기능으로 각 출처를 실제 방문한다. 첫 번째 핵심
출처의 본문 원문은 `step_archive/research-raw-step016-primary.txt`에, 화면 캡처는
`step_archive/screenshots/research/step016-primary.png`에 저장한다. 나머지 동적 원본과
캡처 경로는 첫 청크의 manifest에 기록한다.

각 출처 기록에는 요청 URL, 최종 URL, 출처 이름, 원본 경로, 캡처 경로, HTTP 결과,
수집 시각을 포함한다. 모든 사실 주장은 URL과 출처, 원본 또는 캡처의 정확한 위치로
추적되어야 한다. 접근하지 않은 페이지의 내용이나 누락된 응답을 추정하지 않는다.
증거를 발명하지 않는다.

네트워크 기능이나 필수 브라우저 수집 기능을 사용할 수 없으면 정상 권한 확인 아래
최대 세 번만 재시도한다. 그래도 실제 자료와 필수 산출물을 얻지 못하면 원인과
사용자 조치를 청크에 기록하고 이 단계를 완료하지 않는다.

## 코드 규모 기준선

11단계 보고서가 tokei의 검증된 `OK`를 기록한 경우에만 다음 명령을 실행할 수 있다.

```text
tokei src/ --output json
```

성공한 JSON은 `step_archive/tokei-baseline.json`에 저장한다. 11단계가 이유 있는
`SKIP`을 기록했거나 현재 프로젝트에 `src/`가 없으면 이 선택 산출물을 강제하지
않는다. 대신 2단계의 파일·줄 수 집계 근거와 제한 사항을 조사 청크에 기록한다.
tokei가 실행되지 않았는데 결과를 만들어 내거나 선택 기능의 부재 때문에 이 단계를
차단하지 않는다.

## 청크 계약

첫 결과는 `step_archive/step016_조사결과_chunk1.md`에 저장한다. 500줄을 넘기 전에
`step016_조사결과_chunk2.md`처럼 새 청크를 만들고, 첫 청크의 manifest에 모든 청크,
줄 수, 주제, 원본 및 캡처 경로를 기록한다. 각 청크는 500줄 이하여야 하며 병합하지
않는다.

## 완료 조건

- `research-chunk-1`: 첫 조사 청크와 동적 산출물 manifest가 존재한다.
- `research-raw-primary`: 첫 핵심 출처의 실제 원본 텍스트가 존재한다.
- `research-screenshot-primary`: 첫 핵심 출처의 실제 화면 캡처가 존재한다.
- `research-attribution`: 모든 사실 주장이 URL과 원본 또는 캡처로 추적된다.
- `research-chunks-bounded`: manifest의 모든 조사 청크가 존재하며 500줄 이하이다.
- `code-baseline-disposition`: tokei 실행 결과 또는 선택 기능 `SKIP`에 맞는 대체 기준선이
  정직하게 기록된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
