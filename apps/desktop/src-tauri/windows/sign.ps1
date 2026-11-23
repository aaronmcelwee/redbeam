# Authenticode-sign one file for `tauri build` (bundle.windows.signCommand).
#
# Tauri calls this for REDBEAM.exe, the NSIS installer and its uninstaller,
# each before the updater .sig is written, so the minisign signature covers
# the Authenticode-signed bytes.
#
# Signing goes through Microsoft Artifact Signing (formerly Trusted Signing)
# with signtool and the Azure.CodeSigning.Dlib. The release workflow sets
# REDBEAM_SIGN_DLIB and REDBEAM_SIGN_METADATA when the Azure secrets exist.
# With neither set (a local build, or a release before the account is set
# up) this prints a note and leaves the file unsigned, so builds never break
# for lack of a certificate. With only one set it fails.
#
# Windows PowerShell 5.1 compatible: it runs as `powershell -File`.

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'

$dlib = $env:REDBEAM_SIGN_DLIB
$metadata = $env:REDBEAM_SIGN_METADATA

if ([string]::IsNullOrWhiteSpace($dlib) -and [string]::IsNullOrWhiteSpace($metadata)) {
  Write-Host "Authenticode signing is not configured. Leaving $Path unsigned."
  exit 0
}
if ([string]::IsNullOrWhiteSpace($dlib) -or [string]::IsNullOrWhiteSpace($metadata)) {
  Write-Error "Set both REDBEAM_SIGN_DLIB and REDBEAM_SIGN_METADATA, or neither."
  exit 1
}
foreach ($p in @($Path, $dlib, $metadata)) {
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Error "Not found: $p"
    exit 1
  }
}

# The x64 signtool from the newest Windows 10/11 SDK. The dlib is x64 too.
$signtool = $env:REDBEAM_SIGNTOOL
if ([string]::IsNullOrWhiteSpace($signtool)) {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $found = @(Get-ChildItem -LiteralPath $kits -Filter signtool.exe -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Name -eq 'x64' } |
    Sort-Object { [version]($_.Directory.Parent.Name -replace '[^0-9.]', '') } -Descending)
  if ($found.Count -eq 0) {
    Write-Error "signtool.exe (x64) was not found under $kits. Install the Windows SDK."
    exit 1
  }
  $signtool = $found[0].FullName
}

$signArgs = @(
  'sign', '/v', '/fd', 'SHA256',
  '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256',
  '/d', 'REDBEAM',
  '/dlib', $dlib, '/dmdf', $metadata,
  $Path
)

# The signing and timestamp services occasionally drop a request. Retry a
# couple of times before failing the build.
$ok = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  & $signtool @signArgs
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Write-Host "signtool failed on attempt $attempt (exit $LASTEXITCODE)."
  if ($attempt -lt 3) { Start-Sleep -Seconds (5 * $attempt) }
}
if (-not $ok) {
  Write-Error "Could not Authenticode-sign $Path."
  exit 1
}

& $signtool verify /pa /q $Path
if ($LASTEXITCODE -ne 0) {
  Write-Error "$Path was signed but signtool verify /pa rejected it."
  exit 1
}
Write-Host "Authenticode-signed $Path"
exit 0
