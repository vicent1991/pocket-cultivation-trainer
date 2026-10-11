# 口袋修仙 Demo 外部修改器 —— 绿色版打包脚本
#
# 用法（在仓库根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\build-package.ps1
#
# 产出：
#   dist\口袋修仙修改器-绿色版\        绿色版文件夹（可直接拷到别的机器运行）
#   dist\口袋修仙修改器-绿色版.zip     上述文件夹的压缩包
#
# 说明：本脚本只读仓库内的修改器代码 / 文档 / 道具表，并把 Node 运行时一并打进包内；
#       目标机器无需安装 Node 或任何依赖，双击「启动修改器.cmd」即可运行。
#       node.exe 默认取 PATH 里的 node，可用 -NodeExe 或环境变量 POCKET_TRAINER_BUILD_NODE 覆盖。

param(
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$Root       = $PSScriptRoot
$PkgName    = '口袋修仙修改器-绿色版'
$DistDir    = Join-Path $Root 'dist'
$PkgDir     = Join-Path $DistDir $PkgName
$ZipPath    = Join-Path $DistDir ($PkgName + '.zip')
$TrainerSrc = Join-Path $Root 'trainer'

# 可选的本机覆盖：若存在 local-settings.ps1（不进版本库）则加载，
# 可在其中设置 $env:POCKET_TRAINER_BUILD_NODE / $env:POCKET_TRAINER_NODE 等本机专用路径。
$LocalSettings = Join-Path $Root 'local-settings.ps1'
if (Test-Path -LiteralPath $LocalSettings -PathType Leaf) { . $LocalSettings }

if (-not $NodeExe) { $NodeExe = $env:POCKET_TRAINER_BUILD_NODE }

function Info($m) { Write-Host "[打包] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[打包] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[打包] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[打包] $m" -ForegroundColor Red; exit 1 }

# 未显式指定时，从 PATH 取 node（不硬编码任何本机路径）。
if (-not $NodeExe) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd -and $nodeCmd.Source) { $NodeExe = $nodeCmd.Source }
}

function Fmt-Size([double]$b) {
  if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
  if ($b -ge 1MB) { return ('{0:N2} MB' -f ($b / 1MB)) }
  if ($b -ge 1KB) { return ('{0:N1} KB' -f ($b / 1KB)) }
  return ('{0} B' -f [int]$b)
}

