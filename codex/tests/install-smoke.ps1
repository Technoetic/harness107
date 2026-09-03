[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PluginRoot,
  [ValidateSet("Preflight", "AfterTrust")][string]$Mode = "Preflight",
  [string]$NativeWorkspace,
  [string]$ImportWorkspace,
  [string]$ExpectedClaudeProgressSha256,
  [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:IsWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$script:IsMacOSPlatform = [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [Runtime.InteropServices.OSPlatform]::OSX
)
$script:Comparison = if ($script:IsWindowsPlatform) {
  [StringComparison]::OrdinalIgnoreCase
} else {
  [StringComparison]::Ordinal
}
$script:Utf8Strict = New-Object Text.UTF8Encoding($false, $true)
$script:SafeReportDestination = $null
$script:Report = [ordered]@{
  schema_version = 1
  mode = $Mode
  timestamp = (Get-Date).ToUniversalTime().ToString("o")
  codex_version = $null
  resolved_installed_root = $null
  manifest = [ordered]@{
    name = $null
    version = $null
    skills = $null
    hooks = $null
    claude_version_synchronized = $false
    marketplace_version_synchronized = $false
  }
  skill_count = 0
  step_count = 0
  hook_source = $null
  hook_source_sha256 = $null
  hook_bundle_sha256 = $null
  hook_handler_checks = [ordered]@{
    PreToolUse = $false
    SessionStart = $false
    UserPromptSubmit = $false
    Stop = $false
    synchronous = $false
    no_permission_or_approval_hook = $false
    source_files_regular = $false
  }
  hook_handler_sha256 = [ordered]@{}
  observed_events = [ordered]@{
    session_context_loaded = $false
    continuation_issued = $false
    continuation_consumed = $false
    continuation_replay_rejected = $false
    workflow_paused = $false
    workflow_resumed = $false
    guard_denied = $false
    guard_deferred = $false
    claude_imported = $false
  }
  native_receipt_count = $null
  native_codex_verified_receipt_count = $null
  import_receipt_count = $null
  imported_receipt_count = $null
  claude_progress_sha256_before_expected = $null
  claude_progress_sha256_after = $null
  passed = $false
}

function Stop-Smoke {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $exception = New-Object InvalidOperationException($Message)
  $exception.Data["SmokeCode"] = $Code
  throw $exception
}

function Test-IsReparsePoint {
  param([Parameter(Mandatory = $true)]$Item)

  return (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-PathEqual {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  return [string]::Equals(
    [IO.Path]::GetFullPath($Left).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
    [IO.Path]::GetFullPath($Right).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
    $script:Comparison
  )
}

function Test-PathInside {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [switch]$AllowEqual
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  if ([string]::Equals($rootFull, $candidateFull, $script:Comparison)) {
    return [bool]$AllowEqual
  }
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  return $candidateFull.StartsWith($prefix, $script:Comparison)
}

function Test-FullyQualifiedFilesystemPath {
  param($Path)

  if ($Path -isnot [string] -or [string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }
  if ($script:IsWindowsPlatform) {
    return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
  }
  return $Path.StartsWith("/", [StringComparison]::Ordinal)
}

function Assert-NoReparseChain {
  param([Parameter(Mandatory = $true)][string]$Path)

  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) {
    Stop-Smoke "PATH_UNSAFE" "A filesystem path is not fully qualified."
  }
  $current = $root
  $relative = $full.Substring($root.Length)
  $segments = @($relative -split '[\\/]' | Where-Object { $_.Length -gt 0 })
  foreach ($segment in $segments) {
    $current = Join-Path $current $segment
    $item = Get-Item -Force -LiteralPath $current -ErrorAction Stop
    if (Test-IsReparsePoint $item) {
      Stop-Smoke "PATH_UNSAFE" "A checked path contains a filesystem alias."
    }
  }
}

function Resolve-PhysicalDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  try {
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
    $full = [IO.Path]::GetFullPath($resolved)
    $item = Get-Item -Force -LiteralPath $full -ErrorAction Stop
  } catch {
    Stop-Smoke "PATH_INVALID" "$Label is not an accessible directory."
  }
  if (-not $item.PSIsContainer -or (Test-IsReparsePoint $item)) {
    Stop-Smoke "PATH_UNSAFE" "$Label must be a physical directory."
  }
  Assert-NoReparseChain $full
  return $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-SafeDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $candidate = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
  if (-not (Test-PathInside -Root $Root -Candidate $candidate)) {
    Stop-Smoke "PATH_UNSAFE" "$Label escaped its trusted root."
  }
  try {
    $item = Get-Item -Force -LiteralPath $candidate -ErrorAction Stop
  } catch {
    Stop-Smoke "FILE_MISSING" "$Label is missing."
  }
  if (-not $item.PSIsContainer -or (Test-IsReparsePoint $item)) {
    Stop-Smoke "PATH_UNSAFE" "$Label must be a physical directory."
  }
  Assert-NoReparseChain $candidate
  return $candidate
}

function Resolve-SafeFile {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $candidate = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
  if (-not (Test-PathInside -Root $Root -Candidate $candidate)) {
    Stop-Smoke "PATH_UNSAFE" "$Label escaped its trusted root."
  }
  try {
    $item = Get-Item -Force -LiteralPath $candidate -ErrorAction Stop
  } catch {
    Stop-Smoke "FILE_MISSING" "$Label is missing."
  }
  if ($item.PSIsContainer -or (Test-IsReparsePoint $item)) {
    Stop-Smoke "PATH_UNSAFE" "$Label must be a physical regular file."
  }
  Assert-NoReparseChain $candidate
  return $candidate
}

function Read-StrictText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [int64]$MaximumBytes = 4194304
  )

  try {
    $bytes = [IO.File]::ReadAllBytes($Path)
  } catch {
    Stop-Smoke "FILE_READ_FAILED" "$Label could not be read."
  }
  if ($bytes.LongLength -eq 0 -or $bytes.LongLength -gt $MaximumBytes) {
    Stop-Smoke "FILE_SIZE_INVALID" "$Label has an invalid size."
  }
  if (
    $bytes.Length -ge 3 -and
    $bytes[0] -eq 0xEF -and
    $bytes[1] -eq 0xBB -and
    $bytes[2] -eq 0xBF
  ) {
    Stop-Smoke "TEXT_ENCODING_INVALID" "$Label must be UTF-8 without a byte-order mark."
  }
  try {
    return $script:Utf8Strict.GetString($bytes)
  } catch {
    Stop-Smoke "TEXT_ENCODING_INVALID" "$Label is not valid UTF-8."
  }
}

function Read-StrictJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [int64]$MaximumBytes = 4194304
  )

  $text = Read-StrictText -Path $Path -Label $Label -MaximumBytes $MaximumBytes
  try {
    $value = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Stop-Smoke "JSON_INVALID" "$Label is not valid JSON."
  }
  if ($null -eq $value -or $value -is [Array] -or $value -is [string] -or $value -is [ValueType]) {
    Stop-Smoke "JSON_INVALID" "$Label must contain one JSON object."
  }
  return $value
}

function Get-PropertyNames {
  param([Parameter(Mandatory = $true)]$Object)

  if ($null -eq $Object -or $Object -is [Array] -or $Object -is [string] -or $Object -is [ValueType]) {
    Stop-Smoke "SCHEMA_INVALID" "A JSON object has the wrong type."
  }
  return @($Object.PSObject.Properties | ForEach-Object { $_.Name })
}

function Assert-ExactProperties {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string[]]$Required,
    [string[]]$Optional = @(),
    [Parameter(Mandatory = $true)][string]$Label
  )

  $names = @(Get-PropertyNames $Object)
  $allowed = @($Required) + @($Optional)
  foreach ($name in $names) {
    if (@($allowed | Where-Object { $_ -ceq $name }).Count -ne 1) {
      Stop-Smoke "SCHEMA_INVALID" "$Label contains an unexpected field."
    }
  }
  foreach ($name in $Required) {
    if (@($names | Where-Object { $_ -ceq $name }).Count -ne 1) {
      Stop-Smoke "SCHEMA_INVALID" "$Label is missing a required field."
    }
  }
}

function Assert-ExactNames {
  param(
    [Parameter(Mandatory = $true)][object[]]$Items,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ($Items.Count -ne $Expected.Count) {
    Stop-Smoke "PACKAGE_CONTENT_INVALID" "$Label has an unexpected entry count."
  }
  foreach ($expectedName in $Expected) {
    if (@($Items | Where-Object { $_.Name -ceq $expectedName }).Count -ne 1) {
      Stop-Smoke "PACKAGE_CONTENT_INVALID" "$Label has an unexpected entry."
    }
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash.ToLowerInvariant()
  } catch {
    Stop-Smoke "HASH_FAILED" "A required file could not be hashed."
  }
}

function Assert-SingleLinkFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  if ($script:IsWindowsPlatform) {
    $fsutil = Get-Application @("fsutil.exe", "fsutil") "Windows filesystem utility"
    $links = Invoke-CheckedApplication `
      -Executable $fsutil `
      -Arguments @("hardlink", "list", $Path) `
      -WorkingDirectory $WorkingDirectory `
      -FailureCode "NATIVE_RECEIPTS_INVALID" `
      -FailureMessage "Native artifact hard-link identity could not be verified."
    if (@($links -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -ne 1) {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native artifact evidence points to an aliased file."
    }
  } else {
    $stat = Get-Application @("stat") "filesystem stat utility"
    $statArguments = if ($script:IsMacOSPlatform) {
      @("-f", "%l", $Path)
    } else {
      @("-c", "%h", $Path)
    }
    $links = Invoke-CheckedApplication `
      -Executable $stat `
      -Arguments $statArguments `
      -WorkingDirectory $WorkingDirectory `
      -FailureCode "NATIVE_RECEIPTS_INVALID" `
      -FailureMessage "Native artifact hard-link identity could not be verified."
    if ($links -cne "1") {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native artifact evidence points to an aliased file."
    }
  }
}

