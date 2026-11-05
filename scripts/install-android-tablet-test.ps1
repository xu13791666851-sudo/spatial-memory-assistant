[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ApkPath,
    [string]$DeviceSerial,
    [string]$SdkPath = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex/android-tools/sdk'),
    [switch]$UpdateOwnedTestApp,
    [string]$ExpectedInstalledSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$adb = Join-Path $SdkPath 'platform-tools/adb.exe'
$aapt = Join-Path $SdkPath 'build-tools/36.0.0/aapt.exe'
$ApkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$allowedPackage = 'com.spatialmemory.assistant.iseeyou.tablettest.debug'
# SDK executables can mishandle Chinese path names. Stage a verified copy in the
# local temporary directory without changing the caller's working directory.
$stagedApk = Join-Path ([IO.Path]::GetTempPath()) ("iseeyou-" + [Guid]::NewGuid().ToString('N') + '.apk')
$installedCopy = $stagedApk + '.installed.apk'
try {
    Copy-Item -LiteralPath $ApkPath -Destination $stagedApk
    if ((Get-FileHash -LiteralPath $ApkPath).Hash -ne (Get-FileHash -LiteralPath $stagedApk).Hash) {
        throw 'The staged APK does not match the selected APK.'
    }
    $badging = & $aapt dump badging $stagedApk
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the APK identity.' }
    $packageMatch = [regex]::Match(($badging -join "`n"), "(?m)^package: name='([^']+)'")
    if (-not $packageMatch.Success -or $packageMatch.Groups[1].Value -ne $allowedPackage) {
        throw 'Only the isolated I SEE YOU tablet-test package can be installed by this script.'
    }

    $devices = @(& $adb devices)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect connected devices.' }
    $readyDevices = @($devices | ForEach-Object {
        if ($_ -match '^(\S+)\s+device$') { $Matches[1] }
    })
    if (-not $DeviceSerial) {
        $physicalDevices = @($readyDevices | Where-Object { $_ -notmatch '^emulator-' })
        if ($physicalDevices.Count -ne 1) { throw 'Connect and authorize exactly one tablet, or pass -DeviceSerial.' }
        $DeviceSerial = $physicalDevices[0]
    }
    if ($DeviceSerial -notin $readyDevices) { throw 'The selected device is not connected and authorized.' }

    $existing = @(& $adb -s $DeviceSerial shell pm path $allowedPackage 2>&1)
    $replaceOwnedApp = $false
    if (($existing -join "`n") -match 'package:') {
        if (-not $UpdateOwnedTestApp -or $ExpectedInstalledSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
            throw 'This isolated test app is already installed. No replacement, uninstall, or data clearing was performed.'
        }
        $remoteApk = @($existing | Where-Object { $_ -match '^package:.*/base\.apk$' })
        if ($remoteApk.Count -ne 1) { throw 'Cannot establish the installed test APK identity.' }
        & $adb -s $DeviceSerial pull ($remoteApk[0].Trim().Substring(8)) $installedCopy
        if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the installed test APK.' }
        if ((Get-FileHash -LiteralPath $installedCopy -Algorithm SHA256).Hash -ne $ExpectedInstalledSha256) {
            throw 'The installed APK is not the known test build. It has been left unchanged.'
        }
        $replaceOwnedApp = $true
    }
    Write-Host "Installing the isolated test app on $DeviceSerial."
    # A replacement is allowed only for the exact known APK installed by this project.
    # Android verifies the signing key. No uninstall, downgrade, data clearing, or permission grants.
    $installArguments = @('-s', $DeviceSerial, 'install')
    if ($replaceOwnedApp) { $installArguments += '-r' }
    $installArguments += $stagedApk
    & $adb @installArguments
    if ($LASTEXITCODE -ne 0) { throw 'Installation did not finish. Existing apps and files were not modified by this script.' }
    & $adb -s $DeviceSerial shell am start -W -n "$allowedPackage/com.spatialmemory.assistant.ui.PixelHomeActivity"
    if ($LASTEXITCODE -ne 0) { throw 'The test app was installed but did not open successfully.' }
    Write-Host 'Installed and opened the isolated test app. Camera and microphone permissions are requested inside the app.'
} finally {
    # Remove only the temporary APK created on this computer by this invocation.
    if (Test-Path -LiteralPath $stagedApk) { Remove-Item -LiteralPath $stagedApk }
    if (Test-Path -LiteralPath $installedCopy) { Remove-Item -LiteralPath $installedCopy }
}
