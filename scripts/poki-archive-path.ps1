<#
  Poki 上传包的文件名只在这里生成。
  返回路径、版本号和 commit，供普通打包与一键打包共同使用。
#>

param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = "Stop"

$packageJson = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw -Encoding UTF8 |
  ConvertFrom-Json
$displayVersion = [string]$packageJson.version

# 同一个版本号可能对应多个候选包；短哈希让上传记录能准确对应代码。
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
