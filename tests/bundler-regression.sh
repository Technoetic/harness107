#!/usr/bin/env bash
set -u
D="C:/Users/Admin/AppData/Local/Temp/claude/c--Users-Admin-Desktop-Encapsulate-Collection/67e7ebf1-1dc5-4d6c-b427-73ad64b24020/scratchpad/harness107"
SB="/tmp/h107edge_$$"
mkdir -p "$SB/src/js" "$SB/src/css"

# index.html — 본문에 리터럴 </body> 포함 (M-5), </script > 공백 close-tag (M-6)
cat > "$SB/src/index.html" <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="css/main.css"></head>
<body><pre>&lt;/body&gt; in text</pre><h1 id="t">x</h1><script src="js/app.js" ></script></body></html>
EOF

# config.js (알파벳상 app.js 뒤) — TDZ 유발 대상
cat > "$SB/src/js/config.js" <<'EOF'
export const CONFIG = { name: "bundled" };
EOF

# app.js (알파벳상 앞) — 멀티라인 import + 자체행 export default + 멀티라인 export{}
cat > "$SB/src/js/app.js" <<'EOF'
import {
  CONFIG,
} from "./config.js";
import "./side-effect.js";
function render() { document.getElementById("t").textContent = CONFIG.name; }
export {
  render,
};
export default
  render;
EOF

# CSS @import (M-6)
cat > "$SB/src/css/main.css" <<'EOF'
@import "./reset.css";
@import url(https://fonts.example/x.css);
body { margin: 0 }
EOF
cat > "$SB/src/css/reset.css" <<'EOF'
* { box-sizing: border-box }
EOF

echo "=== html-bundler.ps1 실행 ==="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$D/hooks/html-bundler.ps1" -ProjectRoot "$(cygpath -w "$SB" 2>/dev/null || echo "$SB")" 2>&1

OUT="$SB/dist/index.html"
echo "=== 산출물 검증 ==="
[ -s "$OUT" ] && echo "OK dist 존재 ($(wc -c < "$OUT") bytes)" || echo "XX dist 없음/빈파일"

# 인라인 <script> 추출 → node --check (SyntaxError 0 기대)
python3 - "$OUT" <<'PY'
import re,sys,subprocess,tempfile,os
h=open(sys.argv[1],encoding="utf-8").read()
m=re.search(r'<script>(.*?)</script>', h, re.S)
if not m: print("XX <script> 블록 없음"); sys.exit()
js=m.group(1)
open("/tmp/_b.js","w",encoding="utf-8").write(js)
r=subprocess.run(["node","--check","/tmp/_b.js"],capture_output=True,text=True)
print("OK node --check (SyntaxError 0)" if r.returncode==0 else "XX SyntaxError:\n"+r.stderr.strip())
# import/export 잔존 0 기대
print("  잔존 import:", len(re.findall(r'(?m)^\s*import\b', js)), "| 잔존 export{:", len(re.findall(r'(?m)^\s*export\s*\{', js)))
# 리터럴 </body> 중복 주입 검사: dist 전체에서 <script> 블록 수 == 1 기대
print("  <script> 블록 수:", len(re.findall(r'<script>', h)), "(1 기대)")
# CSS @import 로컬 제거 + http 보존
print("  로컬 @import 잔존:", len(re.findall(r'@import\s+["\']?\./', h)), "(0 기대) | http @import 보존:", len(re.findall(r'@import\s+url\(https', h)), "(1 기대)")
# 로컬 <script src> 제거(</script > 공백)
print("  잔존 script src=js:", len(re.findall(r'src="js/', h)), "(0 기대)")
PY
