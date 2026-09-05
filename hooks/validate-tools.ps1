# validate-tools.ps1 - on-demand wrapper for step003~014 환경 검증
# 사용: powershell -File hooks/validate-tools.ps1 -Tool <playwright|axe|biome|stylelint|c8|jscpd>
param([Parameter(Mandatory=$true)][string]$Tool)
$ErrorActionPreference = "Continue"

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$stepArchive = Join-Path $projectRoot "step_archive"
$outDir = Join-Path $stepArchive "research-scripts"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

switch ($Tool.ToLower()) {
  'playwright' {
    Push-Location $projectRoot
    $out = (& cmd /c "npx playwright --version 2>&1") -join "`n"
    Pop-Location
    Write-Host "playwright: $out"
    if ($LASTEXITCODE -eq 0) { exit 0 } else { exit 1 }
  }
  'axe' {
    Push-Location $projectRoot
    $out = (& cmd /c "node -e ""console.log(require('@axe-core/playwright')?'OK':'FAIL')"" 2>&1") -join "`n"
    Pop-Location
    Write-Host "axe-core: $out"
    if ($out -match 'OK') { exit 0 } else { exit 1 }
  }
  'biome' {
    Push-Location $projectRoot
    $out = (& cmd /c "npx biome --version 2>&1") -join "`n"
    Pop-Location
    Write-Host "biome: $out"
    if ($LASTEXITCODE -eq 0) { exit 0 } else { exit 1 }
  }
  'stylelint' {
    Push-Location $projectRoot
    $out = (& cmd /c "npx stylelint --version 2>&1") -join "`n"
    Pop-Location
    Write-Host "stylelint: $out"
    if ($LASTEXITCODE -eq 0) { exit 0 } else { exit 1 }
  }
  'c8' {
    Push-Location $projectRoot
    $out = (& cmd /c "npx c8 --version 2>&1") -join "`n"
    Pop-Location
    Write-Host "c8: $out"
    if ($LASTEXITCODE -eq 0) { exit 0 } else { exit 1 }
  }
  'jscpd' {
    Push-Location $projectRoot
    $out = (& cmd /c "npx jscpd --version 2>&1") -join "`n"
    Pop-Location
    Write-Host "jscpd: $out"
    if ($LASTEXITCODE -eq 0) { exit 0 } else { exit 1 }
  }
  default {
    Write-Host "Unknown tool: $Tool (use playwright|axe|biome|stylelint|c8|jscpd)"
    exit 1
  }
}
