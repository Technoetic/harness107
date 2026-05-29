# step-progress-writer.ps1 - Stop hook
# transcript에서 "Step NNN/107 완료" / "✅ Step NNN 완료" 패턴을 스캔하여 progress.json 갱신
# 멱등 동작 + Mutex 동시쓰기 방지 + 원자적 rename
param()
$ErrorActionPreference = "Continue"

$logFile = Join-Path $PSScriptRoot "step-progress-writer.log"
function Log($m) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try { Add-Content -Path $logFile -Value "[$ts] $m" -Encoding UTF8 } catch {}
}
Log "invoked"

$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$stepArchive = Join-Path $projectRoot "step_archive"
$archivedDir = Join-Path $stepArchive "archived"
$progressFile = Join-Path $stepArchive "progress.json"
if (-not (Test-Path $progressFile)) { exit 0 }

# stdin
$j = $null
try {
  $r = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $raw = $r.ReadToEnd(); $r.Close()
  if ($raw) { $j = $raw | ConvertFrom-Json }
} catch { Log "stdin parse: $_" }

# Mutex
$mutex = New-Object System.Threading.Mutex($false, "Global\harness107-progress-mutex")
$acquired = $false
try { $acquired = $mutex.WaitOne(5000) } catch {}
if (-not $acquired) { Log "mutex timeout"; exit 0 }

try {
  # 재시도 read
  $progress = $null
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $rawP = Get-Content $progressFile -Raw -Encoding UTF8
      if ($rawP -and $rawP.Trim().Length -gt 0) {
        $progress = $rawP | ConvertFrom-Json
        if ($null -ne $progress) { break }
      }
    } catch { Log "progress read attempt $($i+1): $_" }
    Start-Sleep -Milliseconds 50
  }
  if ($null -eq $progress) { Log "progress read failed → preserve"; return }

  # transcript + last_assistant_message 모두 수집
  $response = ""
  if ($j -and $j.last_assistant_message) { $response += "`n" + $j.last_assistant_message }
  if ($j -and $j.transcript_path -and (Test-Path $j.transcript_path)) {
    try {
      $lines = Get-Content $j.transcript_path -Encoding UTF8
      foreach ($ln in $lines) {
        if (-not $ln) { continue }
        try {
          $e = $ln | ConvertFrom-Json
          if ($e.type -eq 'assistant' -and $e.message.content) {
            foreach ($b in $e.message.content) {
              if ($b.type -eq 'text' -and $b.text) { $response += "`n" + $b.text }
            }
          }
        } catch {}
      }
    } catch {}
  }

  $totalSteps = [int]$progress.total_steps
  $found = New-Object System.Collections.Generic.HashSet[int]

  $patA = 'Step\s+(\d{1,3})\s*/\s*(\d{1,3})\s*완료'
  foreach ($m in [regex]::Matches($response, $patA, 'IgnoreCase')) {
    $n = [int]$m.Groups[1].Value
    $tot = [int]$m.Groups[2].Value
    if ($n -ge 1 -and $n -le $totalSteps -and $tot -eq $totalSteps) { [void]$found.Add($n) }
  }
  $patB = '(?m)(?:^|[\s✅→])Step\s+(\d{1,3})\s+완료'
  foreach ($m in [regex]::Matches($response, $patB, 'IgnoreCase')) {
    $n = [int]$m.Groups[1].Value
    if ($n -ge 1 -and $n -le $totalSteps) { [void]$found.Add($n) }
  }

  $valid = New-Object System.Collections.Generic.HashSet[int]
  foreach ($s in $found) {
    $sf = Join-Path $archivedDir ("step{0:D3}.md" -f $s)
    if (Test-Path $sf) { [void]$valid.Add($s) }
  }

  $existing = New-Object System.Collections.Generic.HashSet[int]
  foreach ($s in @($progress.completed_steps)) { [void]$existing.Add([int]$s) }
  $newOnes = @()
  foreach ($s in $valid) { if (-not $existing.Contains($s)) { $newOnes += $s } }

  if ($newOnes.Count -gt 0) {
    $all = @($existing) + $newOnes | Sort-Object -Unique
    $progress.completed_steps = @($all)
    $maxC = ($all | Measure-Object -Maximum).Maximum
    if ($maxC -lt $totalSteps) { $progress.current_step = $maxC + 1 } else { $progress.current_step = $totalSteps }
    Log "newly completed: $($newOnes -join ',') total $($all.Count)/$totalSteps"
  }

  $progress.last_updated = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')

  # 원자적 쓰기 + BOM 제거
  $jsonOut = $progress | ConvertTo-Json -Depth 32 -Compress
  if ([string]::IsNullOrWhiteSpace($jsonOut) -or $jsonOut -eq 'null') {
    Log "ConvertTo-Json null → skip"
  } else {
    $tmp = "$progressFile.tmp.$PID"
    $jsonOut | Out-File -FilePath $tmp -Encoding UTF8 -Force
    $bytes = [System.IO.File]::ReadAllBytes($tmp)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $bytes = $bytes[3..($bytes.Length-1)]
      [System.IO.File]::WriteAllBytes($tmp, $bytes)
    }
    Move-Item -Path $tmp -Destination $progressFile -Force
    Log "atomic write OK"
  }
} finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
exit 0
