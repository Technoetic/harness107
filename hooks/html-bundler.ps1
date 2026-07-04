# html-bundler.ps1 — src/ 구조를 단일 dist/index.html로 번들링 (file:// 호환)
#
# 역할 (step037/038/081 계약):
#   - src/index.html 을 베이스로
#   - src/**/*.css → <style> 인라인 (</head> 앞)
#   - src/**/*.js  → <script> 인라인 (</body> 앞, import/export 제거)
#   - 로컬 <link href="...css">, <script src="...js"> 참조 태그 제거
#   - 결과: dist/index.html (단일 파일)
#
# 사용: powershell -ExecutionPolicy Bypass -File <경로>/html-bundler.ps1 [-ProjectRoot <경로>]
# 산출물이 이 하네스의 유일한 "단일 HTML" 생성 메커니즘이다. 수동 인라인 대신 본 스크립트를 쓴다.

param(
  [string]$ProjectRoot = ""
)
$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
  $ProjectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }
}
$srcDir  = Join-Path $ProjectRoot "src"
$distDir = Join-Path $ProjectRoot "dist"
$indexSrc = Join-Path $srcDir "index.html"

if (-not (Test-Path $indexSrc)) {
  Write-Error "html-bundler: src/index.html 이 없습니다 ($indexSrc). Step 37 산출물을 먼저 생성하세요."
  exit 1
}

$html = Get-Content $indexSrc -Raw -Encoding UTF8

# 1) 로컬 참조 태그 제거 (외부 http(s) 링크는 보존)
$html = [regex]::Replace($html, '(?i)<link\b[^>]*\bhref\s*=\s*["''](?!https?:|//)[^"'']*\.css[^>]*>', '')
$html = [regex]::Replace($html, '(?i)<script\b[^>]*\bsrc\s*=\s*["''](?!https?:|//)[^"'']*\.js[^>]*>\s*</script\s*>', '')

# 2) CSS 수집 → <style> 인라인 (M-6: 로컬 @import 제거 — 어차피 전량 인라인이라 중복/깨짐 방지)
function Strip-CssImport([string]$css) {
  return [regex]::Replace($css, '(?im)^[ \t]*@import\s+(?!url\(\s*["'']?https?:|["'']?https?:)[^;]+;[ \t]*\r?\n?', '')
}
$cssParts = @()
if (Test-Path $srcDir) {
  Get-ChildItem -Path $srcDir -Recurse -Filter "*.css" | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($srcDir.Length).TrimStart('\','/')
    $cssParts += "/* $rel */`n" + (Strip-CssImport (Get-Content $_.FullName -Raw -Encoding UTF8))
  }
}
$styleBlock = ""
if ($cssParts.Count -gt 0) {
  $styleBlock = "<style>`n" + ($cssParts -join "`n`n") + "`n</style>`n"
}

# 3) JS 수집 → import/export 제거 후 <script> 인라인
# [보안/정확성 수정 H-3] 라인 단위 스트립은 biome가 자동 전개한 멀티라인 import/export를
# 만나면 SyntaxError를 남겨 <script> 전체를 깨뜨렸다. 멀티라인 정규식으로 문 전체를 제거한다.
function Strip-Module([string]$js) {
  # import 문 통째 제거 (다중행·side-effect import 포함): import ... ;
  $js = [regex]::Replace($js, '(?m)^[ \t]*import\b[^;]*?;[ \t]*\r?\n?', '')
  # re-export / 로컬 export { ... } (from 절 포함) 제거 — 다중행 대응
  $js = [regex]::Replace($js, '(?m)^[ \t]*export[ \t]*\{[^}]*\}[ \t]*(?:from[ \t]*["''][^"'']*["''])?[ \t]*;?[ \t]*\r?\n?', '')
  # export default 접두 제거 (뒤 표현식 보존; 값이 다음 줄에 오는 자체행 형태까지 개행 포함 소거)
  $js = [regex]::Replace($js, '(?m)^([ \t]*)export[ \t]+default\b[ \t\r\n]*', '$1')
  # export const/function/class/let/var → 노출 (접두만 제거)
  $js = [regex]::Replace($js, '(?m)^([ \t]*)export[ \t]+', '$1')
  return $js
}
$jsParts = @()
if (Test-Path $srcDir) {
  Get-ChildItem -Path $srcDir -Recurse -Include "*.js","*.mjs" | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($srcDir.Length).TrimStart('\','/')
    $jsParts += "// $rel`n" + (Strip-Module (Get-Content $_.FullName -Raw -Encoding UTF8))
  }
}
$scriptBlock = ""
if ($jsParts.Count -gt 0) {
  $scriptBlock = "<script>`n" + ($jsParts -join "`n`n") + "`n</script>`n"
}

# 4) 주입: </head> 앞에 style, </body> 앞에 script
# [수정 M-5] [regex]::Replace($s,$p,$r,1)의 4번째 인자는 count가 아니라 RegexOptions(1=IgnoreCase)라
# 전량 치환됐다 — 본문에 리터럴 </body>가 있으면 중복 주입. 인스턴스 Replace(input,repl,count)로 첫 1회만.
$rxHead = [regex]::new('</head>', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$rxBody = [regex]::new('</body>', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if ($styleBlock) {
  if ($rxHead.IsMatch($html)) { $html = $rxHead.Replace($html, ($styleBlock + '</head>'), 1) }
  else { $html = $styleBlock + $html }
}
if ($scriptBlock) {
  if ($rxBody.IsMatch($html)) { $html = $rxBody.Replace($html, ($scriptBlock + '</body>'), 1) }
  else { $html = $html + $scriptBlock }
}

# 5) dist/index.html 저장 (UTF-8 no BOM, LF)
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir -Force | Out-Null }
$distIndex = Join-Path $distDir "index.html"
$html = $html -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($distIndex, $html, (New-Object System.Text.UTF8Encoding($false)))

$size = (Get-Item $distIndex).Length
Write-Output "html-bundler: dist/index.html 생성 완료 ($size bytes, css=$($cssParts.Count) js=$($jsParts.Count))"
if ($size -lt 1) { Write-Error "html-bundler: 결과물이 비어 있습니다"; exit 1 }
exit 0
