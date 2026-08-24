<#
  上传包叫什么名字，**只在这里算一次**。

  2026-08-24 的教训：f5d7461 把 git 短哈希缀进包名，改的是 package-poki.ps1，
  而 one-click-poki.ps1 里还留着自己拼的那份 "last-truck-out-poki-$version.zip"。
  于是双击打包会在最后一步报「压包脚本跑完了但没找到 …」—— 包其实早就好了，
  但第 4 步的回读验收整段没跑到，而那一步正是当初为了防「上传上去只剩一页
  裸 HTML」才加的。**两处来源，改一处忘一处，没有任何东西会报错。**

  返回一个对象而不是一个字符串：调用方除了路径，还要打印版号和 commit，
  让它们各自再算一遍就等于把同一个洞再挖一次。
#>

param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = "Stop"

$packageJson = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw -Encoding UTF8 |
  ConvertFrom-Json
$displayVersion = [string]$packageJson.version

# 版号后面缀上 git 短哈希。
#
# 2026-08-23 的教训：1.0.30 那个版号一直没升，于是 8 个内容不同的提交打出来的
# zip 全叫 last-truck-out-poki-1.0.30.zip。Poki 的 Fit Test 历史表只认文件名，
# 结果同一行「1.0.30」在不同日子指着完全不同的代码 —— 那一周的 A/B 全部作废，
# 连人带 agent 各判错一次。哈希是从代码本身长出来的，忘记升版号也不会重名。
$gitHash = (& git -C $ProjectRoot rev-parse --short HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitHash)) { $gitHash = "nogit" }
$gitDirty = (& git -C $ProjectRoot status --porcelain 2>$null)
if (-not [string]::IsNullOrWhiteSpace($gitDirty)) { $gitHash = "$gitHash-dirty" }
$gitHash = $gitHash.Trim()

[pscustomobject]@{
  Path    = Join-Path $ProjectRoot "last-truck-out-poki-$displayVersion-$gitHash.zip"
  Version = $displayVersion
  Commit  = $gitHash
}
