---
name: step042
phase: review
---

# Step 42 - CSS 파일 분리 (컨텍스트 최적화)

## 목표

선택된 layout과 component 책임에 맞춰 CSS를 외부 파일로 분리한다. cascade order,
design token, breakpoint, focus와 motion 계약을 보존하고 현재 build로 검증한다.

## 입력과 산출물

- 입력: `step_archive/step030_레이아웃설계_chunk1.md`
- 입력: `step_archive/step030_전체설계_chunk1.md`
- 입력: `step_archive/step037_구현manifest.md`
- 입력: `step_archive/step041_js모듈화.md`
- 필수 선행 항목: `step030`, `step037`, `step041`
- 산출물: `step_archive/step042_css분리.md`
- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하지 않다.

## 실행 역할

가능한 경우 CSS 분리 구현자 역할과 CSS 독립 검증자 역할을 서로 다른 실행 주체에
맡긴다. 구현자는 선언된 stylesheet 경계만 바꾸며, 독립 검증자는 산출물과 application
source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두 역할을
명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다. 정상 권한
확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## CSS 책임 분리

`src/css/*.css`를 reset, token, layout, component, utility와 responsive 같은 책임별
파일로 나누고 각 selector의 단일 소유자를 정한다. `src/index.html`에는 external
stylesheet reference만 두며 style attribute와 <style> element를 금지한다.

기존 cascade를 재현하도록 stylesheet load 순서를 명시하고, shared token 정의와
breakpoint별 override의 source order 및 specificity를 기록한다. 같은 declaration을
복사해 우연히 맞추지 않고 반복 규칙은 적절한 shared selector나 custom property로
통합한다.

## 보존 검증

모든 HTML reference가 존재하는 external CSS를 정확히 가리키며 경로와 load 순서가
깨지지 않았는지 검사한다. viewport별 layout과 interaction에서 focus visibility,
reduced motion, contrast, responsive transition과 touch target을 변경 전 evidence에
대조한다. selector 누락, dead reference, unintended overflow 또는 inaccessible state가
있으면 완료하지 않는다.

## 빌드와 독립 검증

project manifest에 선언된 정확한 build 명령을 정상 권한 흐름으로 실행하고 exit code
0만 성공으로 인정한다. CSS 독립 검증자는 책임 map, cascade·token·breakpoint, HTML
reference, 접근성 보존, build 결과와 report를 처음부터 확인하며 application source를
고치지 않는다.

`step_archive/step042_css분리.md`에는 파일별 책임, selector 이동 map, before/after
digest, reference와 cascade 검사, viewport·접근성 결과, 정확한 build command·exit
code와 독립 finding을 기록한다. 필수 항목이 하나라도 실패하면 현재 단계를 차단한다.

## 완료 조건

- `css-separation-report`: 책임·reference·접근성·build·독립 검증 증거가 기록됐다.
- `project-build-command`: manifest의 정확한 non-optional build가 성공했다.
- `external-css-files`: 책임별 external CSS만 있고 inline style이 없다.
- `stylesheet-order-and-references`: load order·token·breakpoint·reference가 정확하다.
- `css-accessibility-preserved`: focus·motion·contrast·responsive behavior가 보존됐다.
- `independent-css-verifier`: 비수정 독립 검증자가 전체 증거를 확인했다.

보고서와 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
