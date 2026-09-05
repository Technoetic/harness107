# Shared measured quality inspection. Never installs or executes project tools.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { exit 0 }
$runner = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/quality-gate.mjs'
$raw = [Console]::In.ReadToEnd()
$raw | & node $runner --hook
exit $LASTEXITCODE
