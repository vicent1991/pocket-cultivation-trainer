#!/usr/bin/env node
/**
 * make-items-csv.mjs — 从「本机已安装的游戏」重新生成 gamedata\items.csv
 *
 * 为什么存在这个脚本：
 *   gamedata\items.csv 是从游戏 ModSDK 参考数据里提取出来的**游戏数据**，
 *   本仓库刻意**不附带**它（避免再分发游戏数据）。想用修改器的「模板目录」
 *   （按名字搜索道具）时，请在你自己的游戏安装上跑本脚本自行生成。
 *
 * 数据来源（只读，不改动游戏）：
 *   <游戏安装目录>\ModSDK\reference\domains\items\base-item-public-catalog.json
 *   该 JSON 的 `items[]` 每项字段与 csv 列一一对应（2080 条）。
 *
 * 输出（与修改器 trainer\item-catalog.mjs 的解析器**逐字节兼容**）：
 *   14 列，顺序固定：
 *     numericId,name,category,grade,element,iconBasename,isPublished,isObtainable,
 *     description,shape,distribution,effectList,price,modOverridePolicy
 *   UTF-8 **带 BOM**，CRLF 换行；RFC4180 最小引号（含 `"`/`,`/CR/LF 才加引号，内部 `"` 双写）。
 *   `shape` / `distribution` / `effectList` 三个 JSON 列使用与原始文件一致的
 *   「Python json.dumps(ensure_ascii=False)」风格分隔符（`: ` 与 `, `）。
 *
 * 零依赖，仅用 Node 内置模块。需要 Node v18+（推荐 v22+）。
 *
 * 用法：
 *   node tools/make-items-csv.mjs                 # 自动探测游戏路径，写 gamedata\items.csv
 *   node tools/make-items-csv.mjs --out out.csv   # 写到指定路径
 *   node tools/make-items-csv.mjs --game-dir "<你的游戏目录>\口袋修仙 Demo"
 *   node tools/make-items-csv.mjs --modsdk "<你的游戏目录>\口袋修仙 Demo\ModSDK"   # 直接指定 ModSDK 目录
 *   node tools/make-items-csv.mjs --exe "<你的游戏目录>\口袋修仙 Demo\Pocket Cultivation.exe"
 *
 * 路径解析优先级：
 *   1) --modsdk（直接给出 ModSDK 目录）
 *   2) --game-dir / --exe / 环境变量 POCKET_TRAINER_GAME_EXE
 *   3) 自动探测：Steam 注册表 HKCU/HKLM SteamPath → steamapps\libraryfolders.vdf 各库
 *   以上都找不到时**直接报错退出**（无硬编码兜底路径），并提示用 --modsdk / --game-dir /
 *   POCKET_TRAINER_GAME_EXE 指定游戏位置。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** 默认输出：仓库根\gamedata\items.csv。 */
const DEFAULT_OUT = join(REPO_ROOT, 'gamedata', 'items.csv');

/** 游戏本体相对 Steam 库的路径。 */
const GAME_REL_EXE = join('steamapps', 'common', '口袋修仙 Demo', 'Pocket Cultivation.exe');

const COLUMNS = [
  'numericId', 'name', 'category', 'grade', 'element', 'iconBasename', 'isPublished',
  'isObtainable', 'description', 'shape', 'distribution', 'effectList', 'price',
  'modOverridePolicy',
];

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, gameDir: null, modsdk: null, exe: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out' || a === '-o') out.out = next();
    else if (a === '--game-dir') out.gameDir = next();
    else if (a === '--modsdk') out.modsdk = next();
    else if (a === '--exe') out.exe = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--game-dir=')) out.gameDir = a.slice(11);
    else if (a.startsWith('--modsdk=')) out.modsdk = a.slice(9);
    else if (a.startsWith('--exe=')) out.exe = a.slice(6);
    else { console.error(`未知参数：${a}（用 --help 查看用法）`); process.exit(2); }
  }
  return out;
}

