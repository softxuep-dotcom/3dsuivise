$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
$distPath = Join-Path $projectRoot "dist-poki"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$displayVersion = [string]$packageJson.version
$archivePath = Join-Path $projectRoot "last-truck-out-poki-$displayVersion.zip"
$legacyArchivePath = Join-Path $projectRoot "last-truck-out-poki.zip"

if (-not (Test-Path -LiteralPath (Join-Path $distPath "index.html"))) {
  throw "Poki build is missing: $distPath"
}

if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}
if (Test-Path -LiteralPath $legacyArchivePath) {
  Remove-Item -LiteralPath $legacyArchivePath -Force
}

Compress-Archive -Path (Join-Path $distPath "*") -DestinationPath $archivePath -CompressionLevel Optimal
Write-Host "Poki package ready: $archivePath"