function Get-SafeArtifactSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  $path = Resolve-SafeFile $WorkspaceRoot $RelativePath "Native receipt artifact"
  Assert-SingleLinkFile $path $WorkspaceRoot
  $before = Get-Item -Force -LiteralPath $path -ErrorAction Stop
  $stream = $null
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = New-Object IO.FileStream(
      $path,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::Read
    )
    $digest = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } catch {
    Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native receipt artifact could not be hashed safely."
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $sha.Dispose()
  }
  $afterPath = Resolve-SafeFile $WorkspaceRoot $RelativePath "Native receipt artifact"
  $after = Get-Item -Force -LiteralPath $afterPath -ErrorAction Stop
  Assert-SingleLinkFile $afterPath $WorkspaceRoot
  if (
    -not (Test-PathEqual $path $afterPath) -or
    $before.Length -ne $after.Length -or
    $before.CreationTimeUtc.Ticks -ne $after.CreationTimeUtc.Ticks -or
    $before.LastWriteTimeUtc.Ticks -ne $after.LastWriteTimeUtc.Ticks
  ) {
    Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native receipt artifact changed while it was hashed."
  }
  return $digest
}

function Test-Integer {
  param($Value)

  return (
    $Value -is [byte] -or $Value -is [sbyte] -or
    $Value -is [int16] -or $Value -is [uint16] -or
    $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64]
  )
}

function Test-SafeIdentifier {
  param($Value)

  return (
    $Value -is [string] -and
    $Value.Length -ge 1 -and
    $Value.Length -le 256 -and
    $Value -match '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  )
}

function Test-SensitiveText {
  param($Value)

  if ($Value -isnot [string]) { return $false }
  return $Value -match '(?i)-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----' -or
    $Value -match '(?i)\bauthorization\s*:\s*(?:bearer|basic)\s+\S+' -or
    $Value -match '(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}' -or
    $Value -match '\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b' -or
    $Value -match '\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b' -or
    $Value -match '\bAKIA[0-9A-Z]{16}\b' -or
    $Value -match '(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret[_-]?key)\b\s*[:=]\s*\S+' -or
    $Value -match '(?i)(?:^|[\s;&|])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|''[^'']*''|\S+)' -or
    $Value -match '(?i)(?:^|[\s;&|])\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|''[^'']*''|\S+)' -or
    $Value -match '(?i)(?:^|[\s;&|])set\s+(?:"[A-Za-z_][A-Za-z0-9_]*\s*=|[A-Za-z_][A-Za-z0-9_]*\s*=)\S*'
}

function Test-IsoTimestamp {
  param($Value)

  if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$') {
    return $false
  }
  $parsed = [DateTimeOffset]::MinValue
  return [DateTimeOffset]::TryParse(
    $Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal,
    [ref]$parsed
  )
}

function Get-Application {
  param(
    [Parameter(Mandatory = $true)][string[]]$Names,
    [Parameter(Mandatory = $true)][string]$Label
  )

  foreach ($name in $Names) {
    $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $command) {
      return $command.Source
    }
  }
  Stop-Smoke "COMMAND_MISSING" "$Label is not available as an application."
}

