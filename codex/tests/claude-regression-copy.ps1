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
        [Parameter(Mandatory = $true)][hashtable]$After
    )

    foreach ($relativePath in $protectedPaths) {
        if (-not $After.ContainsKey($relativePath) -or $Before[$relativePath] -ne $After[$relativePath]) {
            throw "ACTIVE_TREE_CHANGED: $relativePath"
        }
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
    Get-Item -LiteralPath $copiedRegression -Force -ErrorAction Stop | Out-Null

    Push-Location -LiteralPath $stageRoot
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $copiedRegression
        $regressionExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
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
