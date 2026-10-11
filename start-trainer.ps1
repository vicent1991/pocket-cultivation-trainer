# 口袋修仙 Demo 外部修改器 —— 一键启动
#
# 用法（三选一）：
#   1) 双击同目录下的「启动修改器.cmd」
#   2) 在本目录执行：powershell -NoProfile -ExecutionPolicy Bypass -File .\start-trainer.ps1
#   3) 只探测不启动：powershell -NoProfile -ExecutionPolicy Bypass -File .\start-trainer.ps1 -DetectOnly
#
# 本脚本会：① 自动探测 node（含版本校验，需 v22+）与游戏安装位置（读 Steam libraryfolders.vdf）
#          → ② 用调试端口启动游戏（已在运行则复用）→ ③ 启动本地修改器界面 → ④ 打开浏览器。

param(
  [switch]$DetectOnly
)

$ErrorActionPreference = 'Stop'
$Root         = $PSScriptRoot
$CdpPort      = 9333
$GuiPort      = 17321
$GuiUrl       = "http://127.0.0.1:$GuiPort/"
$MinNodeMajor = 22
$GameRel      = 'steamapps\common\口袋修仙 Demo\Pocket Cultivation.exe'

# 可选的本机覆盖：若存在 local-settings.ps1（不进版本库）则加载，
# 可在其中设置 $env:POCKET_TRAINER_NODE / $env:POCKET_TRAINER_GAME_EXE 等本机专用路径。
$LocalSettings = Join-Path $Root 'local-settings.ps1'
if (Test-Path -LiteralPath $LocalSettings -PathType Leaf) { . $LocalSettings }

function Info($m) { Write-Host "[修改器] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[修改器] $m" -ForegroundColor Yellow }
function Fail($m) {
  Write-Host "[修改器] $m" -ForegroundColor Red
  if (-not $DetectOnly) { Write-Host ''; Read-Host '按回车退出' }
  exit 1
}

function Test-Port([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port)
    $c.Close()
    return $true
  } catch { return $false }
}

