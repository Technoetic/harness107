# mx-tag-validator.ps1 - PostToolUse(Write|Edit) hook
# @MX 태그 검증 (fail-open: 미준수 시 stderr 경고만)
param()
$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "mx-tag-validator.log"
function Log($m) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try { Add-Content -Path $logFile -Value "[$ts] $m" -Encoding UTF8 } catch {}
}

$j = $null
try {
  $r = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $raw = $r.ReadToEnd(); $r.Close()
  if ($raw) { $j = $raw | ConvertFrom-Json }
} catch { exit 0 }
if ($null -eq $j) { exit 0 }

$filePath = $null
try {
  if ($j.tool_input.file_path) { $filePath = $j.tool_input.file_path }
  elseif ($j.tool_input.path) { $filePath = $j.tool_input.path }
} catch {}
if (-not $filePath) { exit 0 }

$exts = @('.js','.jsx','.ts','.tsx','.mjs','.cjs','.html','.css','.py','.go','.rs')
$ext = [System.IO.Path]::GetExtension($filePath).ToLower()
if ($exts -notcontains $ext) { exit 0 }

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$progressFile = Join-Path $projectRoot "step_archive\progress.json"
if (-not (Test-Path $progressFile)) { exit 0 }
try { $progress = Get-Content $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { exit 0 }
$cur = [int]$progress.current_step
if ($cur -lt 15) { exit 0 }

if ($filePath -match '[\\/](step_archive|\.claude|node_modules|\.git|plugins[\\/]harness107)[\\/]') { exit 0 }
if (-not (Test-Path $filePath)) { exit 0 }

$content = ""
try { $content = Get-Content $filePath -Raw -Encoding UTF8 } catch { exit 0 }

$hasNote   = $content -match '@MX:NOTE'
$hasWarn   = $content -match '@MX:WARN'
$hasAnchor = $content -match '@MX:ANCHOR'
$hasTodo   = $content -match '@MX:TODO'

if ($hasNote -or $hasWarn -or $hasAnchor -or $hasTodo) {
  Log "OK [step=$cur] $filePath"
  if (($hasWarn -or $hasAnchor) -and -not ($content -match '@MX:REASON')) {
    [Console]::Error.WriteLine("[@MX-WARN] $filePath has WARN/ANCHOR but missing @MX:REASON sub-line")
  }
  exit 0
}

Log "[@MX-WARN] $filePath has no @MX tags"
[Console]::Error.WriteLine("[@MX-WARN] $filePath has no @MX tags (NOTE/WARN/ANCHOR/TODO)")
[Console]::Error.WriteLine("Add: // @MX:NOTE: <intent>  // @MX:WARN: <risk> (+ @MX:REASON)  // @MX:ANCHOR: <invariant> (+ @MX:REASON)  // @MX:TODO: <pending>")
exit 0
