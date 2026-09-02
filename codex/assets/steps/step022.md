---
name: step022
phase: research
---

# Step 22 - Awwwards 데이터 수집

## 목표

20단계에서 근거와 함께 선정한 URL을 실제 방문하여, 제한된 페이지·viewport의 원본
텍스트와 화면 캡처를 수집하고 사람이 다시 검사할 수 있는 manifest를 만든다.

## 입력과 산출물

- 입력: `step_archive/step020_선정URL.md`
- 입력: `step_archive/research-raw-step020-awwwards.txt`
- 필수 선행 항목: `step020`
- 산출물: `step_archive/step022_수집결과_chunk1.md`
- 산출물: `step_archive/awwwards-step022-primary.txt`
- 산출물: `step_archive/screenshots/research/step022-primary-desktop.png`
- 네트워크: 필수
- 시각 검토: 필수

## 실행 역할

가능한 경우 선정 사이트별 수집 역할과 원본·스크린샷을 실제로 확인하는 독립 검토
역할을 나눈다. 수집 역할은 지정된 범위만 방문하고, 독립 검토 역할은 manifest와
파일이 동일한 URL과 viewport를 나타내는지 확인한다. 역할을 나눠도 정상 권한 확인은
유지한다. 위임 기능을 사용할 수 없으면 현재 실행자가 수집과 독립 검토를
순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.

## URL 경계

`step_archive/step020_선정URL.md`에 기록되고
`step_archive/research-raw-step020-awwwards.txt`를 비롯한 원본으로 등재 출처가
검증된 URL만 입력으로 사용한다. 선정 목록 밖의 URL은 수집하지 않는다. redirect가
발생하면 최종 URL을 기록하고, 다른 origin으로 벗어나면 자동 탐색을 중단한다.
robots 지침, 접근 제한, 로그인 경계를 우회하지 않는다.

## bounded 수집

선정된 최대 3개 사이트를 처리한다. URL별 최대 10개 페이지를 같은 origin의
navigation에서 관련성 순으로 선택한다. 단일 페이지 앱은 최대 20개 viewport 높이
구간과 최대 5개 공개 interaction 상태까지만 수집한다. 범위를 넘는 항목은 URL과
제외 이유를 manifest에 남긴다.

반응형 근거가 있는 사이트는 desktop 1920×1080, tablet 768×1024, mobile 390×844를
사용한다. 비반응형 근거가 있는 사이트는 desktop만 사용하되 근거를 기록한다. 동적
파일은 `step_archive/screenshots/research/awwwards-<site>-<page>-<viewport>.png`와
`step_archive/awwwards-<site>-<content>.txt` 형식으로 저장한다.

첫 사이트의 첫 desktop 페이지 원본 텍스트와 스크린샷은 각각
`step_archive/awwwards-step022-primary.txt`와
`step_archive/screenshots/research/step022-primary-desktop.png`에도 보존한다. 원본
텍스트와 스크린샷 둘 다 없으면 해당 페이지 수집은 무효다.

## 증거와 실패 처리

각 capture에 요청 URL, 최종 URL, 출처 선정 항목, 수집 시각, HTTP 결과, viewport,
원본 경로와 스크린샷 경로를 기록한다. 모든 사실 주장은 URL과 출처, 원본 또는
캡처로 추적되어야 한다. 방문하지 않은 페이지나 보이지 않은 상태의 증거를 발명하지
않는다.

네트워크 기능 또는 필수 브라우저·시각 검사 기능을 사용할 수 없으면 정상 권한 확인
아래 최대 세 번만 재시도한다. 그 뒤에도 필수 원본과 캡처를 만들지 못하거나 시각
검사 기능으로 실제 이미지를 열어 확인하지 못하면 이 단계를 완료하지 않는다.

## 결과 청크

`step_archive/step022_수집결과_chunk1.md`에 수집 범위, capture manifest, 실패 및
제외 항목을 기록한다. 추가 청크는 각각 500줄 이하로 만들고 첫 청크 manifest에
경로와 줄 수를 적는다.

## 완료 조건

- `awwwards-collection-chunk-1`: 첫 수집 청크와 capture manifest가 존재한다.
- `awwwards-raw-primary`: 첫 페이지의 실제 원본 텍스트가 존재한다.
- `awwwards-screenshot-primary`: 첫 페이지의 실제 desktop 캡처가 존재한다.
- `selected-url-input`: 모든 방문이 20단계 선정 목록에서 시작한다.
- `capture-attribution`: 각 파일이 URL, 수집 시각과 viewport로 추적된다.
- `visual-capture-inspection`: 필수 이미지를 실제로 열어 내용과 manifest를 확인했다.
- `bounded-capture-scope`: 사이트·페이지·구간·상태 상한과 제외 항목이 기록된다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
