# 口袋修仙修改器（外部）

给 Steam 单机游戏《口袋修仙 Demo》用的**游戏外修改器**。核心能力：**通过 CDP 活体注入，直接给玩家发放道具**。

- 零第三方依赖，只用 Node 内建模块。
- 界面是本机浏览器里的一个网页，只监听 `127.0.0.1`。
- 只有**一条**发放路径：**活体发放** —— 直接改游戏正在运行的内存，游戏内立即生效、无需重载存档。

> 本仓库只包含**修改器本身的源码**。游戏资源与游戏数据文件、个人数据一律不入库（见 `.gitignore` 白名单说明）。

---

## 一、环境要求

1. **一份通过 Steam 安装的《口袋修仙 Demo》**，且版本与修改器适配的 **同一 Demo 构建**（见「已知限制」）。
2. **Node.js v22 及以上**，或直接使用**预编译绿色包**（内含 Node 运行时，目标机器无需安装 Node）。
3. 仅支持 **Windows**。

---

## 二、准备道具表 `gamedata/items.csv`（必读）

修改器的「按名字搜索道具」依赖一份道具表 `gamedata/items.csv`。

**这份 CSV 是提取自游戏的游戏数据，本仓库刻意不附带它。** 请在你自己的游戏安装上运行生成脚本，从游戏的 ModSDK 参考数据里重新生成：

```powershell
node tools\make-items-csv.mjs
```

脚本会：

- 自动探测游戏安装位置（环境变量 `POCKET_TRAINER_GAME_EXE` → Steam 注册表 + `libraryfolders.vdf`），
  也可以用 `--game-dir` / `--exe` / `--modsdk` 显式指定；**探测不到会直接报错**，不会使用任何硬编码路径；
- 读取 `<游戏目录>\ModSDK\reference\domains\items\base-item-public-catalog.json`；
- 写出 `gamedata\items.csv`（14 列、UTF-8 带 BOM、CRLF）。

其他选项：

```powershell
node tools\make-items-csv.mjs --out out.csv                  # 写到别处
node tools\make-items-csv.mjs --game-dir "<你的游戏目录>\口袋修仙 Demo"
node tools\make-items-csv.mjs --modsdk "<你的游戏目录>\口袋修仙 Demo\ModSDK"
node tools\make-items-csv.mjs --help
```

> 若脚本报「找不到游戏 ModSDK 参考数据」，说明没探测到游戏；请用 `--game-dir` / `--modsdk`，
> 或设置环境变量 `POCKET_TRAINER_GAME_EXE` 指向游戏主程序。
> 不做这一步，修改器仍可运行，但**按名字搜索**不可用（只能直接填道具 ID 发放）。

---

## 三、运行

### 一键启动（推荐）

双击仓库根目录的 **`启动修改器.cmd`**，或：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-trainer.ps1
```

它会自动：① 用调试端口（`9333`）启动游戏（已在运行则复用）→ ② 启动本地界面
（`http://127.0.0.1:17321/`）→ ③ 打开浏览器。

只探测环境、不启动任何东西：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-trainer.ps1 -DetectOnly
```

node 探测顺序：环境变量 `POCKET_TRAINER_NODE` → 绿色包内置运行时（`runtime\node\node.exe`）
→ PATH → 常见安装位置。都没找到时，用 `POCKET_TRAINER_NODE` 指定 node 路径即可。

游戏探测顺序：环境变量 `POCKET_TRAINER_GAME_EXE` → Steam 注册表 → `libraryfolders.vdf` 各库；
**没有任何硬编码路径**，探测不到会明确报错并提示怎么办。若游戏装在非标准位置（或注册表里没有 Steam），
设置环境变量 `POCKET_TRAINER_GAME_EXE` 指向 `Pocket Cultivation.exe`，或手动跑 CLI 时加
`--game-exe "<你的游戏目录>\口袋修仙 Demo\Pocket Cultivation.exe"` 指定。

### 手动命令行

工作目录 = `trainer\`（把 `$NODE` 换成探测到的 node 可执行文件）：

```powershell
& $NODE cli.mjs serve                     # 起本地界面
& $NODE cli.mjs check                     # 静态自检（不碰游戏、不写盘）
& $NODE cli.mjs live status               # 只读：查看活状态与是否已进入角色
& $NODE cli.mjs live grant --item 1000053 --quantity 1              # 预览（默认 dry-run，不写）
& $NODE cli.mjs live grant --item 1000053 --quantity 1 --no-dry-run # 真正发放
& $NODE selftest.mjs                      # 离线自检（只写系统临时目录）
```

### 绿色包

`build-package.ps1` 会把修改器代码 + Node 运行时 + 文档打包成
`dist\口袋修仙修改器-绿色版\` 及其 `.zip`，目标机器无需安装 Node，双击包内「启动修改器.cmd」即可。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-package.ps1
```

---

## 四、发放道具（唯一流程）

在浏览器界面里：**搜索道具 → 点「加入」放进待发放清单 → 「预览（只读，不改游戏）」→「确认活体发放」**。

- 也可以不搜索：直接在「⚡ 活体发放」区填**道具 ID + 数量**，点「加入清单」（可发放不在道具表里的 ID）。
- **活体发放要求已经在游戏里进入存档（角色）**；主菜单 / 未载入存档时会被拒绝（那种状态改内存不会持久化）。
- 发放**前**会强制把目标存档备份到 `trainer\backups\`（文件名带时间戳）；**备份失败即中止、绝不写入**。
- 必须再点「确认活体发放」才真正执行（服务端一次性令牌防止中途被掉包）；发放后会重读活内存校验数量确实增加，未增加即报失败。

---

## 五、已知限制

- **仅 Windows**。
- 界面端口 `17321`，游戏调试端口 `9333`；均只绑 `127.0.0.1`。
- 依赖游戏的 **E2E 调试开关**与**特定构建**；游戏一旦更新，接口可能变化，修改器可能失效。
- 「写存档发放」方式**已移除**，只剩活体发放。
- 界面筛选只提供**分类 / 品阶 / 元素 / 占格尺寸**四项，不含游戏内的「特征 / 机制 / Buff / 属性」。
- 本仓库不含 `gamedata/items.csv`，需自行生成（见第二节）。

---

## 六、免责声明

- 本工具仅供**个人学习 / 单机自用**，请勿用于任何联机或商业用途。
- 与游戏开发商、发行商及 Valve 均**无任何关联**。
- 使用本工具的风险自负（包括可能的存档损坏、游戏异常等）。
- 请遵守游戏自身的用户协议（EULA）；若违反，后果由使用者承担。

## 许可证

[MIT](LICENSE)