function Dir-Size([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
          Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return [double]$sum
}

# 复制并记录，供最后汇总。
$copied = New-Object System.Collections.ArrayList
function Copy-One([string]$Src, [string]$DstRel) {
  if (-not (Test-Path -LiteralPath $Src -PathType Leaf)) { Fail "缺少源文件：$Src" }
  $dst = Join-Path $PkgDir $DstRel
  $parent = Split-Path -Parent $dst
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $Src -Destination $dst -Force
  [void]$copied.Add([pscustomobject]@{ Rel = $DstRel; Size = [double](Get-Item -LiteralPath $dst).Length })
}

function Write-Text([string]$DstRel, [string]$Text, [switch]$Bom) {
  $dst = Join-Path $PkgDir $DstRel
  $parent = Split-Path -Parent $dst
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $enc = if ($Bom) { New-Object System.Text.UTF8Encoding($true) } else { New-Object System.Text.UTF8Encoding($false) }
  [System.IO.File]::WriteAllText($dst, $Text, $enc)
  [void]$copied.Add([pscustomobject]@{ Rel = $DstRel; Size = [double](Get-Item -LiteralPath $dst).Length })
}

Write-Host ''
Write-Host '=== 打包：口袋修仙修改器（绿色版） ===' -ForegroundColor Green
Write-Host ''

# 0. 前置检查
if (-not (Test-Path -LiteralPath (Join-Path $TrainerSrc 'cli.mjs') -PathType Leaf)) { Fail "找不到修改器代码：$TrainerSrc\cli.mjs" }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { Fail "找不到 node.exe：$NodeExe（可用 -NodeExe / 环境变量 POCKET_TRAINER_BUILD_NODE 指定，或把 node 放进 PATH）" }
$nodeVerOut = & $NodeExe --version 2>$null
if ($LASTEXITCODE -ne 0 -or -not $nodeVerOut) { Fail "无法运行 node：$NodeExe" }
$nodeVer = ([string]($nodeVerOut | Select-Object -First 1)).Trim()
Info "使用 node：$NodeExe（$nodeVer）"

# 1. 清理并重建输出目录
if (Test-Path -LiteralPath $PkgDir) { Info "清理旧目录：$PkgDir"; Remove-Item -LiteralPath $PkgDir -Recurse -Force }
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null
Info "输出目录：$PkgDir"

# 2. 根目录文件（启动器 / 脚本 / 说明）
Copy-One (Join-Path $Root '启动修改器.cmd') '启动修改器.cmd'

# start-trainer.ps1：仓库原件已不含任何本机路径，直接入包即可（原文件自带 UTF-8 with BOM）。
Copy-One (Join-Path $Root 'start-trainer.ps1') 'start-trainer.ps1'

Copy-One (Join-Path $Root '使用说明.md') '使用说明.md'

# 3. Node 运行时（node.exe + 许可证）
Copy-One $NodeExe 'runtime\node\node.exe'
$licCandidates = @(
  (Join-Path (Split-Path -Parent $NodeExe) 'LICENSE'),
  (Join-Path (Split-Path -Parent (Split-Path -Parent $NodeExe)) 'LICENSE')
)
$licSrc = $licCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if ($licSrc) {
  Copy-One $licSrc 'runtime\node\LICENSE.txt'
} else {
  Warn '未找到 Node LICENSE 文件，写入简短归属说明。'
  $licText = @"
Node.js $nodeVer

本目录下的 node.exe 为 Node.js 运行时，采用 MIT 许可证。
来源：https://nodejs.org/
Copyright Node.js contributors. All rights reserved.
"@
  Write-Text 'runtime\node\LICENSE.txt' ($licText -replace "`n", "`r`n")
}

# 4. trainer\*.mjs（只复制 .mjs，不带其他文件）
$mjs = @(Get-ChildItem -LiteralPath $TrainerSrc -File -Filter '*.mjs' | Sort-Object Name)
if ($mjs.Count -eq 0) { Fail "trainer 目录下没有 .mjs：$TrainerSrc" }
foreach ($f in $mjs) { Copy-One $f.FullName (Join-Path 'trainer' $f.Name) }

# 5. trainer\backups\（空目录，供修改器写备份）
$backupDst = Join-Path $PkgDir 'trainer\backups'
New-Item -ItemType Directory -Force -Path $backupDst | Out-Null

# 6. 道具表
Copy-One (Join-Path $Root 'gamedata\items.csv') 'gamedata\items.csv'

# 7. 绿色版说明.txt（纯文本，无 BOM）
$readmeTxt = @"
口袋修仙修改器 · 绿色版
========================================

【这是什么】
  给 Steam 游戏《口袋修仙 Demo》用的外部修改器，可以给角色发放道具。
  界面是本机浏览器里的一个网页，只监听 127.0.0.1，不联网。

【免安装】
  本包已内置 Node 运行时（runtime\node\node.exe），目标机器无需安装 Node，
  也无需安装任何其他依赖（修改器零第三方依赖，只用 Node 内建模块）。

【怎么运行】
  1. 确认游戏已通过 Steam 安装，且是同一个 Demo 版本。
  2. 双击本目录下的「启动修改器.cmd」。
     它会自动：用调试端口启动游戏 -> 启动修改器界面 -> 打开浏览器。
  3. 在网页里搜索道具、加入清单、预览、确认发放。

【备份】
  每次发放前会自动把存档备份到 trainer\backups\（文件名带时间戳）。
  需要还原时，把对应备份文件复制回存档目录即可。

【卸载】
  直接删除本文件夹即可。不写注册表、不装服务、不留残留。

【注意】
  仅供单机自娱使用。
"@
Write-Text '绿色版说明.txt' ($readmeTxt -replace "`n", "`r`n")

# 8. 汇总复制清单
Write-Host ''
Ok '已复制到绿色版：'
foreach ($c in ($copied | Sort-Object Rel)) {
  Write-Host ("  · {0,-28} {1,10}" -f $c.Rel, (Fmt-Size $c.Size))
}
Write-Host ("  · trainer\backups\             （空目录）")
Write-Host ''
Info "trainer 代码：$($mjs.Count) 个 .mjs"

# 9. 压缩为 zip
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
Info '正在压缩为 zip ...'
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $PkgDir,
  $ZipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $true
)

# 10. 最终汇总
$pkgBytes = Dir-Size $PkgDir
$zipBytes = [double](Get-Item -LiteralPath $ZipPath).Length
$fileCount = @(Get-ChildItem -LiteralPath $PkgDir -Recurse -Force -File).Count

Write-Host ''
Write-Host '=== 打包完成 ===' -ForegroundColor Green
Write-Host ''
Write-Host ("绿色版文件夹 : {0}" -f $PkgDir)
Write-Host ("  文件数     : {0}" -f $fileCount)
Write-Host ("  总大小     : {0}" -f (Fmt-Size $pkgBytes))
Write-Host ("压缩包       : {0}" -f $ZipPath)
Write-Host ("  大小       : {0}" -f (Fmt-Size $zipBytes))
Write-Host ''
Ok '目标机器无需安装任何东西，双击「启动修改器.cmd」即可运行。'
