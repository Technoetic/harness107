---
name: step044
phase: review
---

> 2.2 품질 게이트: 변경 뒤 플러그인 `scripts/quality-gate.mjs`를 `--workspace
> "<project-root>"`로 실행하고 종료 코드 0 및 현재 소스에 대한 PASS를 확인한다.
> 설정은 `docs/QUALITY.md`를 따른다. 누락·실패·오래된 증거로 마일스톤을 완료하지 않는다.

# Step 44 - HTML 컴포넌트화

## 목표

현재 HTML을 선택된 architecture에 맞는 재사용 가능한 semantic component로 정리한다.
external asset, accessibility, reference와 current build 계약을 독립적으로 확인한 뒤
두 번째 quality milestone을 기록한다.

## 입력과 산출물

- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step038_smoke_test.md`
- 입력: `step_archive/outputs/trust5_r1.md`
- 입력: `dist/index.html`
- 입력: `step_archive/step041_js모듈화.md`
- 입력: `step_archive/step042_css분리.md`
- 입력: `step_archive/screenshots/compare-awwwards-applied-r1.png`
- 입력: `step_archive/outputs/step043_검증_r1.md`
- 필수 선행 항목: `step030`, `step038`, `step041`, `step042`, `step043`
- 산출물: `step_archive/step044_html컴포넌트화.md`
- 산출물: `step_archive/outputs/trust5_r2.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 HTML 컴포넌트 구현자 역할과 HTML milestone 독립 검증자 역할을 서로 다른
실행 주체에 맡긴다. 구현자는 선언된 semantic boundary만 바꾸며, 독립 검증자는
산출물과 application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재
실행자가 두 역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지
않는다. 정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 재사용 가능한 semantic component

30단계 설계와 41·42단계 책임 map을 기준으로 반복 HTML을 재사용 가능한 semantic
component로 나눈다. 각 component의 책임, input, owned DOM과 lifecycle을 기록하고
중복 markup을 단일 template 또는 render boundary로 통합한다. heading hierarchy,
document order와 progressive enhancement를 보존한다.

JavaScript는 external JavaScript reference로, CSS는 external CSS reference로만
유지한다. inline script, style element, style attribute를 만들지 않는다. component
추출이 기존 event target, selector 또는 URL을 바꿀 때에는 caller와 test를 같은
ownership unit에서 함께 갱신한다.

## 구조와 접근성 검증

source와 rendered DOM을 대조해 semantic landmark, accessible label, keyboard order,
visible focus, form state와 live region을 확인한다. 모든 asset reference와 stylesheet,
module, link, image path가 존재하고 expected target을 가리키는지 검사한다. 중복 ID,
깨진 reference, empty accessible name 또는 landmark hierarchy 오류는 차단한다.

## 현재 build 검증

project manifest에 선언된 정확한 build 명령을 정상 권한 흐름으로 실행하고 exit code
0만 성공으로 인정한다. build가 만든 `dist/index.html`이 symbolic link가 아닌 일반
파일이며 0바이트보다 크고, UTF-8 content에 대소문자와 attribute를 허용하는 `<html`
opening과 `</html>` closing boundary가 있는지 확인한다. 이전 artifact가 아닌지
before/after metadata와 digest도 기록한다.

## 독립 milestone 검증

HTML milestone 독립 검증자는 component responsibility, external reference, rendered
structure, accessibility, current build와 `dist/index.html` evidence를 처음부터 다시
확인하고 application source나 보고서를 수정하지 않는다. build, structure,
accessibility 검사가 모두 `PASS`인 뒤에만
`step_archive/outputs/trust5_r2.md`를 만든다. finding 또는 검사 실패가 있으면 milestone을
만들지 않고 현재 단계를 차단한다.

`step_archive/step044_html컴포넌트화.md`에는 component map, source와 rendered 구조,
reference 검사, accessibility 결과, 정확한 build command·exit code, dist metadata와
digest, 독립 판정을 기록한다.

## 완료 조건

- `html-componentization-report`: component·reference·접근성·build 증거가 기록됐다.
- `review-milestone`: 모든 필수 gate 뒤 두 번째 quality milestone이 기록됐다.
- `project-build-command`: manifest의 정확한 non-optional build가 성공했다.
- `reusable-semantic-components`: 반복 HTML이 책임 있는 semantic component로 분리됐다.
- `external-assets-only`: JavaScript와 CSS가 external reference이고 inline 구현이 없다.
- `accessibility-reference-integrity`: 구조·label·keyboard·focus·asset reference가 유효하다.
- `dist-html-boundary`: current build의 dist HTML이 regular·nonempty·boundary 조건을 충족한다.
- `independent-milestone-verifier`: 비수정 독립 검증자가 모든 gate를 확인했다.
- `pass-only-quality-milestone`: 모든 필수 검사가 `PASS`인 뒤에만 milestone을 만들었다.

보고서와 milestone 및 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다.
workflow 상태와 영수증만이 이후 진행을 소유한다.