const HELP = `用法：node tools/make-items-csv.mjs [选项]

选项：
  -o, --out <path>        输出 CSV 路径（默认 gamedata\\items.csv）
      --game-dir <path>   游戏安装目录（含 Pocket Cultivation.exe）
      --exe <path>        游戏可执行文件路径
      --modsdk <path>     直接指定 ModSDK 目录（跳过游戏路径探测）
  -h, --help              显示本帮助

环境变量：
  POCKET_TRAINER_GAME_EXE  游戏可执行文件路径（优先级低于命令行 --exe）

数据来源：<ModSDK>\\reference\\domains\\items\\base-item-public-catalog.json`;

// ---------------------------------------------------------------------------
// 游戏路径探测（与 start-trainer.ps1 同思路，零依赖）
// ---------------------------------------------------------------------------

/** 读取 Windows 注册表里的 Steam 根目录（HKCU 优先，再 HKLM 32/64 位视图）。 */
function readSteamRootFromRegistry() {
  const probes = [
    ['HKCU', 'Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM', 'SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM', 'SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  for (const [hive, key, prop] of probes) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\${key}`, '/v', prop], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      const m = out.match(new RegExp(`${prop}\\s+REG_SZ\\s+(.+)`, 'i'));
      if (m && m[1]) return m[1].trim().replace(/\//g, '\\');
    } catch { /* 忽略，试下一个 */ }
  }
  return null;
}

/** 解析 <SteamRoot>\steamapps\libraryfolders.vdf（或 config\ 下的）里的所有库路径。 */
function readLibraryFolders(steamRoot) {
  const candidates = [
    join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    join(steamRoot, 'config', 'libraryfolders.vdf'),
  ];
  let text = null;
  for (const p of candidates) {
    try { text = readFileSync(p, 'utf8'); break; } catch { /* 试下一个 */ }
  }
  if (!text) return [];
  const libs = [];
  // 新格式："path"  "<路径>"（路径里的 \\ 需还原为 \）
  for (const m of text.matchAll(/"path"\s+"([^"]*)"/g)) {
    libs.push(m[1].replace(/\\\\/g, '\\'));
  }
  if (libs.length === 0) {
    // 旧格式：数字键 → 带盘符路径
    for (const m of text.matchAll(/"\d+"\s+"([A-Za-z]:[^"]*)"/g)) {
      libs.push(m[1].replace(/\\\\/g, '\\'));
    }
  }
  return libs;
}

/** 从「游戏安装目录」得到 ModSDK items 参考数据目录。 */
function modsdkItemsDirFromGameDir(gameDir) {
  return join(gameDir, 'ModSDK', 'reference', 'domains', 'items');
}

/** 解析 ModSDK items 目录：命令行 → 环境变量 → 注册表+VDF → 兜底。找不到则抛错。 */
function resolveModsdkItemsDir(args) {
  const tried = [];

  if (args.modsdk) {
    const itemsDir = existsSync(join(args.modsdk, 'reference', 'domains', 'items'))
      ? join(args.modsdk, 'reference', 'domains', 'items')
      : args.modsdk; // 允许直接指向 items 目录
    if (existsSync(join(itemsDir, 'base-item-public-catalog.json'))) return itemsDir;
    tried.push(`--modsdk: ${itemsDir}`);
  }

  // 收集「游戏安装目录」候选
  const gameDirs = [];
  const fromExe = (exePath) => (exePath ? dirname(exePath) : null);
  if (args.exe) gameDirs.push(fromExe(args.exe));
  if (process.env.POCKET_TRAINER_GAME_EXE) gameDirs.push(fromExe(process.env.POCKET_TRAINER_GAME_EXE));
  if (args.gameDir) gameDirs.push(args.gameDir);

  for (const gd of gameDirs) {
    if (!gd) continue;
    const itemsDir = modsdkItemsDirFromGameDir(gd);
    if (existsSync(join(itemsDir, 'base-item-public-catalog.json'))) return itemsDir;
    tried.push(`游戏目录: ${itemsDir}`);
  }

  // 自动探测 Steam 库
  const steamRoot = readSteamRootFromRegistry();
  const libs = [];
  if (steamRoot) {
    libs.push(steamRoot);
    for (const p of readLibraryFolders(steamRoot)) if (p && !libs.includes(p)) libs.push(p);
  }
  for (const lib of libs) {
    const exe = join(lib, GAME_REL_EXE);
    const itemsDir = modsdkItemsDirFromGameDir(dirname(exe));
    if (existsSync(join(itemsDir, 'base-item-public-catalog.json'))) return itemsDir;
    tried.push(`Steam 库: ${itemsDir}`);
  }

  // 兜底：无硬编码路径。直接报错，提示用户显式指定游戏位置。
  throw new Error(
    '找不到游戏 ModSDK 参考数据（base-item-public-catalog.json）。\n' +
    '请用 --modsdk 或 --game-dir 指定游戏位置，或设置 POCKET_TRAINER_GAME_EXE。\n' +
    '已尝试：\n  - ' + tried.join('\n  - '),
  );
}

