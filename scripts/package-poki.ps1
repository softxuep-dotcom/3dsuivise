$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
$distPath = Join-Path $projectRoot "dist-poki"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$displayVersion = [string]$packageJson.version

# 版号后面缀上 git 短哈希。
#
# 2026-08-23 的教训：1.0.30 那个版号一直没升，于是 8 个内容不同的提交打出来的
# zip 全叫 last-truck-out-poki-1.0.30.zip。Poki 的 Fit Test 历史表只认文件名，
# 结果同一行「1.0.30」在不同日子指着完全不同的代码 —— 那一周的 A/B 全部作废，
# 连人带 agent 各判错一次。哈希是从代码本身长出来的，忘记升版号也不会重名。
$gitHash = (& git -C $projectRoot rev-parse --short HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitHash)) { $gitHash = "nogit" }
$gitDirty = (& git -C $projectRoot status --porcelain 2>$null)
if (-not [string]::IsNullOrWhiteSpace($gitDirty)) { $gitHash = "$gitHash-dirty" }
$stamp = "$displayVersion-$($gitHash.Trim())"
$archivePath = Join-Path $projectRoot "last-truck-out-poki-$stamp.zip"
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

# Compress-Archive 在 Windows 上会把目录分隔符原样写成反斜杠，例如
# assets\index.css。Poki Inspector 按 URL 路径 assets/index.css 查找时不会命中，
# 结果就是 index.html 能打开、CSS/JS 全部 404，只剩一页裸 HTML。
# 这里显式创建 ZIP entry，并统一使用网页兼容的正斜杠。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open(
  $archivePath,
  [System.IO.Compression.ZipArchiveMode]::Create
)

try {
  foreach ($file in Get-ChildItem -LiteralPath $distPath -File -Recurse) {
    $entryName = $file.FullName.Substring($distPath.Length).TrimStart("\", "/").Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $file.FullName,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
}
finally {
  $archive.Dispose()
}

Write-Host "Poki package ready: $archivePath"
Write-Host "  version=$displayVersion  commit=$gitHash"
