// 口袋修仙外置修改器 —— 集中配置（config.mjs）
//
// 零第三方依赖：只用 node: 内建模块。
//
// 覆盖优先级（后者覆盖前者）：
//   1. 本文件的 DEFAULT_*
//   2. 环境变量 POCKET_TRAINER_*
//   3. CLI 参数 --game-exe / --cdp-port / --gui-port / ...
//   4. 调用方显式传入的 overrides 对象
//
// 每个最终值都会在 config.sources 里记录它来自 override / cli / env:<NAME> / default。

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const TRAINER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = path.resolve(TRAINER_DIR, '..');
export const WORKSPACE_DIR = path.resolve(PROJECT_DIR, '..');

/**
 * 游戏主程序默认路径：**无硬编码**（null）。
 * 必须由调用方通过 `--game-exe` 或环境变量 `POCKET_TRAINER_GAME_EXE` 提供，
 * 或由 `start-trainer.ps1` 探测（Steam 注册表 + libraryfolders.vdf）后显式传入。
 */
export const DEFAULT_GAME_EXE = null;

/** CDP 调试端口。必须由 POCKET_DESKTOP_REMOTE_DEBUGGING_PORT 注入游戏才生效。 */
export const DEFAULT_CDP_PORT = 9333;

/** 本地 GUI 端口。只监听 127.0.0.1。 */
export const DEFAULT_GUI_PORT = 17321;
export const DEFAULT_GUI_HOST = '127.0.0.1';

/** 《口袋修仙 Demo》的 Steam App ID（实测 `steamapps\appmanifest_4777710.acf` → "口袋修仙 Demo"）。 */
export const STEAM_APP_ID = '4777710';

/** 写盘前备份的默认落盘目录：trainer/backups/ */
export const DEFAULT_BACKUP_DIR = path.join(TRAINER_DIR, 'backups');

/** 等待 CDP 端点出现的默认超时（实测游戏约 7 秒起来，这里留足余量）。 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 90000;
/** 单条 CDP 请求的默认超时。 */
export const DEFAULT_CDP_TIMEOUT_MS = 20000;
/** 等待 Runtime.executionContextCreated 的默认超时。 */
export const DEFAULT_CONTEXT_TIMEOUT_MS = 8000;

/** 主窗口 title 判据。绝不可用数组下标或固定 url 匹配。 */
export const GAME_TITLE = '口袋修仙';
/** 同一端口上另一个 page target 的 title，必须排除。 */
export const MOD_SCRIPT_HOST_TITLE = 'mod-script-host.html';

/**
 * 启动游戏时必须注入的三个环境变量。
 *   * 缺 E2E=1 时游戏不会 appendSwitch，端口变量完全不生效（硬事实）。
 *   * 缺 E2E_WINDOW_MODE_ENV=inactive 时窗口被置为 hidden，永不显示（硬事实）：
 *     游戏仅在 E2E 开关为 "1" 且窗口模式变量恰为 "inactive" 时才让窗口可见，
 *     其余取值（含变量缺失）一律得到 hidden。
 */
export const E2E_ENV = 'POCKET_DESKTOP_E2E';
export const DEBUG_PORT_ENV = 'POCKET_DESKTOP_REMOTE_DEBUGGING_PORT';
export const E2E_WINDOW_MODE_ENV = 'POCKET_DESKTOP_E2E_WINDOW_MODE';
/** E2E 模式下唯一能保持窗口可见的取值；其它取值（含缺失）都会得到 hidden。 */
export const E2E_WINDOW_MODE_INACTIVE = 'inactive';

/** 覆盖配置用的环境变量名。 */
export const ENV_KEYS = {
  gameExe: 'POCKET_TRAINER_GAME_EXE',
  cdpPort: 'POCKET_TRAINER_CDP_PORT',
  guiPort: 'POCKET_TRAINER_GUI_PORT',
  guiHost: 'POCKET_TRAINER_GUI_HOST',
  backupDir: 'POCKET_TRAINER_BACKUP_DIR',
  saveRoot: 'POCKET_TRAINER_SAVE_ROOT',
  modsDir: 'POCKET_TRAINER_MODS_DIR',
  workshopDir: 'POCKET_TRAINER_WORKSHOP_DIR',
  playerUid: 'POCKET_TRAINER_PLAYER_UID',
  launchTimeoutMs: 'POCKET_TRAINER_LAUNCH_TIMEOUT_MS',
};