# 运行 node --version，返回 {Version,Major}；不可用返回 $null。
function Get-NodeVersion([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { $out = & $Path --version 2>$null } catch { return $null }
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  $ver = ([string]($out | Select-Object -First 1)).Trim()
  if ($ver -notmatch '^v(\d+)\.') { return $null }
  return [pscustomobject]@{ Version = $ver; Major = [int]$Matches[1] }
}

# 按优先级探测 node：env → 内置运行时（绿色版）→ PATH → 常见安装位置。
# 取第一个可运行且主版本 >= 22 的；若只找到过低版本则报错退出。
function Resolve-Node {
  $candidates = New-Object System.Collections.ArrayList
  if ($env:POCKET_TRAINER_NODE) {
    [void]$candidates.Add([pscustomobject]@{ Source = 'env:POCKET_TRAINER_NODE'; Path = $env:POCKET_TRAINER_NODE })
  }
  # 绿色版内置运行时（仅当文件存在时参与探测；开发仓库无 runtime\ 时自动跳过，行为不变）。
  $bundledNode = Join-Path $Root 'runtime\node\node.exe'
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    [void]$candidates.Add([pscustomobject]@{ Source = '内置运行时（runtime\node\node.exe）'; Path = $bundledNode })
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    [void]$candidates.Add([pscustomobject]@{ Source = 'PATH（Get-Command node）'; Path = $cmd.Source })
  }
  if ($env:ProgramFiles)          { [void]$candidates.Add([pscustomobject]@{ Source = '常见安装位置'; Path = (Join-Path $env:ProgramFiles 'nodejs\node.exe') }) }
  if (${env:ProgramFiles(x86)})   { [void]$candidates.Add([pscustomobject]@{ Source = '常见安装位置'; Path = (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }) }
  if ($env:LOCALAPPDATA)          { [void]$candidates.Add([pscustomobject]@{ Source = '常见安装位置'; Path = (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }) }
  if ($env:APPDATA)               { [void]$candidates.Add([pscustomobject]@{ Source = '常见安装位置'; Path = (Join-Path $env:APPDATA 'npm\node.exe') }) }

  $tried = New-Object System.Collections.ArrayList
  $tooOld = $null
  foreach ($c in $candidates) {
    if ([string]::IsNullOrWhiteSpace($c.Path)) { continue }
    [void]$tried.Add("  - [$($c.Source)] $($c.Path)")
    $v = Get-NodeVersion $c.Path
    if (-not $v) { continue }
    if ($v.Major -lt $MinNodeMajor) {
      $tooOld = [pscustomobject]@{ Path = $c.Path; Version = $v.Version; Source = $c.Source }
      continue
    }
    return [pscustomobject]@{ Path = $c.Path; Version = $v.Version; Source = $c.Source }
  }
  if ($tooOld) {
    Fail "探测到的 node 版本过低：$($tooOld.Path) → $($tooOld.Version)，本修改器需要 Node v$MinNodeMajor 或更高。请安装新版 Node，或用环境变量 POCKET_TRAINER_NODE 指定。"
  }
  Fail "没有找到可用的 node（需要 v$MinNodeMajor 或更高）。已尝试：`n$($tried -join "`n")"
}

# Steam 根目录：HKCU SteamPath → HKLM WOW6432Node InstallPath → HKLM InstallPath。
# 全部取不到时返回 Path = $null（由调用方给出可操作提示），不再回退硬编码路径。
function Get-SteamRoot {
  $tries = @(
    [pscustomobject]@{ Key = 'HKCU:\Software\Valve\Steam';                   Prop = 'SteamPath';   Source = 'HKCU:\Software\Valve\Steam\SteamPath' },
    [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam';       Prop = 'InstallPath'; Source = 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath' },
    [pscustomobject]@{ Key = 'HKLM:\SOFTWARE\Valve\Steam';                   Prop = 'InstallPath'; Source = 'HKLM:\SOFTWARE\Valve\Steam\InstallPath' }
  )
  foreach ($t in $tries) {
    try {
      $v = (Get-ItemProperty -Path $t.Key -Name $t.Prop -ErrorAction Stop).($t.Prop)
      if ($v) { return [pscustomobject]@{ Path = ($v -replace '/', '\'); Source = $t.Source } }
    } catch { }
  }
  return [pscustomobject]@{ Path = $null; Source = '未找到（注册表里没有 Steam 安装路径）' }
}

# 读 <SteamRoot>\steamapps\libraryfolders.vdf（缺失时回退 <SteamRoot>\config\...），
# 解析出所有库路径（双反斜杠转义还原）。VDF 缺失/不可读时返回空列表，不抛错。
function Read-LibraryFolders([string]$SteamRoot) {
  $res = [pscustomobject]@{ Libraries = @(); VdfPath = $null }
  $vdfs = @(
    (Join-Path $SteamRoot 'steamapps\libraryfolders.vdf'),
    (Join-Path $SteamRoot 'config\libraryfolders.vdf')
  )
  $text = $null
  foreach ($v in $vdfs) {
    if (Test-Path -LiteralPath $v -PathType Leaf) {
      try { $text = Get-Content -LiteralPath $v -Raw -ErrorAction Stop; $res.VdfPath = $v; break } catch { }
    }
  }
  if (-not $text) { return $res }

  $found = New-Object System.Collections.ArrayList
  foreach ($m in [regex]::Matches($text, '"path"\s+"([^"]*)"')) {
    [void]$found.Add(($m.Groups[1].Value -replace '\\\\', '\'))
  }
  if ($found.Count -eq 0) {
    # 旧格式：数字键 → 带盘符的引号路径
    foreach ($m in [regex]::Matches($text, '"\d+"\s+"([A-Za-z]:[^"]*)"')) {
      [void]$found.Add(($m.Groups[1].Value -replace '\\\\', '\'))
    }
  }
  $res.Libraries = @($found)
  return $res
}

Write-Host ''
Write-Host '=== 口袋修仙 Demo 外部修改器 ===' -ForegroundColor Green
Write-Host ''

# 0. 自动探测 node 与游戏安装位置
$node  = Resolve-Node
$steam = Get-SteamRoot
$lf    = if ($steam.Path) { Read-LibraryFolders $steam.Path } else { [pscustomobject]@{ Libraries = @(); VdfPath = $null } }

# 根目录大小写可能来自注册表（如 HKCU SteamPath 全小写）；若 VDF 里有同一目录的写法，采用它。
$steamRootPath = $steam.Path
foreach ($p in $lf.Libraries) { if ($p -and $steamRootPath -and ($p -ieq $steamRootPath)) { $steamRootPath = $p; break } }

$libraries = New-Object System.Collections.ArrayList
if ($steamRootPath) { [void]$libraries.Add($steamRootPath) }
foreach ($p in $lf.Libraries) { if ($p -and ($libraries -notcontains $p)) { [void]$libraries.Add($p) } }

$gameCandidates = New-Object System.Collections.ArrayList
if ($env:POCKET_TRAINER_GAME_EXE) {
  [void]$gameCandidates.Add([pscustomobject]@{ Source = 'env:POCKET_TRAINER_GAME_EXE'; Path = $env:POCKET_TRAINER_GAME_EXE })
}
foreach ($lib in $libraries) {
  [void]$gameCandidates.Add([pscustomobject]@{ Source = "Steam 库: $lib"; Path = (Join-Path $lib $GameRel) })
}

$game = $null
foreach ($c in $gameCandidates) {
  if ($c.Path -and (Test-Path -LiteralPath $c.Path -PathType Leaf)) { $game = $c; break }
}

# 找不到游戏本体时的可操作提示（不再有硬编码兜底路径）。
$GameNotFoundHint = @"
找不到游戏本体（Pocket Cultivation.exe）。
请确认游戏已通过 Steam 安装，或手动指定游戏主程序路径：
  · 环境变量：set POCKET_TRAINER_GAME_EXE=<你的游戏目录>\口袋修仙 Demo\Pocket Cultivation.exe
  · 或在 trainer 目录手动运行：node cli.mjs serve --game-exe "<你的游戏目录>\口袋修仙 Demo\Pocket Cultivation.exe"
已尝试的候选：
$((($gameCandidates | ForEach-Object { '  - ' + $_.Path }) -join "`n"))
"@

# -DetectOnly：只打印探测结果，不启动任何东西。
if ($DetectOnly) {
  Write-Host '--- 探测模式（-DetectOnly）：只打印，不启动任何东西 ---' -ForegroundColor Green
  Write-Host ''
  Write-Host 'node：'
  Write-Host "  路径 : $($node.Path)"
  Write-Host "  版本 : $($node.Version)"
  Write-Host "  来源 : $($node.Source)"
  Write-Host ''
  Write-Host 'Steam 根目录：'
  Write-Host "  路径 : $(if ($steam.Path) { $steam.Path } else { '（未找到）' })"
  Write-Host "  来源 : $($steam.Source)"
  Write-Host ''
  if ($lf.VdfPath) {
    Write-Host "libraryfolders.vdf：$($lf.VdfPath)"
    Write-Host "  解析到的库路径（$($lf.Libraries.Count) 个）："
    if ($lf.Libraries.Count -eq 0) { Write-Host '  （未解析到 path 键）' }
    foreach ($p in $lf.Libraries) { Write-Host "    · $p" }
  } else {
    Write-Host 'libraryfolders.vdf：（未找到，已跳过）' -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host '候选 Steam 库（含根目录）与游戏本体：'
  $idx = 0
  foreach ($lib in $libraries) {
    $idx++
    $exe = Join-Path $lib $GameRel
    $mark = '无'
    if (Test-Path -LiteralPath $exe -PathType Leaf) { $mark = '存在' }
    Write-Host ("  [{0}] {1}" -f $idx, $lib)
    Write-Host ("        {0}  [{1}]" -f $exe, $mark)
  }
  Write-Host ''
  if ($game) {
    Write-Host '游戏本体（已解析）：' -ForegroundColor Green
    Write-Host "  路径 : $($game.Path)"
    Write-Host "  来源 : $($game.Source)"
  } else {
    Write-Host '游戏本体：未找到' -ForegroundColor Red
  }
  Write-Host ''
  Write-Host '（探测模式结束：未启动游戏、未启动界面、未打开浏览器）' -ForegroundColor Green
  exit 0
}

Info "node：$($node.Path)（$($node.Version)，来源：$($node.Source)）"
Info "Steam 根目录：$(if ($steam.Path) { $steam.Path } else { '（未找到）' })（来源：$($steam.Source)）"
if (-not $game) {
  Fail $GameNotFoundHint
}
Info "游戏本体：$($game.Path)（来源：$($game.Source)）"

# 0.1 修改器代码
if (-not (Test-Path (Join-Path $Root 'trainer\cli.mjs'))) { Fail "找不到修改器代码：$Root\trainer\cli.mjs" }

# 1. 游戏进程 + 调试端口
$gameProc = Get-Process -Name 'Pocket Cultivation' -ErrorAction SilentlyContinue
if ($gameProc) {
  if (Test-Port $CdpPort) {
    Info "游戏已在运行，调试端口 $CdpPort 已开启。"
  } else {
    Warn "检测到游戏已在运行，但**没有**开启调试端口（$CdpPort）。"
    Warn "这种情况修改器无法连接。请在游戏里完全退出（Steam 客户端里也退出），再用本脚本启动。"
    Fail '游戏必须由本脚本启动才能开启调试端口。'
  }
} else {
  Info "正在启动游戏（调试端口 $CdpPort）..."
  $env:POCKET_DESKTOP_E2E = '1'
  $env:POCKET_DESKTOP_REMOTE_DEBUGGING_PORT = "$CdpPort"
  $env:POCKET_DESKTOP_E2E_WINDOW_MODE = 'inactive'
  Start-Process -FilePath $game.Path | Out-Null
  Info '游戏已启动。'
  Warn '提示：游戏需要「进入存档（角色）」后，「活体发放」才可用；只做「写存档发放」则无需进入角色。'
}

# 2. 修改器界面（本地 HTTP 服务，只监听 127.0.0.1）
if (Test-Port $GuiPort) {
  Info "修改器界面已在运行：$GuiUrl"
} else {
  Info '正在启动修改器界面...'
  $serveArgs = "cli.mjs serve --game-exe `"$($game.Path)`""
  Start-Process -FilePath $node.Path `
    -ArgumentList $serveArgs `
    -WorkingDirectory (Join-Path $Root 'trainer') | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port $GuiPort) { $ok = $true; break }
  }
  if (-not $ok) {
    Fail "修改器界面启动失败（端口 $GuiPort 无响应）。请在 trainer 目录手动运行：`"$($node.Path)`" cli.mjs serve --game-exe `"$($game.Path)`""
  }
  Info "修改器界面已就绪：$GuiUrl"
}

# 3. 打开浏览器
Start-Process $GuiUrl | Out-Null
Info '已在浏览器打开修改器界面。'
Write-Host ''
Write-Host '使用提示：' -ForegroundColor Green
Write-Host '  · 流程：搜索道具 → 选数量 →「预览」→「确认发放」。'
Write-Host '  · 修改器首次连上游戏需要等游戏启动完成（约 1 分钟），界面里会显示连接状态。'
Write-Host '  · 「活体发放」即时生效、无需重载，但要求已在游戏里进入存档。'
Write-Host '  · 「写存档发放」直接改存档文件，发完需让游戏重新载入存档。'
Write-Host '  · 两种发放都会在写盘前自动备份到 trainer\backups\。'
Write-Host '  · 关闭本窗口不会关闭游戏或修改器界面。'
Write-Host ''
Read-Host '按回车关闭本窗口'