function Invoke-CheckedApplication {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$FailureCode,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  $output = @()
  $exitCode = 1
  Push-Location -LiteralPath $WorkingDirectory
  try {
    $output = @(& $Executable @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } catch {
    Stop-Smoke $FailureCode $FailureMessage
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    Stop-Smoke $FailureCode $FailureMessage
  }
  return (@($output | ForEach-Object { $_.ToString() }) -join "`n").Trim()
}

function Assert-ManifestAndVersions {
  param([Parameter(Mandatory = $true)][string]$Root)

  $manifestPath = Resolve-SafeFile $Root ".codex-plugin/plugin.json" "Codex manifest"
  $manifest = Read-StrictJson $manifestPath "Codex manifest"
  foreach ($field in @("name", "version", "skills", "hooks")) {
    if (@(Get-PropertyNames $manifest | Where-Object { $_ -ceq $field }).Count -ne 1) {
      Stop-Smoke "MANIFEST_INVALID" "The Codex manifest is missing a required field."
    }
  }
  if (
    $manifest.name -cne "harness50" -or
    $manifest.version -cne "2.1.0" -or
    $manifest.skills -cne "./codex/skills/" -or
    $manifest.hooks -cne "./codex/hooks/hooks.json"
  ) {
    Stop-Smoke "MANIFEST_INVALID" "The Codex manifest identity or package paths are unexpected."
  }

  $claudePath = Resolve-SafeFile $Root ".claude-plugin/plugin.json" "Claude manifest"
  $claude = Read-StrictJson $claudePath "Claude manifest"
  if ($claude.name -cne "harness50" -or $claude.version -cne $manifest.version) {
    Stop-Smoke "VERSION_MISMATCH" "The Claude and Codex manifest versions are not synchronized."
  }

  $marketplacePath = Resolve-SafeFile $Root ".claude-plugin/marketplace.json" "Marketplace manifest"
  $marketplace = Read-StrictJson $marketplacePath "Marketplace manifest"
  $entries = @($marketplace.plugins)
  $matching = @($entries | Where-Object { $_.name -ceq "harness50" })
  if (
    $marketplace.name -cne "harness50" -or
    $marketplace.metadata.version -cne $manifest.version -or
    $entries.Count -ne 1 -or
    $matching.Count -ne 1 -or
    $matching[0].version -cne $manifest.version
  ) {
    Stop-Smoke "VERSION_MISMATCH" "The marketplace and package versions are not synchronized."
  }

  $script:Report.manifest.name = $manifest.name
  $script:Report.manifest.version = $manifest.version
  $script:Report.manifest.skills = $manifest.skills
  $script:Report.manifest.hooks = $manifest.hooks
  $script:Report.manifest.claude_version_synchronized = $true
  $script:Report.manifest.marketplace_version_synchronized = $true
}

function Assert-Skills {
  param([Parameter(Mandatory = $true)][string]$Root)

  $skillsRoot = Resolve-SafeDirectory $Root "codex/skills" "Codex skills directory"
  $expected = @("webapp", "harness50-status", "harness50-reset")
  $entries = @(Get-ChildItem -Force -LiteralPath $skillsRoot -ErrorAction Stop)
  Assert-ExactNames -Items $entries -Expected $expected -Label "Codex skills directory"
  foreach ($name in $expected) {
    $directory = Resolve-SafeDirectory $skillsRoot $name "Codex skill directory"
    $children = @(Get-ChildItem -Force -LiteralPath $directory -ErrorAction Stop)
    Assert-ExactNames -Items $children -Expected @("SKILL.md") -Label "Codex skill resources"
    $skill = Resolve-SafeFile $directory "SKILL.md" "Codex skill resource"
    if ([string]::IsNullOrWhiteSpace((Read-StrictText $skill "Codex skill resource" 262144))) {
      Stop-Smoke "SKILL_INVALID" "A Codex skill resource is empty."
    }
  }
  $script:Report.skill_count = $expected.Count
}

function Assert-Steps {
  param([Parameter(Mandatory = $true)][string]$Root)

  $stepsRoot = Resolve-SafeDirectory $Root "codex/assets/steps" "Codex steps directory"
  $expectedNames = @("index.json", "PORTING.md")
  for ($step = 1; $step -le 50; $step += 1) {
    $expectedNames += "step{0:d3}.md" -f $step
  }
  $entries = @(Get-ChildItem -Force -LiteralPath $stepsRoot -ErrorAction Stop)
  Assert-ExactNames -Items $entries -Expected $expectedNames -Label "Codex steps directory"
  foreach ($entry in $entries) {
    if ($entry.PSIsContainer -or (Test-IsReparsePoint $entry)) {
      Stop-Smoke "STEP_PACKAGE_INVALID" "Every Codex step resource must be a physical regular file."
    }
  }

  $indexPath = Resolve-SafeFile $stepsRoot "index.json" "Codex step index"
  $index = Read-StrictJson $indexPath "Codex step index" 8388608
  Assert-ExactProperties $index @("schema_version", "steps") @() "Codex step index"
  if ($index.schema_version -ne 1) {
    Stop-Smoke "STEP_PACKAGE_INVALID" "The Codex step index schema is unexpected."
  }
  $rows = @($index.steps)
  if ($rows.Count -ne 50) {
    Stop-Smoke "STEP_PACKAGE_INVALID" "The Codex step index must contain exactly 50 rows."
  }
  for ($offset = 0; $offset -lt 50; $offset += 1) {
    $number = $offset + 1
    $id = "step{0:d3}" -f $number
    $row = $rows[$offset]
    if (
      $row.number -ne $number -or
      $row.id -cne $id -or
      $row.target -cne "codex/assets/steps/$id.md" -or
      $row.ported -isnot [bool] -or
      -not $row.ported
    ) {
      Stop-Smoke "STEP_PACKAGE_INVALID" "The Codex step index is not the exact ported 1-through-50 sequence."
    }
    [void](Resolve-SafeFile $stepsRoot "$id.md" "Codex step resource")
  }

  $node = Get-Application @("node.exe", "node") "Node.js"
  $validator = Resolve-SafeFile $Root "codex/scripts/validate-steps.mjs" "Codex step validator"
  $validatorOutput = Invoke-CheckedApplication `
    -Executable $node `
    -Arguments @($validator) `
    -WorkingDirectory $Root `
    -FailureCode "STEP_VALIDATION_FAILED" `
    -FailureMessage "The complete Codex step validation failed."
  if ($validatorOutput -cne "validated 50 indexed step(s)") {
    Stop-Smoke "STEP_VALIDATION_FAILED" "The complete Codex step validator returned an unexpected result."
  }
  $script:Report.step_count = 50
}

function Assert-Hooks {
  param([Parameter(Mandatory = $true)][string]$Root)

  $hookRoot = Resolve-SafeDirectory $Root "codex/hooks" "Codex hooks directory"
  $scripts = [ordered]@{
    PreToolUse = "pre-tool-use.mjs"
    SessionStart = "session-start.mjs"
    UserPromptSubmit = "user-prompt-submit.mjs"
    Stop = "stop.mjs"
  }
  $expectedFiles = @("hooks.json") + @($scripts.Values)
  $entries = @(Get-ChildItem -Force -LiteralPath $hookRoot -ErrorAction Stop)
  Assert-ExactNames -Items $entries -Expected $expectedFiles -Label "Codex hooks directory"
  foreach ($entry in $entries) {
    if ($entry.PSIsContainer -or (Test-IsReparsePoint $entry)) {
      Stop-Smoke "HOOK_CONFIG_INVALID" "Every Codex hook resource must be a physical regular file."
    }
  }

  $configPath = Resolve-SafeFile $hookRoot "hooks.json" "Codex hook configuration"
  $configText = Read-StrictText $configPath "Codex hook configuration" 262144
  $config = try {
    $configText | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Stop-Smoke "HOOK_CONFIG_INVALID" "The Codex hook configuration is not valid JSON."
  }
  Assert-ExactProperties $config @("hooks") @() "Codex hook configuration"
  Assert-ExactProperties $config.hooks @($scripts.Keys) @() "Codex hook event table"

  foreach ($eventName in $scripts.Keys) {
    $groups = @($config.hooks.$eventName)
    if ($groups.Count -ne 1) {
      Stop-Smoke "HOOK_CONFIG_INVALID" "Each Codex hook event must have exactly one group."
    }
    $group = $groups[0]
    if ($eventName -ceq "PreToolUse") {
      Assert-ExactProperties $group @("matcher", "hooks") @() "PreToolUse hook group"
      if ($group.matcher -cne "Bash|apply_patch") {
        Stop-Smoke "HOOK_CONFIG_INVALID" "The PreToolUse matcher is unexpected."
      }
    } else {
      Assert-ExactProperties $group @("hooks") @() "$eventName hook group"
    }
    $handlers = @($group.hooks)
    if ($handlers.Count -ne 1) {
      Stop-Smoke "HOOK_CONFIG_INVALID" "Each Codex hook event must have exactly one handler."
    }
    $handler = $handlers[0]
    Assert-ExactProperties $handler @("type", "command", "commandWindows", "timeout") @() "$eventName hook handler"
    $expectedCommand = 'node "${PLUGIN_ROOT}/codex/hooks/' + $scripts[$eventName] + '"'
    if (
      $handler.type -cne "command" -or
      $handler.command -cne $expectedCommand -or
      $handler.commandWindows -cne $expectedCommand -or
      $handler.timeout -ne 10
    ) {
      Stop-Smoke "HOOK_CONFIG_INVALID" "A Codex hook handler is not the exact synchronous bundled command."
    }
    $sourcePath = Resolve-SafeFile $hookRoot $scripts[$eventName] "$eventName hook source"
    $sourceText = Read-StrictText $sourcePath "$eventName hook source" 1048576
    if ($sourceText -match '(?i)permissionDecision\s*[:=]\s*["'']allow|auto[-_ ]?approve|dangerously[-_ ]?bypass|trust(?:ed)?[_ -]?(?:registry|store)') {
      Stop-Smoke "HOOK_SOURCE_INVALID" "A Codex hook source contains a forbidden approval or trust action."
    }
    $script:Report.hook_handler_checks[$eventName] = $true
    $script:Report.hook_handler_sha256[$eventName] = Get-Sha256 $sourcePath
  }
  if ($configText -match '(?i)PermissionRequest|auto[-_ ]?approve|dangerously[-_ ]?bypass|\$\{PLUGIN_ROOT\}/hooks/') {
    Stop-Smoke "HOOK_CONFIG_INVALID" "The Codex hook configuration contains a non-Codex or approval hook."
  }

  $script:Report.hook_source = "codex/hooks/hooks.json"
  $script:Report.hook_source_sha256 = Get-Sha256 $configPath
  $bundleMaterial = @($script:Report.hook_source_sha256)
  foreach ($eventName in $scripts.Keys) {
    $bundleMaterial += $script:Report.hook_handler_sha256[$eventName]
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bundleBytes = $script:Utf8Strict.GetBytes(($bundleMaterial -join "`n"))
    $script:Report.hook_bundle_sha256 = ([BitConverter]::ToString($sha.ComputeHash($bundleBytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  $script:Report.hook_handler_checks.synchronous = $true
  $script:Report.hook_handler_checks.no_permission_or_approval_hook = $true
  $script:Report.hook_handler_checks.source_files_regular = $true
}

function Get-CodexVersion {
  param([Parameter(Mandatory = $true)][string]$WorkingDirectory)

  $names = if ($script:IsWindowsPlatform) { @("codex.cmd") } else { @("codex", "codex.cmd") }
  $codex = Get-Application $names "Codex CLI"
  $version = Invoke-CheckedApplication `
    -Executable $codex `
    -Arguments @("--version") `
    -WorkingDirectory $WorkingDirectory `
    -FailureCode "CODEX_VERSION_FAILED" `
    -FailureMessage "The Codex CLI version check failed."
  if ($version -notmatch '^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$') {
    Stop-Smoke "CODEX_VERSION_FAILED" "The Codex CLI returned an unexpected version string."
  }
  return $version
}

function Get-InstalledPluginRoot {
  param(
    [Parameter(Mandatory = $true)][string]$RequestedRoot,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $names = if ($script:IsWindowsPlatform) { @("codex.cmd") } else { @("codex", "codex.cmd") }
  $codex = Get-Application $names "Codex CLI"
  $raw = Invoke-CheckedApplication `
    -Executable $codex `
    -Arguments @("plugin", "list", "--json") `
    -WorkingDirectory $WorkingDirectory `
    -FailureCode "PLUGIN_IDENTITY_FAILED" `
    -FailureMessage "The Codex CLI installed-plugin identity check failed."
  try {
    $catalog = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The Codex CLI installed-plugin evidence is not valid JSON."
  }
  Assert-ExactProperties $catalog @("installed", "available") @() "Codex plugin catalog"
  if ($catalog.installed -isnot [Array] -or $catalog.available -isnot [Array]) {
    Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The Codex CLI plugin catalog arrays are malformed."
  }
  $candidates = @()
  foreach ($entry in @($catalog.installed)) {
    $entryNames = @(Get-PropertyNames $entry)
    foreach ($identityField in @("pluginId", "name", "marketplaceName")) {
      if (@($entryNames | Where-Object { $_ -ceq $identityField }).Count -ne 1 -or $entry.$identityField -isnot [string]) {
        Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The Codex CLI installed-plugin evidence is malformed."
      }
    }
    if ($entry.pluginId -ceq "harness50@personal" -or $entry.name -ceq "harness50") {
      $candidates += $entry
    }
  }
  if ($candidates.Count -ne 1) {
    Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The Codex CLI did not report one unambiguous installed harness50 plugin."
  }
  $plugin = $candidates[0]
  Assert-ExactProperties $plugin @(
    "pluginId", "name", "marketplaceName", "version", "installed", "enabled",
    "source", "installPolicy", "authPolicy"
  ) @("marketplaceSource") "Installed harness50 plugin"
  if (
    $plugin.pluginId -cne "harness50@personal" -or
    $plugin.name -cne "harness50" -or
    $plugin.marketplaceName -cne "personal" -or
    $plugin.version -cne "2.1.0" -or
    $plugin.installed -isnot [bool] -or -not $plugin.installed -or
    $plugin.enabled -isnot [bool] -or -not $plugin.enabled -or
    $plugin.installPolicy -cne "AVAILABLE" -or
    $plugin.authPolicy -cne "ON_INSTALL"
  ) {
    Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The active harness50 plugin identity is unexpected."
  }
  Assert-ExactProperties $plugin.source @("source", "path") @() "Installed harness50 plugin source"
  if ($plugin.source.source -cne "local" -or -not (Test-FullyQualifiedFilesystemPath $plugin.source.path)) {
    Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The installed harness50 plugin source is not the expected local source."
  }
  $sourceRoot = Resolve-PhysicalDirectory $plugin.source.path "Installed harness50 source"
  if (@(Get-PropertyNames $plugin | Where-Object { $_ -ceq "marketplaceSource" }).Count -eq 1) {
    Assert-ExactProperties $plugin.marketplaceSource @("sourceType", "source") @() "Installed harness50 marketplace source"
    if (
      $plugin.marketplaceSource.sourceType -cne "local" -or
      -not (Test-FullyQualifiedFilesystemPath $plugin.marketplaceSource.source)
    ) {
      Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The installed harness50 marketplace source is malformed."
    }
    $marketplaceRoot = Resolve-PhysicalDirectory $plugin.marketplaceSource.source "Installed harness50 marketplace source"
    if (-not (Test-PathEqual $marketplaceRoot $sourceRoot)) {
      Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The personal marketplace and local harness50 source disagree."
    }
    [void](Resolve-SafeFile $marketplaceRoot ".claude-plugin/marketplace.json" "Installed harness50 marketplace manifest")
  }
  $sourceManifest = Resolve-SafeFile $sourceRoot ".codex-plugin/plugin.json" "Installed harness50 source manifest"
  $installedManifest = Resolve-SafeFile $RequestedRoot ".codex-plugin/plugin.json" "Installed harness50 manifest"
  $sourceIdentity = Read-StrictJson $sourceManifest "Installed harness50 source manifest"
  if (
    $sourceIdentity.name -cne "harness50" -or
    $sourceIdentity.version -cne "2.1.0" -or
    $sourceIdentity.skills -cne "./codex/skills/" -or
    $sourceIdentity.hooks -cne "./codex/hooks/hooks.json" -or
    (Get-Sha256 $sourceManifest) -cne (Get-Sha256 $installedManifest)
  ) {
    Stop-Smoke "PLUGIN_IDENTITY_FAILED" "The installed harness50 source manifest does not match the active package."
  }

  $codexHomeInput = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ".codex"
  } else {
    $env:CODEX_HOME
  }
  $codexHome = Resolve-PhysicalDirectory $codexHomeInput "Codex home"
  $expectedRoot = Resolve-PhysicalDirectory (
    Join-Path $codexHome "plugins/cache/personal/harness50/2.1.0"
  ) "Active harness50 plugin root"
  if (-not (Test-PathEqual $RequestedRoot $expectedRoot)) {
    Stop-Smoke "PLUGIN_IDENTITY_FAILED" "PluginRoot is not the active Codex harness50 installation."
  }
  return $expectedRoot
}

function Resolve-GitWorkspace {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $root = Resolve-PhysicalDirectory $Path $Label
  $git = Get-Application @("git.exe", "git") "Git"
  $inside = Invoke-CheckedApplication `
    -Executable $git `
    -Arguments @("-C", $root, "rev-parse", "--is-inside-work-tree") `
    -WorkingDirectory $root `
    -FailureCode "WORKSPACE_INVALID" `
    -FailureMessage "$Label is not a Git worktree."
  if ($inside -cne "true") {
    Stop-Smoke "WORKSPACE_INVALID" "$Label is not a Git worktree."
  }
  $reportedRoot = Invoke-CheckedApplication `
    -Executable $git `
    -Arguments @("-C", $root, "rev-parse", "--show-toplevel") `
    -WorkingDirectory $root `
    -FailureCode "WORKSPACE_INVALID" `
    -FailureMessage "$Label Git root could not be resolved."
  try {
    $gitRoot = [IO.Path]::GetFullPath($reportedRoot)
  } catch {
    Stop-Smoke "WORKSPACE_INVALID" "$Label Git root could not be resolved."
  }
  if (-not (Test-PathEqual $root $gitRoot)) {
    Stop-Smoke "WORKSPACE_INVALID" "$Label must be the Git worktree root."
  }
  Assert-NoReparseChain $gitRoot
  return $gitRoot
}

function Resolve-ExternalReportPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string[]]$ExcludedRoots
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    Stop-Smoke "REPORT_PATH_REQUIRED" "An external report path is required."
  }
  $isFullyQualified = if ($script:IsWindowsPlatform) {
    $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])'
  } else {
    $Path.StartsWith("/", [StringComparison]::Ordinal)
  }
  if (-not $isFullyQualified) {
    Stop-Smoke "REPORT_PATH_UNSAFE" "The report path must be fully qualified."
  }
  try {
    $full = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $full
    $leaf = Split-Path -Leaf $full
  } catch {
    Stop-Smoke "REPORT_PATH_UNSAFE" "The report path is invalid."
  }
  if ([string]::IsNullOrWhiteSpace($parent) -or [string]::IsNullOrWhiteSpace($leaf)) {
    Stop-Smoke "REPORT_PATH_UNSAFE" "The report path is invalid."
  }
  if (
    $leaf -cne $leaf.TrimEnd(' ', '.') -or
    $leaf.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
    -not $leaf.EndsWith(".json", [StringComparison]::OrdinalIgnoreCase) -or
    ($script:IsWindowsPlatform -and $leaf -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)')
  ) {
    Stop-Smoke "REPORT_PATH_UNSAFE" "The report filename is unsafe."
  }
  $resolvedParent = Resolve-PhysicalDirectory $parent "Report parent"
  $candidate = [IO.Path]::GetFullPath((Join-Path $resolvedParent $leaf))
  foreach ($root in $ExcludedRoots) {
    if (Test-PathInside -Root $root -Candidate $candidate -AllowEqual) {
      Stop-Smoke "REPORT_PATH_UNSAFE" "The report path must be outside checked package and workspace roots."
    }
  }
  if (Test-Path -LiteralPath $candidate) {
    Stop-Smoke "REPORT_PATH_EXISTS" "The report path must be fresh."
  }
  return $candidate
}

