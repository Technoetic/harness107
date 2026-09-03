param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$protectedPaths = @(
    "hooks/auto-approve.ps1",
    "hooks/destructive-guard.ps1",
    "hooks/hooks.json",
    "hooks/html-bundler.ps1",
    "hooks/lsp-autofix.ps1",
    "hooks/mx-tag-validator.ps1",
    "hooks/permission-request-guard.ps1",
    "hooks/spec-generator.ps1",
    "hooks/step-auto-continue.ps1",
    "hooks/step-obedience-guard.ps1",
    "hooks/step-progress-loader.ps1",
    "hooks/step-progress-writer.ps1",
    "hooks/trust5-validator.ps1",
    "hooks/validate-tools.ps1",
    "hooks/webapp-trigger.ps1",
    "tests/security-regression.ps1"
)

function Resolve-ExistingDirectory {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        throw "NOT_A_DIRECTORY: $LiteralPath"
    }

    $resolved = (Resolve-Path -LiteralPath $item.FullName -ErrorAction Stop).ProviderPath
    return [System.IO.Path]::GetFullPath($resolved)
}

function Assert-StrictTempChild {
    param(
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $separators = [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $childFull = [System.IO.Path]::GetFullPath($Child)
    $parentFull = [System.IO.Path]::GetFullPath($Parent)
    $prefix = $parentFull.TrimEnd($separators) + [System.IO.Path]::DirectorySeparatorChar

    if ([string]::Equals($childFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "UNSAFE_TEMP_PATH: '$childFull' is not a strict child of '$parentFull'"
    }
}

function Join-RepositoryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $result = $Root
    foreach ($segment in $RelativePath.Split('/')) {
        $result = Join-Path -Path $result -ChildPath $segment
    }
    return $result
}

function Resolve-StrictChildDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        throw "NOT_A_DIRECTORY: $LiteralPath"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "UNSAFE_EXECUTION_REPARSE_POINT: $LiteralPath"
    }

    $expected = [System.IO.Path]::GetFullPath($item.FullName)
    $resolved = Resolve-ExistingDirectory -LiteralPath $item.FullName
    Assert-StrictTempChild -Child $resolved -Parent $Parent
    if (-not [string]::Equals($expected, $resolved, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "EXECUTION_PATH_CHANGED: '$expected' resolved as '$resolved'"
    }
    return $resolved
}

function Get-ProtectedHashes {
    param([Parameter(Mandatory = $true)][string]$Root)

    $hashes = @{}
    foreach ($relativePath in $protectedPaths) {
        $path = Join-RepositoryPath -Root $Root -RelativePath $relativePath
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer) {
            throw "PROTECTED_PATH_NOT_FILE: $relativePath"
        }
        $hashes[$relativePath] = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $hashes
}

function Assert-ProtectedHashesUnchanged {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Before,
        [Parameter(Mandatory = $true)][hashtable]$After,
        [Parameter(Mandatory = $false)][string]$ErrorCode = "ACTIVE_TREE_CHANGED"
    )

    foreach ($relativePath in $protectedPaths) {
        if (-not $After.ContainsKey($relativePath) -or $Before[$relativePath] -ne $After[$relativePath]) {
            throw "${ErrorCode}: $relativePath"
        }
    }
}