/** 存档根目录默认值：%APPDATA%\Pocket Cultivation Demo\saves */
export function defaultSaveRoot(env = process.env) {
  const appData = env.APPDATA;
  return appData ? path.join(appData, 'Pocket Cultivation Demo', 'saves') : null;
}

/** 本地模组目录默认值：%APPDATA%\Pocket Cultivation Demo\mods（saves 的兄弟目录）。 */
export function defaultModsDir(env = process.env) {
  const appData = env.APPDATA;
  return appData ? path.join(appData, 'Pocket Cultivation Demo', 'mods') : null;
}

/**
 * 创意工坊模组目录默认值：由解析后的 gameExe 反推。
 *   `<steamapps>\common\<game>\<game>.exe`  →  `<steamapps>\workshop\content\<appId>`
 * 若 gameExe 不在 `...\steamapps\...` 树下（`<steamapps>` 段名不是 `steamapps`）→ null，
 * 此时创意工坊扫描自然为空（不报错）。
 * @param {string|null|undefined} gameExe
 */
export function defaultWorkshopDir(gameExe) {
  if (!gameExe || typeof gameExe !== 'string') return null;
  // <steamapps> = gameExe 所在目录的上两级（common\<game>\<game>.exe → steamapps）
  const steamapps = path.resolve(path.dirname(gameExe), '..', '..');
  if (path.basename(steamapps).toLowerCase() !== 'steamapps') return null;
  return path.join(steamapps, 'workshop', 'content', STEAM_APP_ID);
}

/** 解析一个正整数；空值返回 undefined；非法值抛错。 */
export function parsePositiveInt(raw, label = 'value') {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** CLI 选项名 -> 配置字段名。 */
const CLI_ALIASES = {
  'game-exe': 'gameExe',
  'cdp-port': 'cdpPort',
  port: 'cdpPort',
  'gui-port': 'guiPort',
  'gui-host': 'guiHost',
  'backup-dir': 'backupDir',
  'save-root': 'saveRoot',
  'mods-dir': 'modsDir',
  'workshop-dir': 'workshopDir',
  'player-uid': 'playerUid',
  timeout: 'launchTimeoutMs',
  'launch-timeout': 'launchTimeoutMs',
};

/**
 * 极简 argv 解析：支持 `--key value` 与 `--key=value`。
 * 非选项（位置参数）收进返回值 `_` 数组，供 cli.mjs 取子命令。
 */
export function parseArgv(argv = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string' || !a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const field = CLI_ALIASES[key];
    if (!field) {
      out._.push(a);
      continue;
    }
    if (val === undefined) {
      val = argv[i + 1];
      i += 1;
      if (val === undefined) throw new Error(`missing value for --${key}`);
    }
    out[field] = val;
  }
  return out;
}

/**
 * 合并出最终配置。
 * @param {{argv?: string[], env?: Record<string,string>, overrides?: object}} opts
 */
export function resolveConfig({ argv = [], env = process.env, overrides = {} } = {}) {
  const cli = parseArgv(argv);
  const sources = {};

  const take = (field, { envKey, coerce, label, fallback }) => {
    const cand = [
      ['override', overrides[field]],
      ['cli', cli[field]],
      [envKey ? `env:${envKey}` : null, envKey ? env[envKey] : undefined],
    ];
    for (const [from, raw] of cand) {
      if (raw === undefined || raw === null || raw === '') continue;
      sources[field] = from;
      return coerce ? coerce(raw, label || field) : raw;
    }
    sources[field] = 'default';
    return fallback;
  };

  // gameExe 先解析：workshopDir 的默认值由它反推。
  const gameExe = take('gameExe', { envKey: ENV_KEYS.gameExe, fallback: DEFAULT_GAME_EXE });

  const config = {
    gameExe,
    cdpPort: take('cdpPort', {
      envKey: ENV_KEYS.cdpPort,
      coerce: parsePositiveInt,
      label: 'cdpPort',
      fallback: DEFAULT_CDP_PORT,
    }),
    guiPort: take('guiPort', {
      envKey: ENV_KEYS.guiPort,
      coerce: parsePositiveInt,
      label: 'guiPort',
      fallback: DEFAULT_GUI_PORT,
    }),
    guiHost: take('guiHost', { envKey: ENV_KEYS.guiHost, fallback: DEFAULT_GUI_HOST }),
    backupDir: take('backupDir', { envKey: ENV_KEYS.backupDir, fallback: DEFAULT_BACKUP_DIR }),
    saveRoot: take('saveRoot', { envKey: ENV_KEYS.saveRoot, fallback: defaultSaveRoot(env) }),
    modsDir: take('modsDir', { envKey: ENV_KEYS.modsDir, fallback: defaultModsDir(env) }),
    workshopDir: take('workshopDir', {
      envKey: ENV_KEYS.workshopDir,
      fallback: defaultWorkshopDir(gameExe),
    }),
    playerUid: take('playerUid', { envKey: ENV_KEYS.playerUid, fallback: null }),
    launchTimeoutMs: take('launchTimeoutMs', {
      envKey: ENV_KEYS.launchTimeoutMs,
      coerce: parsePositiveInt,
      label: 'launchTimeoutMs',
      fallback: DEFAULT_LAUNCH_TIMEOUT_MS,
    }),
    cdpTimeoutMs: DEFAULT_CDP_TIMEOUT_MS,
    contextTimeoutMs: DEFAULT_CONTEXT_TIMEOUT_MS,
    gameTitle: GAME_TITLE,
    modScriptHostTitle: MOD_SCRIPT_HOST_TITLE,
    trainerDir: TRAINER_DIR,
    projectDir: PROJECT_DIR,
    sources,
  };

  // GUI 只允许回环地址，避免误暴露到局域网。
  if (config.guiHost !== '127.0.0.1' && config.guiHost !== 'localhost' && config.guiHost !== '::1') {
    throw new Error(`guiHost must be a loopback address (127.0.0.1 / localhost / ::1), got ${config.guiHost}`);
  }

  return Object.freeze(config);
}