// ---------------------------------------------------------------------------
// JSON → CSV 值序列化（与原始文件逐字节一致）
// ---------------------------------------------------------------------------

/** 数字 → 字符串：整数直出；非整数用 JS 最短往返表示（本数据里应无浮点）。 */
function numToStr(n) {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/**
 * 复刻 Python `json.dumps(obj, ensure_ascii=False)` 的**默认分隔符**输出：
 *   对象 `{"k": v, "k2": v2}`，数组 `[a, b]`（冒号/逗号后各一个空格）。
 * 本仓库原始 items.csv 正是这个风格，故必须一致。
 */
function pyJsonDump(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return numToStr(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJsonDump).join(', ') + ']';
  // 对象：保持插入顺序（JSON.parse 保序）
  const parts = Object.keys(v).map((k) => JSON.stringify(k) + ': ' + pyJsonDump(v[k]));
  return '{' + parts.join(', ') + '}';
}

/** RFC4180 最小引号：仅当字段含 `"` / `,` / CR / LF 时加引号，内部 `"` 双写。 */
function csvField(s) {
  const str = s === null || s === undefined ? '' : String(s);
  if (/["\r\n,]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

/** 单条 catalog item → 14 列字符串数组（顺序同 COLUMNS）。 */
function itemToRow(it) {
  const jsonCell = (v) => (v === undefined || v === null ? '' : pyJsonDump(v));
  const boolCell = (b) => (typeof b === 'boolean' ? (b ? 'True' : 'False') : '');
  const numCell = (n) => (typeof n === 'number' ? numToStr(n) : '');
  const strCell = (s) => (s === undefined || s === null ? '' : String(s));

  return [
    numCell(it.numericId),
    strCell(it.name),
    strCell(it.category),
    strCell(it.grade),
    strCell(it.element),
    strCell(it.iconBasename),
    boolCell(it.isPublished),
    boolCell(it.isObtainable),
    strCell(it.description),
    jsonCell(it.shape),
    jsonCell(it.distribution),
    jsonCell(it.effectList),
    numCell(it.price),
    strCell(it.modOverridePolicy),
  ];
}

/** 组装整份 CSV 文本：UTF-8 BOM + 表头 + 数据行，CRLF 换行。 */
function buildCsv(items) {
  const lines = [COLUMNS.join(',')];
  for (const it of items) lines.push(itemToRow(it).map(csvField).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const itemsDir = resolveModsdkItemsDir(args);
  const catalogPath = join(itemsDir, 'base-item-public-catalog.json');
  console.log(`数据来源：${catalogPath}`);

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    throw new Error(`读取/解析 catalog 失败：${err.message}`);
  }
  if (!catalog || !Array.isArray(catalog.items)) {
    throw new Error(`catalog 结构不符：期望顶层 { items: [...] }`);
  }

  const csv = buildCsv(catalog.items);
  const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, csv, 'utf8');

  console.log(`已写入：${outPath}`);
  console.log(`  行数：${catalog.items.length} 数据行 + 1 表头`);
  console.log(`  列：${COLUMNS.length}（${COLUMNS.join(',')}）`);
  console.log('  UTF-8 BOM + CRLF');
}

try {
  main();
} catch (err) {
  console.error('错误：' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