function Write-AtomicReport {
  param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Json
  )

  $parent = Split-Path -Parent $Destination
  $leaf = Split-Path -Leaf $Destination
  $temporary = Join-Path $parent (".{0}.{1}.{2}.tmp" -f $leaf, $PID, [guid]::NewGuid().ToString("N"))
  if (-not (Test-PathInside -Root $parent -Candidate $temporary)) {
    Stop-Smoke "REPORT_WRITE_FAILED" "The temporary report path escaped its parent."
  }
  $stream = $null
  try {
    $bytes = $script:Utf8Strict.GetBytes($Json + "`n")
    $stream = New-Object IO.FileStream(
      $temporary,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    if (Test-Path -LiteralPath $Destination) {
      Stop-Smoke "REPORT_PATH_EXISTS" "The report destination changed before publication."
    }
    [IO.File]::Move($temporary, $Destination)
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
      Stop-Smoke "REPORT_WRITE_FAILED" "The report could not be published atomically."
    }
  } catch {
    if ($_.Exception.Data.Contains("SmokeCode")) { throw }
    Stop-Smoke "REPORT_WRITE_FAILED" "The report could not be written atomically."
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporary) {
      if (-not (Test-PathInside -Root $parent -Candidate $temporary)) {
        Stop-Smoke "REPORT_CLEANUP_FAILED" "The exact temporary report path could not be verified."
      }
      [IO.File]::Delete($temporary)
      if (Test-Path -LiteralPath $temporary) {
        Stop-Smoke "REPORT_CLEANUP_FAILED" "The exact temporary report file could not be removed."
      }
    }
  }
}

