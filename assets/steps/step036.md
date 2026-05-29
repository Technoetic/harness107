---
name: step036
persistence: session
---

# Step 36 - 인코딩 규칙 (모지바케 방지)

<!-- MOAI-ENRICHED v1 -->
> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-036.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step036_*.md` 저장 후 1줄 완료 보고 `Step 036/107 완료`.
>
> **모델 정책**: 조사·구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: r1 게이트(step049) 전 구간

코드 작성 시 반드시 아래 인코딩 규칙을 준수하여 한글 문자 깨짐(모지바케)을 방지한다.

## 필수 규칙

1. **모든 텍스트 파일은 UTF-8 (BOM 없음)으로 저장**
   - BOM(Byte Order Mark) 포함 시 일부 도구에서 파싱 오류 발생
   - PowerShell Set-Content 사용 시 `-Encoding UTF8` 명시

2. **줄바꿈은 LF(`\n`)만 사용 (CRLF 금지)**
   - Windows 기본값 CRLF(`\r\n`)는 diff 노이즈와 쉘 오류 유발
   - `.editorconfig`, `.gitattributes`에 `* text=auto eol=lf` 설정

3. **PowerShell 출력 시 인코딩 명시**
   ```powershell
   [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
   $OutputEncoding = [System.Text.Encoding]::UTF8
```text

4. **파일 Python write_text() 사용 시 한글 포함 내용은 UTF-8로 직접 작성**
   - Bash의 `echo` 리다이렉션 금지 (인코딩 불일치 위험)
   - 반드시 Python pathlib.Path.write_text() 사용

5. **검증**
   - `.claude/hooks/research-validator.ps1`에서 BOM/CRLF 자동 검사

## Self-Calibration

완료 후 다음을 스스로 평가하라:
- 인코딩 규칙이 이후 모든 파일 작성에 적용 가능한 상태인가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다.

---

이 지침을 완료한 즉시 자동으로 step037.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


