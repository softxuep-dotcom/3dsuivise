$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot "dist-poki"

# 成品名称由单一脚本生成，普通打包和双击打包不会再各拼一份。
$naming = & (Join-Path $PSScriptRoot "poki-archive-path.ps1") -ProjectRoot $projectRoot
$archivePath = $naming.Path
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
Write-Host "  version=$($naming.Version)  commit=$($naming.Commit)"
