# lsp-autofix.ps1 - PostToolUse(Write|Edit) hook
# Biome (JS/TS) + Stylelint (CSS) 자동수정. fail-open.
param()
$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "lsp-autofix.log"
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

$fp = $null
try {
  if ($j.tool_input.file_path) { $fp = $j.tool_input.file_path }
  elseif ($j.tool_input.path) { $fp = $j.tool_input.path }
} catch {}
if (-not $fp) { exit 0 }

$ext = [System.IO.Path]::GetExtension($fp).ToLower()
$jsExts = @('.js','.jsx','.ts','.tsx','.mjs','.cjs')
$cssExts = @('.css','.scss')
if (($jsExts -notcontains $ext) -and ($cssExts -notcontains $ext)) { exit 0 }
if ($fp -notmatch '[\\/]src[\\/]') { exit 0 }
if ($fp -match '[\\/](node_modules|\.git|step_archive|\.claude|plugins[\\/]harness107)[\\/]') { exit 0 }

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }

if ($jsExts -contains $ext) {
  try {
    Push-Location $projectRoot
    $null = (& cmd /c "npx biome check --apply ""$fp"" 2>&1")
    Pop-Location
    if ($LASTEXITCODE -eq 0) { Log "biome OK: $fp" } else { Log "biome diag: $fp"; [Console]::Error.WriteLine("[LSP-AUTOFIX] biome: $fp") }
  } catch { Log "biome failed: $_" }
}
if ($cssExts -contains $ext) {
  try {
    Push-Location $projectRoot
    $null = (& cmd /c "npx stylelint --fix ""$fp"" 2>&1")
    Pop-Location
    if ($LASTEXITCODE -eq 0) { Log "stylelint OK: $fp" } else { Log "stylelint diag: $fp"; [Console]::Error.WriteLine("[LSP-AUTOFIX] stylelint: $fp") }
  } catch { Log "stylelint failed: $_" }
}
exit 0