function Write-Utf8BomExecutionCopy {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $sourceFull = [System.IO.Path]::GetFullPath($SourcePath)
    $destinationFull = [System.IO.Path]::GetFullPath($DestinationPath)
    if ([string]::Equals($sourceFull, $destinationFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "EXECUTION_COPY_MUST_BE_DISTINCT: $sourceFull"
    }

    $sourceItem = Get-Item -LiteralPath $sourceFull -Force -ErrorAction Stop
    if ($sourceItem.PSIsContainer -or
        ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "UNSAFE_EXECUTION_SOURCE: $sourceFull"
    }

    [byte[]]$sourceBytes = [System.IO.File]::ReadAllBytes($sourceItem.FullName)
    $hasUtf8Bom = $sourceBytes.Length -ge 3 -and
        $sourceBytes[0] -eq 0xEF -and
        $sourceBytes[1] -eq 0xBB -and
        $sourceBytes[2] -eq 0xBF
    if ($hasUtf8Bom) {
        [byte[]]$executionBytes = $sourceBytes.Clone()
    } else {
        [byte[]]$executionBytes = New-Object byte[] ($sourceBytes.Length + 3)
        $executionBytes[0] = 0xEF
        $executionBytes[1] = 0xBB
        $executionBytes[2] = 0xBF
        [System.Array]::Copy($sourceBytes, 0, $executionBytes, 3, $sourceBytes.Length)
    }

    [System.IO.File]::WriteAllBytes($destinationFull, $executionBytes)
    $destinationItem = Get-Item -LiteralPath $destinationFull -Force -ErrorAction Stop
    if ($destinationItem.PSIsContainer -or
        ($destinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "UNSAFE_EXECUTION_COPY: $destinationFull"
    }
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$To,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RelativeDirectory
    )

    foreach ($item in @(Get-ChildItem -LiteralPath $From -Force -ErrorAction Stop)) {
        if ($item.Name -in @(".git", "step_archive", "node_modules")) {
            continue
        }

        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "COPY_REPARSE_POINT_UNSUPPORTED: $($item.FullName)"
        }

        $isHookRuntimeFile = [string]::Equals(
            $RelativeDirectory,
            "hooks",
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and (
            $item.Name -like "*.log" -or
            $item.Name -like "*.state" -or
            $item.Name -like "*.beacon" -or
            $item.Name -like "*.tmp" -or
            $item.Name -like "*.tmp.*"
        )
        if ($isHookRuntimeFile) {
            continue
        }

        $destination = Join-Path -Path $To -ChildPath $item.Name
        $childRelative = if ([string]::IsNullOrEmpty($RelativeDirectory)) {
            $item.Name
        } else {
            "$RelativeDirectory/$($item.Name)"
        }

        if ($item.PSIsContainer) {
            [System.IO.Directory]::CreateDirectory($destination) | Out-Null
            Copy-DirectoryContents -From $item.FullName -To $destination -RelativeDirectory $childRelative
        } else {
            Copy-Item -LiteralPath $item.FullName -Destination $destination -Force -ErrorAction Stop
        }
    }
}

$source = Resolve-ExistingDirectory -LiteralPath $SourceRoot
$systemTemp = Resolve-ExistingDirectory -LiteralPath ([System.IO.Path]::GetTempPath())
$beforeHashes = Get-ProtectedHashes -Root $source
$stageRoot = $null
$failures = New-Object System.Collections.Generic.List[string]

try {
    $stageCandidate = Join-Path -Path $systemTemp -ChildPath ("harness50-claude-regression-" + [guid]::NewGuid().ToString("N"))
    [System.IO.Directory]::CreateDirectory($stageCandidate) | Out-Null
    $stageRoot = Resolve-ExistingDirectory -LiteralPath $stageCandidate
    Assert-StrictTempChild -Child $stageRoot -Parent $systemTemp

    Copy-DirectoryContents -From $source -To $stageRoot -RelativeDirectory ""

    $copiedRegression = Join-RepositoryPath -Root $stageRoot -RelativePath "tests/security-regression.ps1"
    $copiedRegressionItem = Get-Item -LiteralPath $copiedRegression -Force -ErrorAction Stop
    $copiedTestsDirectory = Resolve-ExistingDirectory -LiteralPath $copiedRegressionItem.DirectoryName
    Assert-StrictTempChild -Child $copiedTestsDirectory -Parent $stageRoot

    $stagedHashes = Get-ProtectedHashes -Root $stageRoot
    Assert-ProtectedHashesUnchanged -Before $beforeHashes -After $stagedHashes -ErrorCode "STAGED_COPY_CHANGED"

    $executionCandidate = Join-Path -Path $stageRoot -ChildPath (
        ".harness50-execution-" + [guid]::NewGuid().ToString("N")
    )
    [System.IO.Directory]::CreateDirectory($executionCandidate) | Out-Null
    $executionRoot = Resolve-StrictChildDirectory -LiteralPath $executionCandidate -Parent $stageRoot

    foreach ($relativePath in $protectedPaths) {
        if (-not $relativePath.EndsWith(".ps1", [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        $executionSource = Join-RepositoryPath -Root $stageRoot -RelativePath $relativePath
        $executionDestinationCandidate = Join-RepositoryPath -Root $executionRoot -RelativePath $relativePath
        $executionDirectoryCandidate = [System.IO.Path]::GetDirectoryName($executionDestinationCandidate)
        [System.IO.Directory]::CreateDirectory($executionDirectoryCandidate) | Out-Null
        $executionDirectory = Resolve-StrictChildDirectory -LiteralPath $executionDirectoryCandidate -Parent $executionRoot
        $executionDestination = Join-Path -Path $executionDirectory -ChildPath (
            [System.IO.Path]::GetFileName($executionDestinationCandidate)
        )
        Assert-StrictTempChild -Child $executionDestination -Parent $executionRoot
        if (Test-Path -LiteralPath $executionDestination) {
            throw "EXECUTION_COPY_COLLISION: $relativePath"
        }
        Write-Utf8BomExecutionCopy -SourcePath $executionSource -DestinationPath $executionDestination
    }

    $executionRegression = Join-RepositoryPath -Root $executionRoot -RelativePath "tests/security-regression.ps1"
    Get-Item -LiteralPath $executionRegression -Force -ErrorAction Stop | Out-Null

    try {
        Push-Location -LiteralPath $executionRoot
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $executionRegression
            $regressionExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    } finally {
        $stagedHashesAfterRun = Get-ProtectedHashes -Root $stageRoot
        Assert-ProtectedHashesUnchanged -Before $beforeHashes -After $stagedHashesAfterRun -ErrorCode "STAGED_COPY_CHANGED"
    }

    if ($regressionExitCode -ne 0) {
        throw "CLAUDE_REGRESSION_FAILED: exit code $regressionExitCode"
    }
} catch {
    [void]$failures.Add($_.Exception.Message)
} finally {
    try {
        $afterHashes = Get-ProtectedHashes -Root $source
        Assert-ProtectedHashesUnchanged -Before $beforeHashes -After $afterHashes
    } catch {
        [void]$failures.Add($_.Exception.Message)
    }

    if ($null -ne $stageRoot -and (Test-Path -LiteralPath $stageRoot)) {
        try {
            $cleanupItem = Get-Item -LiteralPath $stageRoot -Force -ErrorAction Stop
            if (($cleanupItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "UNSAFE_TEMP_REPARSE_POINT: $stageRoot"
            }

            $cleanupRoot = Resolve-ExistingDirectory -LiteralPath $stageRoot
            Assert-StrictTempChild -Child $cleanupRoot -Parent $systemTemp
            if (-not [string]::Equals($cleanupRoot, $stageRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "TEMP_PATH_CHANGED: '$stageRoot' resolved as '$cleanupRoot'"
            }

            Remove-Item -LiteralPath $cleanupRoot -Recurse -Force -ErrorAction Stop
        } catch {
            [void]$failures.Add($_.Exception.Message)
        }
    }
}

if ($failures.Count -gt 0) {
    throw ($failures -join [System.Environment]::NewLine)
}

Write-Output "CLAUDE_REGRESSION_COPY_OK"
