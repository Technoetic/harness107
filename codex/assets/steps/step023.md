---
name: step023
phase: research
---

# Step 23 - Awwwards 디자인 패턴 분석

## 목표

16단계의 프로젝트 특성과 22단계의 로컬 원본·스크린샷만 사용해 디자인 패턴과
비교 가능한 대안을 도출한다. 이 단계에서는 새 웹 자료를 수집하지 않는다.

## 입력과 산출물

- 입력: `step_archive/step016_조사결과_chunk1.md`
- 입력: `step_archive/step022_수집결과_chunk1.md`
- 입력: `step_archive/awwwards-step022-primary.txt`
- 입력: `step_archive/screenshots/research/step022-primary-desktop.png`
- 필수 선행 항목: `step016`, `step022`
- 산출물: `step_archive/step023_조사결과_chunk1.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필수

## 실행 역할

가능한 경우 수집 증거를 축별로 분석하는 역할과 결론을 원본에 대조하는 독립 검토
역할을 나눈다. 분석 역할은 manifest에 있는 모든 로컬 capture를 검사하고, 독립 검토
역할은 누락·과장·상충 여부를 확인한다. 역할을 나눠도 정상 권한 확인은 유지한다.
위임 기능을 사용할 수 없으면 현재 실행자가 수집 증거 분석과 독립 검토를
순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.

## 증거 확인

수집 manifest의 모든 원본 텍스트와 스크린샷이 존재하는지 확인한다.
시각 검사 기능으로 각 이미지를 실제로 열어 page, viewport, interaction 상태가 manifest와
일치하는지 검사한다. 시각 검사 기능을 사용할 수 없으면 추정으로 대체하지 않고 이
단계를 완료하지 않는다. 필수 capture가 손상된 경우도 같다.

모든 분석 문장에는 근거 URL과 원본 파일 또는 스크린샷 경로를 붙인다. 가능한 경우
화면 영역과 관찰한 요소도 적는다. 사실 주장과 수치가 원본 또는 캡처에 없으면
증거를 발명하지 않는다.

## 분석 축

16단계 결과에서 프로젝트 기능, UI 구성 요소, 대상 사용자에 영향을 주는 동적 조사
축을 만든다. 각 축에서 레이아웃, 색상, 간격, 타이포그래피, 인터랙션을 모두
검토하고 관련 사례를 비교한다. 각 대안은 최소 2개를 근거에서 도출해 장단점과 구현
제약을 균형 있게 적는다. 두 개의 근거 있는 대안을 만들 수 없으면 부족한 capture를
명시하고 완료하지 않는다.

원본에 이름이 명시된 여섯 미학 축은 모두 다음과 같이 다룬다.

- Brutalism
- Glassmorphism
- Minimalism (Swiss)
- Dark OLED Luxury
- Neumorphism
- Cyberpunk

각 축은 실제 capture에 나타남, 반면교사, 관찰되지 않음 중 하나로 분류하고 근거를
붙인다. 관찰되지 않은 축을 억지로 사례에 배정하지 않는다. 추가 축은 capture에서
직접 도출될 때만 이름을 붙이며, 이름이 제공되지 않은 축의 개수를 임의로 채우지
않는다.

## 품질 검토

다음 항목을 근거와 함께 포함한다.

- 맹목적인 Inter/Roboto/Arial, 보라 gradient, 중앙 card, 과도한 radius, 획일적
  단색 배경의 실제 관찰 여부와 반면교사 표시
- 관찰 가능한 border 두께, shadow blur, grid, spacing, type, color 값
- 관찰값을 4pt/8pt grid와 60-30-10 규칙에 적용할 때의 변환과 손실
- 기존 design system이나 component library로 조립할 수 있는지와 제약
- 특정 대안을 아직 선택하지 않은 비교 표

## 청크 계약

첫 결과는 `step_archive/step023_조사결과_chunk1.md`에 저장한다. 추가 청크는 각각
500줄 이하로 만들고 첫 청크 manifest에 경로, 줄 수, 분석 축과 근거 파일을 기록한다.

## 완료 조건

- `design-pattern-chunk-1`: 첫 디자인 분석 청크가 존재한다.
- `research-screenshot-input`: 필수 primary 스크린샷이 존재하고 실제로 검사되었다.
- `all-captures-traced`: 모든 결론이 manifest의 URL, 원본 또는 스크린샷으로 추적된다.
- `named-aesthetic-axes`: 이름이 명시된 여섯 축을 근거에 따라 모두 처리했다.
- `visual-pattern-inspection`: 모든 필수 이미지를 시각 검사하고 결과를 기록했다.
- `design-analysis-chunks-bounded`: manifest의 모든 청크가 존재하며 500줄 이하이다.

검증 결과를 수락 증거로 제출하고 이 단계에서 멈춘다.