function Assert-State {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $stateFields = @(
    "schema_version", "workflow_id", "status", "total_steps", "current_step",
    "completed_steps", "topic_path", "topic_sha256", "current_attempt",
    "consecutive_failures", "blocked_reason", "owner", "continuation",
    "stop_delivery", "imported_from", "last_stop_turn_id", "created_at",
    "updated_at", "completed_at"
  )
  Assert-ExactProperties $State $stateFields @() "$Label state"
  if (
    -not (Test-Integer $State.schema_version) -or
    $State.schema_version -ne 1 -or
    -not (Test-SafeIdentifier $State.workflow_id) -or
    @("running", "paused", "blocked", "completed") -cnotcontains $State.status -or
    -not (Test-Integer $State.total_steps) -or
    $State.total_steps -ne 50 -or
    $State.topic_path -cne "step_archive/TOPIC/TOPIC.md" -or
    $State.topic_sha256 -notmatch '^[a-f0-9]{64}$' -or
    -not (Test-Integer $State.consecutive_failures) -or
    $State.consecutive_failures -lt 0 -or
    ($null -ne $State.last_stop_turn_id -and -not (Test-SafeIdentifier $State.last_stop_turn_id)) -or
    -not (Test-IsoTimestamp $State.created_at) -or
    -not (Test-IsoTimestamp $State.updated_at)
  ) {
    Stop-Smoke "STATE_INVALID" "$Label state has an invalid core schema."
  }
  if ($null -ne $State.completed_at -and -not (Test-IsoTimestamp $State.completed_at)) {
    Stop-Smoke "STATE_INVALID" "$Label state has an invalid completion timestamp."
  }
  if (($State.status -ceq "completed") -ne ($null -ne $State.completed_at)) {
    Stop-Smoke "STATE_INVALID" "$Label state completion fields disagree."
  }
  if ($State.completed_steps -isnot [Array]) {
    Stop-Smoke "STATE_INVALID" "$Label completed steps must be an array."
  }
  $completed = @($State.completed_steps)
  for ($offset = 0; $offset -lt $completed.Count; $offset += 1) {
    if (-not (Test-Integer $completed[$offset]) -or $completed[$offset] -ne ($offset + 1)) {
      Stop-Smoke "STATE_INVALID" "$Label completed steps are not a contiguous prefix."
    }
  }
  if ($completed.Count -gt 50) {
    Stop-Smoke "STATE_INVALID" "$Label state contains too many completed steps."
  }
  $expectedCurrent = if ($completed.Count -eq 50) { $null } else { $completed.Count + 1 }
  if (
    ($null -ne $State.current_step -and -not (Test-Integer $State.current_step)) -or
    $State.current_step -ne $expectedCurrent
  ) {
    Stop-Smoke "STATE_INVALID" "$Label state does not point to the first incomplete step."
  }
  if (
    $State.status -ceq "completed" -and
    ($completed.Count -ne 50 -or $null -ne $State.current_attempt -or $null -ne $State.continuation)
  ) {
    Stop-Smoke "STATE_INVALID" "$Label completed state retains live work."
  }
  if ($State.status -ceq "blocked") {
    if ($State.blocked_reason -isnot [string] -or [string]::IsNullOrWhiteSpace($State.blocked_reason)) {
      Stop-Smoke "STATE_INVALID" "$Label blocked state has no reason."
    }
  } elseif ($null -ne $State.blocked_reason) {
    Stop-Smoke "STATE_INVALID" "$Label non-blocked state has a blocked reason."
  }

  $topicPath = Resolve-SafeFile $WorkspaceRoot "step_archive/TOPIC/TOPIC.md" "$Label topic"
  if ((Get-Sha256 $topicPath) -cne $State.topic_sha256) {
    Stop-Smoke "STATE_INVALID" "$Label topic hash does not match its state."
  }

  if ($null -ne $State.current_attempt) {
    Assert-ExactProperties $State.current_attempt @("id", "step", "session_id", "started_at", "failure_recorded") @() "$Label current attempt"
    if (
      -not (Test-SafeIdentifier $State.current_attempt.id) -or
      -not (Test-Integer $State.current_attempt.step) -or
      $State.current_attempt.step -ne $State.current_step -or
      ($null -ne $State.current_attempt.session_id -and -not (Test-SafeIdentifier $State.current_attempt.session_id)) -or
      -not (Test-IsoTimestamp $State.current_attempt.started_at) -or
      $State.current_attempt.failure_recorded -isnot [bool]
    ) {
      Stop-Smoke "STATE_INVALID" "$Label current attempt is invalid."
    }
  }
  if ($null -ne $State.owner) {
    Assert-ExactProperties $State.owner @("session_id", "lease_updated_at") @() "$Label owner"
    if (-not (Test-SafeIdentifier $State.owner.session_id) -or -not (Test-IsoTimestamp $State.owner.lease_updated_at)) {
      Stop-Smoke "STATE_INVALID" "$Label owner is invalid."
    }
  }
  if ($null -ne $State.continuation) {
    Assert-ExactProperties $State.continuation @("workflow_id", "step", "nonce", "issued_at", "baseline_receipt_count") @() "$Label continuation"
    if (
      $State.continuation.workflow_id -cne $State.workflow_id -or
      -not (Test-Integer $State.continuation.step) -or
      $State.continuation.step -ne $State.current_step -or
      -not (Test-SafeIdentifier $State.continuation.nonce) -or
      -not (Test-IsoTimestamp $State.continuation.issued_at) -or
      -not (Test-Integer $State.continuation.baseline_receipt_count) -or
      $State.continuation.baseline_receipt_count -lt 0 -or
      $State.continuation.baseline_receipt_count -gt 50 -or
      $State.continuation.baseline_receipt_count -ne $completed.Count
    ) {
      Stop-Smoke "STATE_INVALID" "$Label continuation is invalid."
    }
  }
  if ($null -ne $State.stop_delivery) {
    Assert-ExactProperties $State.stop_delivery @("generation_id", "requested_turn_id", "accepted", "allow_active_stop") @() "$Label Stop delivery"
    if (
      -not (Test-SafeIdentifier $State.stop_delivery.generation_id) -or
      ($null -ne $State.stop_delivery.requested_turn_id -and -not (Test-SafeIdentifier $State.stop_delivery.requested_turn_id)) -or
      $State.stop_delivery.accepted -isnot [bool] -or
      $State.stop_delivery.allow_active_stop -isnot [bool] -or
      ($State.stop_delivery.accepted -and $null -eq $State.stop_delivery.requested_turn_id) -or
      $State.status -cne "running" -or
      ($null -eq $State.continuation -and $null -eq $State.current_attempt)
    ) {
      Stop-Smoke "STATE_INVALID" "$Label Stop delivery is invalid."
    }
  }
  if (
    $null -eq $State.stop_delivery -and
    $State.status -ceq "running" -and
    ($null -ne $State.continuation -or $null -ne $State.current_attempt)
  ) {
    Stop-Smoke "STATE_INVALID" "$Label live generation has no Stop delivery."
  }
  if ($null -ne $State.imported_from) {
    Assert-ExactProperties $State.imported_from @("kind", "source_sha256", "imported_at", "prefix_length", "warnings") @() "$Label import metadata"
    if (
      $State.imported_from.kind -cne "claude-progress" -or
      $State.imported_from.source_sha256 -notmatch '^[a-f0-9]{64}$' -or
      -not (Test-IsoTimestamp $State.imported_from.imported_at) -or
      -not (Test-Integer $State.imported_from.prefix_length) -or
      $State.imported_from.prefix_length -lt 0 -or
      $State.imported_from.prefix_length -gt $completed.Count
    ) {
      Stop-Smoke "STATE_INVALID" "$Label import metadata is invalid."
    }
    if ($State.imported_from.warnings -isnot [Array]) {
      Stop-Smoke "STATE_INVALID" "$Label import warnings must be an array."
    }
    foreach ($warning in @($State.imported_from.warnings)) {
      if ($warning -isnot [string] -or $warning.Length -gt 1024) {
        Stop-Smoke "STATE_INVALID" "$Label import warning is invalid."
      }
    }
  }
  return $completed
}

function Read-Receipts {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$WorkflowId,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $receiptsRoot = Resolve-SafeDirectory $WorkspaceRoot "step_archive/.harness50-codex/receipts" "$Label receipts directory"
  $entries = @(Get-ChildItem -Force -LiteralPath $receiptsRoot -ErrorAction Stop)
  $receipts = @()
  foreach ($entry in $entries) {
    if ($entry.PSIsContainer -or (Test-IsReparsePoint $entry) -or $entry.Name -notmatch '^step([0-9]{3})\.json$') {
      Stop-Smoke "RECEIPT_INVALID" "$Label receipts directory contains an unexpected entry."
    }
    $pathStep = [int]$Matches[1]
    if ($pathStep -lt 1 -or $pathStep -gt 50) {
      Stop-Smoke "RECEIPT_INVALID" "$Label receipt filename has an invalid step."
    }
    $path = Resolve-SafeFile $receiptsRoot $entry.Name "$Label receipt"
    $receipt = Read-StrictJson $path "$Label receipt" 1048576
    Assert-ExactProperties $receipt @(
      "schema_version", "workflow_id", "step", "attempt_id", "provenance",
      "completed_at", "summary", "evidence"
    ) @("source_sha256") "$Label receipt"
    if (
      -not (Test-Integer $receipt.schema_version) -or
      $receipt.schema_version -ne 1 -or
      $receipt.workflow_id -cne $WorkflowId -or
      -not (Test-Integer $receipt.step) -or
      $receipt.step -ne $pathStep -or
      @("codex-verified", "claude-progress-import") -cnotcontains $receipt.provenance -or
      -not (Test-IsoTimestamp $receipt.completed_at) -or
      $receipt.summary -isnot [string] -or
      [string]::IsNullOrWhiteSpace($receipt.summary) -or
      $receipt.summary.Length -gt 4096
    ) {
      Stop-Smoke "RECEIPT_INVALID" "$Label receipt has an invalid core schema."
    }
    if (Test-SensitiveText $receipt.summary) {
      Stop-Smoke "RECEIPT_INVALID" "$Label receipt contains sensitive material."
    }
    if ($receipt.provenance -ceq "codex-verified") {
      if (-not (Test-SafeIdentifier $receipt.attempt_id) -or @(Get-PropertyNames $receipt | Where-Object { $_ -ceq "source_sha256" }).Count -ne 0) {
        Stop-Smoke "RECEIPT_INVALID" "$Label Codex receipt has invalid provenance fields."
      }
    } else {
      if ($null -ne $receipt.attempt_id -or $receipt.source_sha256 -notmatch '^[a-f0-9]{64}$') {
        Stop-Smoke "RECEIPT_INVALID" "$Label imported receipt has invalid provenance fields."
      }
    }
    if ($receipt.evidence -isnot [Array]) {
      Stop-Smoke "RECEIPT_INVALID" "$Label receipt evidence must be an array."
    }
    $evidence = @($receipt.evidence)
    if ($evidence.Count -eq 0) {
      Stop-Smoke "RECEIPT_INVALID" "$Label receipt has no evidence."
    }
    foreach ($item in $evidence) {
      Assert-ExactProperties $item @("acceptance_id", "kind", "detail", "ok") @(
        "artifact_path", "artifact_sha256", "command", "exit_code"
      ) "$Label receipt evidence"
      if (
        ($null -ne $item.acceptance_id -and (
          $item.acceptance_id -isnot [string] -or [string]::IsNullOrWhiteSpace($item.acceptance_id)
        )) -or
        @("command", "artifact", "check", "import") -cnotcontains $item.kind -or
        $item.detail -isnot [string] -or
        [string]::IsNullOrWhiteSpace($item.detail) -or
        $item.detail.Length -gt 4096 -or
        $item.ok -isnot [bool]
      ) {
        Stop-Smoke "RECEIPT_INVALID" "$Label receipt evidence is invalid."
      }
      $itemFields = @(Get-PropertyNames $item)
      if (
        ($itemFields -contains "artifact_path" -and (
          $item.artifact_path -isnot [string] -or [string]::IsNullOrWhiteSpace($item.artifact_path)
        )) -or
        ($itemFields -contains "artifact_sha256" -and $item.artifact_sha256 -notmatch '^[a-f0-9]{64}$') -or
        ($itemFields -contains "command" -and (
          $item.command -isnot [string] -or [string]::IsNullOrWhiteSpace($item.command)
        )) -or
        ($itemFields -contains "exit_code" -and -not (Test-Integer $item.exit_code))
      ) {
        Stop-Smoke "RECEIPT_INVALID" "$Label receipt evidence has invalid optional fields."
      }
      foreach ($property in $item.PSObject.Properties) {
        if (Test-SensitiveText $property.Value) {
          Stop-Smoke "RECEIPT_INVALID" "$Label receipt contains sensitive material."
        }
      }
    }
    $receipts += $receipt
  }
  return @($receipts | Sort-Object -Property step)
}

