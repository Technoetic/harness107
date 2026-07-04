#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# html-bundler.sh — src/ 구조를 단일 dist/index.html로 번들링 (file:// 호환)
#
# 역할 (step037/038/081 계약):
#   src/index.html 베이스 + src/**/*.css → <style> 인라인 + src/**/*.js → <script> 인라인(import/export 제거)
#   로컬 <link href>, <script src> 참조 제거. 결과: dist/index.html 단일 파일.
#
# 사용: bash <경로>/html-bundler.sh [PROJECT_ROOT]
set -eu

PROJECT_ROOT="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
SRC_DIR="$PROJECT_ROOT/src"
DIST_DIR="$PROJECT_ROOT/dist"
INDEX_SRC="$SRC_DIR/index.html"

if [ ! -f "$INDEX_SRC" ]; then
  echo "html-bundler: src/index.html 이 없습니다 ($INDEX_SRC). Step 37 산출물을 먼저 생성하세요." 1>&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "html-bundler: python3 필요" 1>&2; exit 1; }

mkdir -p "$DIST_DIR"
export SRC_DIR DIST_DIR INDEX_SRC
python3 - <<'PY'
import os, re, glob

src = os.environ["SRC_DIR"]
dist = os.environ["DIST_DIR"]
index_src = os.environ["INDEX_SRC"]

with open(index_src, encoding="utf-8") as f:
    html = f.read()

# 1) 로컬 참조 태그 제거 (외부 http(s)는 보존)
html = re.sub(r'(?i)<link\b[^>]*\bhref\s*=\s*["\'](?!https?:|//)[^"\']*\.css[^>]*>', '', html)
html = re.sub(r'(?i)<script\b[^>]*\bsrc\s*=\s*["\'](?!https?:|//)[^"\']*\.js[^>]*>\s*</script>', '', html)

# 2) CSS 수집 → <style>
css_files = sorted(glob.glob(os.path.join(src, "**", "*.css"), recursive=True))
css_parts = []
for p in css_files:
    rel = os.path.relpath(p, src)
    with open(p, encoding="utf-8") as f:
        css_parts.append("/* %s */\n%s" % (rel, f.read()))
style_block = ("<style>\n" + "\n\n".join(css_parts) + "\n</style>\n") if css_parts else ""

# 3) JS 수집 → import/export 제거 → <script>
def strip_module(js):
    out = []
    for ln in js.splitlines():
        if re.match(r'^\s*import\s', ln):
            continue
        if re.match(r'^\s*export\s+default\s', ln):
            ln = re.sub(r'^\s*export\s+default\s', '', ln)
        elif re.match(r'^\s*export\s+\{', ln):
            continue
        elif re.match(r'^\s*export\s', ln):
            ln = re.sub(r'^(\s*)export\s+', r'\1', ln)
        out.append(ln)
    return "\n".join(out)

js_files = sorted(glob.glob(os.path.join(src, "**", "*.js"), recursive=True) +
                  glob.glob(os.path.join(src, "**", "*.mjs"), recursive=True))
js_parts = []
for p in js_files:
    rel = os.path.relpath(p, src)
    with open(p, encoding="utf-8") as f:
        js_parts.append("// %s\n%s" % (rel, strip_module(f.read())))
script_block = ("<script>\n" + "\n\n".join(js_parts) + "\n</script>\n") if js_parts else ""

# 4) 주입
if style_block:
    if re.search(r'(?i)</head>', html):
        html = re.sub(r'(?i)</head>', style_block + '</head>', html, count=1)
    else:
        html = style_block + html
if script_block:
    if re.search(r'(?i)</body>', html):
        html = re.sub(r'(?i)</body>', script_block + '</body>', html, count=1)
    else:
        html = html + script_block

# 5) 저장 (UTF-8, LF)
html = html.replace("\r\n", "\n")
out_path = os.path.join(dist, "index.html")
with open(out_path, "w", encoding="utf-8", newline="\n") as f:
    f.write(html)
size = os.path.getsize(out_path)
print("html-bundler: dist/index.html 생성 완료 (%d bytes, css=%d js=%d)" % (size, len(css_parts), len(js_parts)))
raise SystemExit(0 if size > 0 else 1)
PY
exit $?