/** 供 `check` 子命令打印的人类可读配置行。 */
export function describeConfig(config) {
  const rows = [
    ['gameExe', config.gameExe],
    ['cdpPort', config.cdpPort],
    ['guiHost', config.guiHost],
    ['guiPort', config.guiPort],
    ['backupDir', config.backupDir],
    ['saveRoot', config.saveRoot],
    ['modsDir', config.modsDir],
    ['workshopDir', config.workshopDir],
    ['playerUid', config.playerUid],
    ['launchTimeoutMs', config.launchTimeoutMs],
  ];
  return rows.map(([k, v]) => `  ${k.padEnd(16)} = ${v === null || v === undefined ? '(未设置)' : v}  [${config.sources[k] || 'default'}]`);
}

export const USAGE = `口袋修仙外置修改器 —— CDP 客户端 + 本地 GUI

用法：
  node cli.mjs serve            启动本地 GUI（默认 http://127.0.0.1:17321）
  node cli.mjs read             只读：启动游戏、经 CDP 读回存档并打印摘要（不写任何数据）
  node cli.mjs check            静态自检：配置 / 依赖模块 / 存档目录 / 道具表
  node cli.mjs live status      只读：连活状态桥（window.__pocketCultivationE2E）并打印活状态摘要
  node cli.mjs live probe       只读：打印活状态桥是否存在、是否就绪、9 个成员的类型
  node cli.mjs live grant --item <id> [--quantity N]
                                发放道具到**活状态**（游戏内即时生效，无需重载存档）
                                默认 dry-run：只算不写。**只有显式 --no-dry-run 才真写**。

通用选项（也可用环境变量覆盖）：
  --game-exe <path>     游戏主程序路径        (POCKET_TRAINER_GAME_EXE)
  --cdp-port <n>        CDP 调试端口          (POCKET_TRAINER_CDP_PORT)
  --port <n>            --cdp-port 的别名
  --gui-port <n>        GUI 监听端口          (POCKET_TRAINER_GUI_PORT)
  --gui-host <host>     GUI 监听地址(仅回环)  (POCKET_TRAINER_GUI_HOST)
  --backup-dir <path>   备份目录              (POCKET_TRAINER_BACKUP_DIR)
  --save-root <path>    存档根目录            (POCKET_TRAINER_SAVE_ROOT)
  --mods-dir <path>     本地模组目录          (POCKET_TRAINER_MODS_DIR)
  --workshop-dir <path> 创意工坊模组目录      (POCKET_TRAINER_WORKSHOP_DIR)
  --player-uid <uid>    指定 playerUid        (POCKET_TRAINER_PLAYER_UID)
  --timeout <ms>        等待 CDP 端点超时     (POCKET_TRAINER_LAUNCH_TIMEOUT_MS)
  --attach               read 时复用已运行的游戏，不自行启动
  --item <id>            live grant：道具 templateNumericId
  --quantity <n>         live grant：数量（默认 1；生成 n 个独立实例）
  --no-dry-run           live grant：真正写入活状态（危险，会立即改变当前角色）
`;