function Read-Events {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$WorkflowId,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $eventPath = Resolve-SafeFile $WorkspaceRoot "step_archive/.harness50-codex/events.jsonl" "$Label event log"
  $raw = Read-StrictText $eventPath "$Label event log" 1048576
  if ($raw.Contains("`r")) {
    Stop-Smoke "EVENT_INVALID" "$Label event log must use canonical LF records."
  }
  $lines = @($raw -split "`n")
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -ceq "") {
    if ($lines.Count -eq 1) { $lines = @() } else { $lines = @($lines[0..($lines.Count - 2)]) }
  }
  if ($lines.Count -eq 0 -or @($lines | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) {
    Stop-Smoke "EVENT_INVALID" "$Label event log has invalid JSON-lines framing."
  }

  $schemas = @{
    continuation_replay_rejected = @(@("kind", "timestamp", "workflow_id", "step", "error_code"), @())
    continuation_issued = @(@("kind", "timestamp", "workflow_id", "step", "generation_id", "baseline_receipt_count"), @())
    continuation_consumed = @(@("kind", "timestamp", "workflow_id", "step", "attempt_id", "generation_id", "baseline_receipt_count"), @("session_id"))
    step_completed = @(@("kind", "timestamp", "workflow_id", "step", "attempt_id", "completed_count"), @())
    step_failed = @(@("kind", "timestamp", "workflow_id", "step", "attempt_id", "failure_count", "consecutive_failures"), @())
    workflow_blocked = @(@("kind", "timestamp", "workflow_id", "step", "status", "reason_code"), @("consecutive_failures"))
    workflow_paused = @(@("kind", "timestamp", "workflow_id", "step", "status", "reason_code"), @())
    workflow_resumed = @(@("kind", "timestamp", "workflow_id", "step", "status"), @("session_id"))
    stop_continuation_requested = @(@("kind", "timestamp", "workflow_id", "step", "turn_id", "generation_id", "baseline_receipt_count"), @())
    continuation_prompt_accepted = @(@("kind", "timestamp", "workflow_id", "step", "turn_id", "generation_id", "baseline_receipt_count"), @())
    session_context_loaded = @(@("kind", "timestamp", "workflow_id", "step", "status", "completed_count"), @())
    guard_denied = @(@("kind", "timestamp", "tool_name", "rule_id"), @())
    guard_deferred = @(@("kind", "timestamp", "tool_name", "rule_id"), @())
    claude_imported = @(@("kind", "timestamp", "workflow_id", "imported_prefix_count"), @("selected_step"))
  }
  $events = @()
  foreach ($line in $lines) {
    if ($line.Length -gt 65536) {
      Stop-Smoke "EVENT_INVALID" "$Label event record is too large."
    }
    try {
      $event = $line | ConvertFrom-Json -ErrorAction Stop
    } catch {
      Stop-Smoke "EVENT_INVALID" "$Label event log contains invalid JSON."
    }
    if ($null -eq $event -or $event -is [Array] -or $event -is [string] -or $event -is [ValueType]) {
      Stop-Smoke "EVENT_INVALID" "$Label event record must be an object."
    }
    if ($event.kind -isnot [string] -or -not $schemas.ContainsKey($event.kind)) {
      Stop-Smoke "EVENT_INVALID" "$Label event log contains an unknown event kind."
    }
    $schema = $schemas[$event.kind]
    Assert-ExactProperties $event @($schema[0]) @($schema[1]) "$Label event"
    if (-not (Test-IsoTimestamp $event.timestamp)) {
      Stop-Smoke "EVENT_INVALID" "$Label event timestamp is invalid."
    }
    $fieldNames = @(Get-PropertyNames $event)
    if (@($fieldNames | Where-Object { $_ -match '(?i)prompt|command|secret|transcript|token|authorization|password|content|message' }).Count -ne 0) {
      Stop-Smoke "EVENT_SENSITIVE" "$Label event contains a forbidden content field."
    }
    foreach ($property in $event.PSObject.Properties) {
      if ($property.Value -is [string] -and $property.Value -match '(?i)-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|password|passwd|secret|token)\s*[:=]') {
        Stop-Smoke "EVENT_SENSITIVE" "$Label event contains sensitive material."
      }
    }
    if ($fieldNames -contains "workflow_id") {
      if ($event.workflow_id -cne $WorkflowId) {
        Stop-Smoke "EVENT_INVALID" "$Label event belongs to a different workflow."
      }
    }
    foreach ($identifierField in @("workflow_id", "attempt_id", "session_id", "turn_id", "generation_id")) {
      if ($fieldNames -contains $identifierField -and -not (Test-SafeIdentifier $event.$identifierField)) {
        Stop-Smoke "EVENT_INVALID" "$Label event contains an invalid identifier."
      }
    }
    if ($fieldNames -contains "step" -and (
      -not (Test-Integer $event.step) -or $event.step -lt 1 -or $event.step -gt 50
    )) {
      Stop-Smoke "EVENT_INVALID" "$Label event contains an invalid step."
    }
    foreach ($countField in @("selected_step", "baseline_receipt_count", "completed_count", "failure_count", "consecutive_failures", "imported_prefix_count")) {
      if ($fieldNames -contains $countField -and (
        -not (Test-Integer $event.$countField) -or $event.$countField -lt 0 -or $event.$countField -gt 50
      )) {
        Stop-Smoke "EVENT_INVALID" "$Label event contains an invalid count."
      }
    }
    if ($fieldNames -contains "status" -and @("running", "paused", "blocked", "completed") -cnotcontains $event.status) {
      Stop-Smoke "EVENT_INVALID" "$Label event contains an invalid status."
    }
    if ($fieldNames -contains "tool_name" -and @("Bash", "apply_patch") -cnotcontains $event.tool_name) {
      Stop-Smoke "EVENT_INVALID" "$Label event contains an unexpected tool name."
    }
    if ($fieldNames -contains "rule_id" -and ($event.rule_id -isnot [string] -or $event.rule_id -notmatch '^[a-z][a-z0-9-]*$')) {
      Stop-Smoke "EVENT_INVALID" "$Label event contains an invalid guard rule."
    }
    if ($fieldNames -contains "error_code" -and ($event.error_code -isnot [string] -or $event.error_code -notmatch '^[A-Z][A-Z0-9_]*$')) {
      Stop-Smoke "EVENT_INVALID" "$Label event contains an invalid error code."
    }
    if ($fieldNames -contains "reason_code" -and ($event.reason_code -isnot [string] -or $event.reason_code -notmatch '^[A-Z][A-Z0-9_]*$')) {
      Stop-Smoke "EVENT_INVALID" "$Label event contains an invalid reason code."
    }
    if (
      ($event.kind -ceq "workflow_paused" -and (
        $event.status -cne "paused" -or $event.reason_code -cne "USER_REQUEST"
      )) -or
      ($event.kind -ceq "workflow_resumed" -and $event.status -cne "running") -or
      ($event.kind -ceq "workflow_blocked" -and $event.status -cne "blocked")
    ) {
      Stop-Smoke "EVENT_INVALID" "$Label event has invalid transition semantics."
    }
    $events += $event
  }
  return $events
}

function Get-FirstEventIndex {
  param(
    [Parameter(Mandatory = $true)][object[]]$Events,
    [Parameter(Mandatory = $true)][string]$Kind,
    [int]$StartAt = 0
  )

  for ($index = $StartAt; $index -lt $Events.Count; $index += 1) {
    if ($Events[$index].kind -ceq $Kind) { return $index }
  }
  return -1
}

function Get-NativeStepContract {
  param(
    [Parameter(Mandatory = $true)][string]$PluginRoot,
    [Parameter(Mandatory = $true)][int]$Step
  )

  $indexPath = Resolve-SafeFile $PluginRoot "codex/assets/steps/index.json" "Codex step index"
  $index = Read-StrictJson $indexPath "Codex step index" 8388608
  if ($index.steps -isnot [Array] -or @($index.steps).Count -ne 50) {
    Stop-Smoke "STEP_PACKAGE_INVALID" "The Codex step index is not canonical."
  }
  $contract = @($index.steps)[$Step - 1]
  if (
    $contract.number -ne $Step -or
    $contract.id -cne ("step{0:d3}" -f $Step) -or
    $contract.acceptance -isnot [Array] -or
    @($contract.acceptance).Count -eq 0
  ) {
    Stop-Smoke "STEP_PACKAGE_INVALID" "The Codex step acceptance contract is invalid."
  }
  return $contract
}

