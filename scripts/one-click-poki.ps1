<#
  一键打包 Poki 上传包。

  给「打包Poki.cmd」用的。它做的事和 `npm run package:poki` 是同一件，
  区别全在**出错的时候**：双击运行没有终端上下文，报错一闪而过等于没报，
  所以这里每一步都自己判成败、自己解释、最后一定停下来等一下回车。

  比 npm 脚本多做的三件事：

    1. **先 typecheck**（build:poki 故意不带 tsc，见 package.json）。
       双击打包的人多半是要直接传上去的，让一个类型错误溜进 Poki
       比多等十秒贵得多。
    2. **打完回读一遍 ZIP**。这个包坏过一次而且坏得很隐蔽：Compress-Archive
       把路径写成反斜杠，Poki Inspector 按 URL 找不到，结果是 index.html
       能开、CSS/JS 全 404，只剩一页裸 HTML —— 上传之前肉眼完全看不出来。
       package-poki.ps1 已经修了根因，这里再验一次成品。
    3. **在资源管理器里把 ZIP 选中**，省得再去翻目录。
#>

$ErrorActionPreference = "Stop"
# 双击起来的控制台默认是 GBK，中文会变成乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Step([string]$text) { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Ok([string]$text)   { Write-Host "   $text" -ForegroundColor Green }
function Die([string]$text) {
  Write-Host "`n×  $text`n" -ForegroundColor Red
  Write-Host "   包没有生成。上面最后几行是原因。" -ForegroundColor Yellow
  exit 1
}

try {
  $version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 |
    ConvertFrom-Json).version
  Write-Host "`n=== 打包 Last Truck Out $version（Poki）===" -ForegroundColor White

  # --- 0. 环境 ---
  Step "检查 Node"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "找不到 node。先装 Node.js：https://nodejs.org/"
  }
  Ok "node $(node --version)"

  if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
    Step "第一次运行，装依赖（几分钟）"
    & npm install
    if ($LASTEXITCODE -ne 0) { Die "npm install 失败。" }
  }

  # --- 1. 类型检查 ---
  # build:poki 不带 tsc，所以这一关必须自己过一遍，见文件头那段。
  Step "类型检查"
  & npm run --silent typecheck
  if ($LASTEXITCODE -ne 0) { Die "类型检查没过 —— 先修上面报的错，别把它传上去。" }
  Ok "通过"

  # --- 2. 构建 ---
  Step "构建 Poki 版（dist-poki/）"
  & npm run --silent build:poki
  if ($LASTEXITCODE -ne 0) { Die "构建失败。" }
  $indexPath = Join-Path $root "dist-poki\index.html"
  if (-not (Test-Path -LiteralPath $indexPath)) { Die "构建跑完了但没有 dist-poki/index.html。" }
  Ok "完成"

  # --- 3. 压包 ---
  Step "压成上传包"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "package-poki.ps1")
  if ($LASTEXITCODE -ne 0) { Die "压包失败。" }

  # 与 package-poki.ps1 共用同一套“版本号 + Git 短哈希”命名。
  $zipPath = (& (Join-Path $PSScriptRoot "poki-archive-path.ps1") -ProjectRoot $root).Path
  if (-not (Test-Path -LiteralPath $zipPath)) { Die "压包脚本跑完了但没找到 $zipPath。" }

  # --- 4. 回读验收 ---
  # 见文件头第 2 条：这个包坏过，而且坏了看不出来。
  Step "验收"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $names = $zip.Entries | ForEach-Object { $_.FullName }
    if ($names -notcontains "index.html") {
      Die "ZIP 根目录下没有 index.html —— Poki 打不开这个包。"
    }
    # Poki 按 URL 路径（正斜杠）在包里找资源，反斜杠的 entry 一个都匹配不上。
    $backslash = @($names | Where-Object { $_ -like "*\*" })
    if ($backslash.Count -gt 0) {
      Die "有 $($backslash.Count) 个文件用了反斜杠路径（例：$($backslash[0])）。传上去会是一页没有样式的裸 HTML。"
    }
    $sizeMB = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
    Ok "$($names.Count) 个文件，$sizeMB MB，index.html 在根目录，路径全是正斜杠"
  }
  finally { $zip.Dispose() }

  Write-Host "`n✓ 可以上传了：" -ForegroundColor Green
  Write-Host "  $zipPath`n" -ForegroundColor White
  Write-Host "  传到 → Poki for developers → Last Truck Out → Versions → Upload" -ForegroundColor DarkGray

  # 顺手在资源管理器里选中它。失败也无所谓，包已经在那儿了。
  try { Start-Process explorer.exe -ArgumentList "/select,`"$zipPath`"" } catch { }
}
catch {
  Write-Host "`n×  出错了：$($_.Exception.Message)`n" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  exit 1
}
