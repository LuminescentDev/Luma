[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $TauriArguments
)

$ErrorActionPreference = "Stop"

function Test-Java21 {
    param([Parameter(Mandatory = $true)][string] $JavaHome)

    $java = Join-Path $JavaHome "bin\java.exe"
    if (-not (Test-Path -LiteralPath $java -PathType Leaf)) {
        return $false
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $versionOutput = & $java -version 2>&1 | Out-String
    $ErrorActionPreference = $previousErrorActionPreference
    return $versionOutput -match 'version "21(?:\.|\")'
}

$candidates = @(
    $env:JAVA_HOME,
    "C:\Program Files\Android\Android Studio\jbr",
    "C:\Program Files\Eclipse Adoptium\jdk-21*",
    "C:\Program Files\Java\jdk-21*",
    "C:\Program Files\Microsoft\jdk-21*"
)

$java21Home = $null
foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        continue
    }

    foreach ($directory in @(Get-Item -Path $candidate -ErrorAction SilentlyContinue)) {
        if (Test-Java21 -JavaHome $directory.FullName) {
            $java21Home = $directory.FullName
            break
        }
    }

    if ($java21Home) {
        break
    }
}

if (-not $java21Home) {
    throw "Java 21 was not found. Install Android Studio or JDK 21, then try again."
}

# These changes apply only to this script and the processes it starts.
$env:JAVA_HOME = $java21Home
$env:Path = "$(Join-Path $java21Home 'bin');$env:Path"

Write-Host "Using Java 21 from $java21Home"
if ($TauriArguments.Count -gt 0 -and $TauriArguments[0] -eq "--") {
    $TauriArguments = @($TauriArguments | Select-Object -Skip 1)
}
& pnpm tauri android dev @TauriArguments
exit $LASTEXITCODE