function Assert-NativeReceiptEvidence {
  param(
    [Parameter(Mandatory = $true)]$Receipt,
    [Parameter(Mandatory = $true)]$Contract,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )

  $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($item in @($Receipt.evidence)) {
    if (
      $item.acceptance_id -isnot [string] -or
      [string]::IsNullOrWhiteSpace($item.acceptance_id) -or
      $item.ok -ne $true
    ) {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native evidence must be successful and declaration-bound."
    }
    if (-not $seen.Add($item.acceptance_id)) {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native evidence contains a duplicate acceptance ID."
    }
    $declarations = @($Contract.acceptance | Where-Object { $_.id -ceq $item.acceptance_id })
    if ($declarations.Count -ne 1) {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native evidence references an undeclared acceptance ID."
    }
    $declaration = $declarations[0]
    if ($item.kind -cne $declaration.kind -or $item.kind -ceq "import") {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native evidence kind does not match its declaration."
    }
    if ($item.kind -ceq "artifact") {
      Assert-ExactProperties $item @(
        "acceptance_id", "kind", "detail", "ok", "artifact_path", "artifact_sha256"
      ) @() "Native artifact evidence"
      if ($item.artifact_path -cne $declaration.path) {
        Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native artifact evidence does not match its declaration."
      }
      if ((Get-SafeArtifactSha256 $WorkspaceRoot $item.artifact_path) -cne $item.artifact_sha256) {
        Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native artifact evidence hash does not match stable workspace bytes."
      }
    } elseif ($item.kind -ceq "command") {
      Assert-ExactProperties $item @(
        "acceptance_id", "kind", "detail", "ok", "command", "exit_code"
      ) @() "Native command evidence"
      $declarationFields = @(Get-PropertyNames $declaration)
      $commandMatches = if ($declarationFields -contains "command") {
        $item.command -ceq $declaration.command
      } elseif ($declarationFields -contains "command_pattern") {
        $item.command -cmatch $declaration.command_pattern
      } else {
        $false
      }
      if (-not $commandMatches -or $item.exit_code -ne 0) {
        Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native command evidence does not prove its declared command."
      }
    } elseif ($item.kind -ceq "check") {
      Assert-ExactProperties $item @("acceptance_id", "kind", "detail", "ok") @() "Native check evidence"
    } else {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native evidence kind is invalid."
    }
  }
  foreach ($declaration in @($Contract.acceptance)) {
    if ($declaration.required -eq $true -and -not $seen.Contains($declaration.id)) {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native receipt is missing required acceptance evidence."
    }
  }

}

function Assert-NativeEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$PluginRoot
  )

  $statePath = Resolve-SafeFile $WorkspaceRoot "step_archive/.harness50-codex/state.json" "Native state"
  $state = Read-StrictJson $statePath "Native state" 1048576
  $completed = @(Assert-State $state $WorkspaceRoot "Native")
  if (
    $state.imported_from -ne $null -or
    $state.status -cne "paused" -or
    $state.continuation -ne $null -or
    $state.stop_delivery -ne $null -or
    $completed.Count -lt 1 -or
    $completed.Count -ge 50
  ) {
    Stop-Smoke "NATIVE_STATE_INVALID" "Native smoke state must be a paused, incomplete, Codex-native workflow with completed work."
  }
  $receipts = @(Read-Receipts $WorkspaceRoot $state.workflow_id "Native")
  if ($receipts.Count -ne $completed.Count) {
    Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native receipts do not match completed state."
  }
  for ($offset = 0; $offset -lt $receipts.Count; $offset += 1) {
    if ($receipts[$offset].step -ne ($offset + 1) -or $receipts[$offset].provenance -cne "codex-verified") {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native smoke receipts must be a Codex-verified prefix."
    }
    $contract = Get-NativeStepContract $PluginRoot $receipts[$offset].step
    Assert-NativeReceiptEvidence $receipts[$offset] $contract $WorkspaceRoot
  }

  $events = @(Read-Events $WorkspaceRoot $state.workflow_id "Native")
  foreach ($forbidden in @("step_failed", "workflow_blocked", "claude_imported")) {
    if (@($events | Where-Object { $_.kind -ceq $forbidden }).Count -ne 0) {
      Stop-Smoke "NATIVE_EVENTS_INVALID" "Native smoke events contain a failed, blocked, or imported transition."
    }
  }
  foreach ($receipt in $receipts) {
    $completion = @($events | Where-Object {
      $_.kind -ceq "step_completed" -and
      $_.step -eq $receipt.step -and
      $_.attempt_id -ceq $receipt.attempt_id -and
      $_.completed_count -eq $receipt.step
    })
    if ($completion.Count -ne 1) {
      Stop-Smoke "NATIVE_RECEIPTS_INVALID" "Native receipt is not linked to one successful step attempt."
    }
  }
  $requiredKinds = @(
    "session_context_loaded", "continuation_issued", "continuation_consumed",
    "continuation_replay_rejected", "workflow_paused", "workflow_resumed",
    "guard_denied", "guard_deferred", "stop_continuation_requested",
    "continuation_prompt_accepted"
  )
  foreach ($kind in $requiredKinds) {
    if (@($events | Where-Object { $_.kind -ceq $kind }).Count -eq 0) {
      Stop-Smoke "NATIVE_EVENTS_MISSING" "Native smoke events do not prove the required trusted lifecycle."
    }
  }

  $stopIndex = Get-FirstEventIndex $events "stop_continuation_requested"
  $stop = $events[$stopIndex]
  $issuedIndex = -1
  for ($index = 0; $index -lt $stopIndex; $index += 1) {
    $candidate = $events[$index]
    if (
      $candidate.kind -ceq "continuation_issued" -and
      $candidate.step -eq $stop.step -and
      $candidate.generation_id -ceq $stop.generation_id -and
      $candidate.baseline_receipt_count -eq $stop.baseline_receipt_count
    ) {
      $issuedIndex = $index
    }
  }
  if (
    $issuedIndex -lt 0 -or
    $stop.baseline_receipt_count -lt 1 -or
    $stop.step -ne ($stop.baseline_receipt_count + 1)
  ) {
    Stop-Smoke "NATIVE_CONTINUATION_INVALID" "Native events do not prove the issued one-step continuation."
  }
  $acceptedIndex = -1
  $consumedIndex = -1
  for ($index = $stopIndex + 1; $index -lt $events.Count; $index += 1) {
    $candidate = $events[$index]
    if (
      $acceptedIndex -lt 0 -and
      $candidate.kind -ceq "continuation_prompt_accepted" -and
      $candidate.step -eq $stop.step -and
      $candidate.generation_id -ceq $stop.generation_id -and
      $candidate.turn_id -ceq $stop.turn_id -and
      $candidate.baseline_receipt_count -eq $stop.baseline_receipt_count
    ) {
      $acceptedIndex = $index
      continue
    }
    if (
      $acceptedIndex -ge 0 -and
      $candidate.kind -ceq "continuation_consumed" -and
      $candidate.step -eq $stop.step -and
      $candidate.generation_id -ceq $stop.generation_id -and
      $candidate.baseline_receipt_count -eq $stop.baseline_receipt_count
    ) {
      $consumedIndex = $index
      break
    }
  }
  if ($acceptedIndex -lt 0 -or $consumedIndex -lt 0) {
    Stop-Smoke "NATIVE_CONTINUATION_INVALID" "Native events do not prove one Stop marker was accepted and consumed."
  }
  $replayIndex = Get-FirstEventIndex $events "continuation_replay_rejected" ($consumedIndex + 1)
  if (
    $replayIndex -lt 0 -or
    $events[$replayIndex].step -ne $stop.step -or
    $events[$replayIndex].error_code -cne "CONTINUATION_REPLAY"
  ) {
    Stop-Smoke "NATIVE_REPLAY_INVALID" "Native events do not prove consumed-marker replay rejection."
  }
  $pauseIndex = Get-FirstEventIndex $events "workflow_paused"
  $resumeIndex = Get-FirstEventIndex $events "workflow_resumed" ($pauseIndex + 1)
  $finalPauseIndex = Get-FirstEventIndex $events "workflow_paused" ($consumedIndex + 1)
  if (
    $pauseIndex -lt 0 -or
    $resumeIndex -lt 0 -or
    $finalPauseIndex -lt 0 -or
    $replayIndex -ge $finalPauseIndex -or
    $events[$finalPauseIndex].step -ne $state.current_step
  ) {
    Stop-Smoke "NATIVE_PAUSE_RESUME_INVALID" "Native events do not prove pause, resume, and a safe paused boundary."
  }
  $consumed = $events[$consumedIndex]
  $consumedFields = @(Get-PropertyNames $consumed)
  if (
    $null -eq $state.current_attempt -or
    $state.current_attempt.id -cne $consumed.attempt_id -or
    $state.current_attempt.step -ne $consumed.step -or
    $state.current_attempt.failure_recorded -ne $false -or
    (($consumedFields -contains "session_id") -ne ($null -ne $state.current_attempt.session_id)) -or
    ($consumedFields -contains "session_id" -and $state.current_attempt.session_id -cne $consumed.session_id)
  ) {
    Stop-Smoke "NATIVE_STATE_INVALID" "Native paused state is not tied to the consumed, non-failed attempt."
  }
  if (
    $null -ne $state.owner -and
    $state.owner.session_id -cne $state.current_attempt.session_id
  ) {
    Stop-Smoke "NATIVE_STATE_INVALID" "Native paused state owner does not match the consumed attempt session."
  }
  $denialIndex = -1
  $deferralIndex = -1
  for ($index = $resumeIndex + 1; $index -lt $finalPauseIndex; $index += 1) {
    $candidate = $events[$index]
    if (
      $candidate.kind -ceq "guard_denied" -and
      $candidate.tool_name -ceq "Bash" -and
      @("protected-root", "git-destructive", "system-destructive") -ccontains $candidate.rule_id
    ) {
      $denialIndex = $index
    }
    if (
      $candidate.kind -ceq "guard_deferred" -and
      $candidate.tool_name -ceq "Bash" -and
      $candidate.rule_id -ceq "no-match"
    ) {
      $deferralIndex = $index
    }
  }
  if ($denialIndex -lt 0 -or $deferralIndex -lt 0) {
    Stop-Smoke "NATIVE_GUARD_INVALID" "Native events do not prove destructive denial and benign deferral."
  }

  foreach ($kind in @(
    "session_context_loaded", "continuation_issued", "continuation_consumed",
    "continuation_replay_rejected", "workflow_paused", "workflow_resumed",
    "guard_denied", "guard_deferred"
  )) {
    $script:Report.observed_events[$kind] = $true
  }
  $script:Report.native_receipt_count = $receipts.Count
  $script:Report.native_codex_verified_receipt_count = $receipts.Count
}

