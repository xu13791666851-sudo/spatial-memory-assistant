[CmdletBinding()]
param(
    [string]$ToolchainRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex/android-tools'),
    [string]$JavaHomePath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_HOME,
    [string]$ArtifactDirectory,
    [switch]$Offline,
    [switch]$IncludeDeviceTestPackage,
    [switch]$IsolatedTabletTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ArtifactDirectory) { $ArtifactDirectory = Join-Path $projectRoot 'output/android-local' }
$ArtifactDirectory = [IO.Path]::GetFullPath($ArtifactDirectory)

if (-not $JavaHomePath) {
    $jdk = Get-ChildItem -LiteralPath (Join-Path $ToolchainRoot 'jdk') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '17' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'bin/java.exe')) } |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($jdk) { $JavaHomePath = $jdk.FullName }
}
if (-not $SdkPath) {
    foreach ($candidate in @((Join-Path $ToolchainRoot 'sdk'), (Join-Path $env:LOCALAPPDATA 'Android/Sdk'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'platform-tools/adb.exe')) { $SdkPath = $candidate; break }
    }
}
if (-not $JavaHomePath -or -not (Test-Path -LiteralPath (Join-Path $JavaHomePath 'bin/java.exe'))) {
    throw 'JDK 17 is required. Pass -JavaHomePath with its installation directory.'
}
if (-not $SdkPath -or -not (Test-Path -LiteralPath (Join-Path $SdkPath 'platforms/android-36/android.jar'))) {
    throw 'Android SDK 36 is required. Pass -SdkPath with its installation directory.'
}
$nodeCommand = Get-Command node -ErrorAction Stop
$wrapperSettings = Get-Content -LiteralPath (Join-Path $projectRoot 'android/gradle/wrapper/gradle-wrapper.properties') -Raw
$versionMatch = [regex]::Match($wrapperSettings, 'gradle-([0-9.]+)-all\.zip')
if (-not $versionMatch.Success) { throw 'Cannot determine the pinned Gradle version.' }
$gradleVersion = $versionMatch.Groups[1].Value
$localGradle = Join-Path $ToolchainRoot "gradle-$gradleVersion/bin/gradle.bat"
$localLauncher = Join-Path $ToolchainRoot "gradle-$gradleVersion/lib/gradle-launcher-$gradleVersion.jar"
$gradleCommand = Join-Path $projectRoot 'android/gradlew.bat'
if ((Test-Path -LiteralPath $localGradle) -and (Test-Path -LiteralPath $localLauncher)) { $gradleCommand = $localGradle }

$previousEnvironment = @{}
foreach ($name in @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
$buildLog = Join-Path $ArtifactDirectory 'build.log'

try {
    $env:JAVA_HOME = $JavaHomePath
    $env:ANDROID_HOME = $SdkPath
    $env:ANDROID_SDK_ROOT = $SdkPath
    if (-not $env:GRADLE_USER_HOME -and (Test-Path -LiteralPath (Join-Path $ToolchainRoot 'gradle'))) {
        $env:GRADLE_USER_HOME = Join-Path $ToolchainRoot 'gradle'
    }
    Push-Location -LiteralPath $projectRoot
    try {
        & $nodeCommand.Source 'scripts/build-android-assets.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'Android model preparation failed.' }
    } finally { Pop-Location }

    $arguments = @('testDebugUnitTest', 'lintDebug', 'assembleDebug')
    if ($IncludeDeviceTestPackage) { $arguments += 'assembleDebugAndroidTest' }
    if ($IsolatedTabletTest) { $arguments += '-PisolatedTabletTest=true' }
    $arguments += @('--no-daemon', '--max-workers=2', '-Dorg.gradle.jvmargs=-Xmx2048m', '-Pkotlin.compiler.execution.strategy=in-process', '--console=plain')
    if ($Offline) { $arguments += '--offline' }
    Write-Host "Building with JDK at $JavaHomePath; Android SDK at $SdkPath; Gradle $gradleVersion."
    Push-Location -LiteralPath (Join-Path $projectRoot 'android')
    try {
        & $gradleCommand @arguments 2>&1 | Tee-Object -FilePath $buildLog
        $buildExitCode = $LASTEXITCODE
    } finally { Pop-Location }
    if ($buildExitCode -ne 0) { throw "Android build or checks failed. See $buildLog" }

    $apkDirectory = Join-Path $projectRoot 'android/app/build/outputs/apk/debug'
    $metadata = Get-Content -LiteralPath (Join-Path $apkDirectory 'output-metadata.json') -Raw | ConvertFrom-Json
    $element = @($metadata.elements)[0]
    $apk = Join-Path $apkDirectory $element.outputFile
    $apkPrefix = if ($IsolatedTabletTest) { 'I-SEE-YOU-tablet-test' } else { 'I-SEE-YOU' }
    $publishedApk = Join-Path $ArtifactDirectory "$apkPrefix-$($element.versionName).apk"
    Copy-Item -LiteralPath $apk -Destination $publishedApk -Force
    $signer = Join-Path $SdkPath 'build-tools/36.0.0/apksigner.bat'
    & $signer verify --verbose --print-certs $publishedApk 2>&1 |
        Tee-Object -FilePath (Join-Path $ArtifactDirectory 'apk-signature.log')
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }

    $testReports = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'android/app/build/test-results/testDebugUnitTest') -Filter 'TEST-*.xml')
    $testCount = 0; $failures = 0; $errors = 0
    foreach ($report in $testReports) {
        [xml]$xml = Get-Content -LiteralPath $report.FullName -Raw
        $testCount += [int]$xml.testsuite.tests
        $failures += [int]$xml.testsuite.failures
        $errors += [int]$xml.testsuite.errors
    }
    if ($testCount -eq 0 -or $failures -gt 0 -or $errors -gt 0) { throw 'Unit-test results are missing or contain failures.' }
    $summary = [ordered]@{
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        applicationId = $metadata.applicationId
        versionName = $element.versionName
        versionCode = $element.versionCode
        apk = $publishedApk
        sha256 = (Get-FileHash -LiteralPath $publishedApk -Algorithm SHA256).Hash.ToLowerInvariant()
        unitTests = @{ tests = $testCount; failures = $failures; errors = $errors }
        lint = 'passed'
        signature = 'verified'
        deviceTests = 'not run by this build script'
    }
    $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ArtifactDirectory 'build-summary.json') -Encoding utf8
    Write-Host "Ready: $publishedApk"
} finally {
    foreach ($entry in $previousEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
}