function Assert-ImportEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedHash
  )

  $progressPath = Resolve-SafeFile $WorkspaceRoot "step_archive/progress.json" "Preserved Claude progress"
  $actualHash = Get-Sha256 $progressPath
  $script:Report.claude_progress_sha256_before_expected = $ExpectedHash
  $script:Report.claude_progress_sha256_after = $actualHash
  if ($actualHash -cne $ExpectedHash) {
    Stop-Smoke "CLAUDE_SOURCE_CHANGED" "The preserved Claude progress hash changed."
  }

  $statePath = Resolve-SafeFile $WorkspaceRoot "step_archive/.harness50-codex/state.json" "Import state"
  $state = Read-StrictJson $statePath "Import state" 1048576
  $completed = @(Assert-State $state $WorkspaceRoot "Import")
  if (
    $state.status -cne "paused" -or
    $state.current_step -ne 18 -or
    $state.current_attempt -ne $null -or
    $state.continuation -ne $null -or
    $state.stop_delivery -ne $null -or
    $null -eq $state.imported_from -or
    $state.imported_from.kind -cne "claude-progress" -or
    $state.imported_from.source_sha256 -cne $ExpectedHash -or
    $state.imported_from.prefix_length -ne 17 -or
    $completed.Count -ne 17
  ) {
    Stop-Smoke "IMPORT_STATE_INVALID" "Import smoke state is not the paused Step 18 boundary."
  }
  $receipts = @(Read-Receipts $WorkspaceRoot $state.workflow_id "Import")
  if ($receipts.Count -ne 17) {
    Stop-Smoke "IMPORT_RECEIPTS_INVALID" "Import smoke must contain exactly 17 historical receipts."
  }
  for ($offset = 0; $offset -lt 17; $offset += 1) {
    $receipt = $receipts[$offset]
    if (
      $receipt.step -ne ($offset + 1) -or
      $receipt.provenance -cne "claude-progress-import" -or
      $receipt.source_sha256 -cne $ExpectedHash -or
      $receipt.completed_at -cne $state.imported_from.imported_at -or
      $receipt.summary -cne ("Imported historical completion for step {0}" -f ($offset + 1)) -or
      @($receipt.evidence).Count -ne 1 -or
      $receipt.evidence[0].kind -cne "import" -or
      $receipt.evidence[0].ok -ne $true -or
      $null -ne $receipt.evidence[0].acceptance_id -or
      $receipt.evidence[0].detail -cne "Historical completion imported from preserved Claude progress"
    ) {
      Stop-Smoke "IMPORT_RECEIPTS_INVALID" "Imported receipts are not an exact separated historical prefix."
    }
    Assert-ExactProperties $receipt.evidence[0] @("acceptance_id", "kind", "detail", "ok") @() "Imported receipt evidence"
  }
  $events = @(Read-Events $WorkspaceRoot $state.workflow_id "Import")
  if (@($events | Where-Object { $_.kind -in @("step_completed", "step_failed", "workflow_blocked") }).Count -ne 0) {
    Stop-Smoke "IMPORT_EVENTS_INVALID" "Import smoke contains a Codex completion or failure event."
  }
  $imports = @($events | Where-Object {
    $_.kind -ceq "claude_imported" -and
    $_.selected_step -eq 18 -and
    $_.imported_prefix_count -eq 17
  })
  $pauses = @($events | Where-Object {
    $_.kind -ceq "workflow_paused" -and $_.step -eq 18 -and
    $_.status -ceq "paused" -and $_.reason_code -ceq "USER_REQUEST"
  })
  if ($imports.Count -ne 1 -or $pauses.Count -eq 0) {
    Stop-Smoke "IMPORT_EVENTS_INVALID" "Import events do not prove one Step 18 selection and paused boundary."
  }
  $script:Report.observed_events.claude_imported = $true
  $script:Report.import_receipt_count = $receipts.Count
  $script:Report.imported_receipt_count = $receipts.Count
}

function Invoke-Preflight {
  param([Parameter(Mandatory = $true)][string]$Root)

  Assert-ManifestAndVersions $Root
  Assert-Skills $Root
  Assert-Steps $Root
  Assert-Hooks $Root
  $script:Report.codex_version = Get-CodexVersion $Root
}

try {
  $resolvedPluginRoot = Resolve-PhysicalDirectory $PluginRoot "Plugin root"
  $script:Report.resolved_installed_root = $resolvedPluginRoot
  Invoke-Preflight $resolvedPluginRoot

  if ($Mode -ceq "Preflight") {
    if (
      -not [string]::IsNullOrWhiteSpace($NativeWorkspace) -or
      -not [string]::IsNullOrWhiteSpace($ImportWorkspace) -or
      -not [string]::IsNullOrWhiteSpace($ExpectedClaudeProgressSha256)
    ) {
      Stop-Smoke "PARAMETER_INVALID" "After-trust workspace parameters are not accepted in Preflight mode."
    }
    if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
      $script:SafeReportDestination = Resolve-ExternalReportPath $ReportPath @($resolvedPluginRoot)
    }
  } else {
    if (
      [string]::IsNullOrWhiteSpace($NativeWorkspace) -or
      [string]::IsNullOrWhiteSpace($ImportWorkspace) -or
      [string]::IsNullOrWhiteSpace($ExpectedClaudeProgressSha256) -or
      [string]::IsNullOrWhiteSpace($ReportPath)
    ) {
      Stop-Smoke "PARAMETER_REQUIRED" "AfterTrust mode requires both workspaces, the expected Claude hash, and an external report path."
    }
    $expectedHash = $ExpectedClaudeProgressSha256.ToLowerInvariant()
    if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
      Stop-Smoke "HASH_INVALID" "The expected Claude progress hash must be one SHA-256 digest."
    }
    $resolvedPluginRoot = Get-InstalledPluginRoot $resolvedPluginRoot $resolvedPluginRoot
    $script:Report.resolved_installed_root = $resolvedPluginRoot
    $nativeRoot = Resolve-GitWorkspace $NativeWorkspace "Native workspace"
    $importRoot = Resolve-GitWorkspace $ImportWorkspace "Import workspace"
    if (
      (Test-PathEqual $nativeRoot $importRoot) -or
      (Test-PathInside -Root $nativeRoot -Candidate $importRoot -AllowEqual) -or
      (Test-PathInside -Root $importRoot -Candidate $nativeRoot -AllowEqual) -or
      (Test-PathInside -Root $resolvedPluginRoot -Candidate $nativeRoot -AllowEqual) -or
      (Test-PathInside -Root $resolvedPluginRoot -Candidate $importRoot -AllowEqual) -or
      (Test-PathInside -Root $nativeRoot -Candidate $resolvedPluginRoot -AllowEqual) -or
      (Test-PathInside -Root $importRoot -Candidate $resolvedPluginRoot -AllowEqual)
    ) {
      Stop-Smoke "WORKSPACE_INVALID" "Smoke workspaces must be distinct from each other and the installed package."
    }
    $script:SafeReportDestination = Resolve-ExternalReportPath $ReportPath @(
      $resolvedPluginRoot,
      $nativeRoot,
      $importRoot
    )
    Assert-NativeEvidence $nativeRoot $resolvedPluginRoot
    Assert-ImportEvidence $importRoot $expectedHash
  }

  $script:Report.passed = $true
  $json = $script:Report | ConvertTo-Json -Depth 12 -Compress
  if ($null -ne $script:SafeReportDestination) {
    Write-AtomicReport $script:SafeReportDestination $json
  }
  Write-Output $json
  exit 0
} catch {
  $code = "UNEXPECTED_FAILURE"
  $message = "Smoke validation failed."
  if ($_.Exception.Data.Contains("SmokeCode")) {
    $candidateCode = [string]$_.Exception.Data["SmokeCode"]
    if ($candidateCode -match '^[A-Z][A-Z0-9_]{2,63}$') {
      $code = $candidateCode
      $message = [string]$_.Exception.Message
    }
  }
  $failure = [ordered]@{}
  foreach ($key in $script:Report.Keys) { $failure[$key] = $script:Report[$key] }
  $failure["error_code"] = $code
  $failure["error"] = $message
  $failure.passed = $false
  $json = $failure | ConvertTo-Json -Depth 12 -Compress
  if ($null -ne $script:SafeReportDestination) {
    try { Write-AtomicReport $script:SafeReportDestination $json } catch { }
  }
  [Console]::Out.WriteLine($json)
  exit 1
}
