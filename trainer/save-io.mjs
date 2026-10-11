/**
 * save-io.mjs — 存档文件定位与读写（含安全闸门）
 *
 * 存档目录布局：
 *   %APPDATA%\Pocket Cultivation Demo\saves\
 *     catalog.json                        <- 物品目录，不是存档
 *     steam_autocloud.vdf
 *     备份\                                <- 备份目录，不是正式档
 *     <base64url(playerUid)>\              <- 例如 c3RlYW0tdGVzdC11c2Vy（合成示例，非真实账号）
 *       catalog.json
 *       <base64url(characterId)>\          <- 例如 Y2hhcl90ZXN0X3g5eTh6N185ZjhlN2Q2Yw
 *         <base64url(saveId)>.json         <- 正式存档
 *       _short\                            <- 长路径变体：<sha256>.json（不可解码）
 *
 * 安全闸门：`writeSaveAtomic()` 必须由调用方显式传入路径，且默认**拒绝**写入
 * `resolveSaveDir()` 返回的真实存档目录，除非显式传 `{ allowRealSave: true }`。
 * 自检只在系统临时目录写副本。
 */
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync,
  readdirSync, statSync, rmSync,
} from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';

/** 存档目录名（相对 %APPDATA%）。 */
export const SAVE_SUBDIR = join('Pocket Cultivation Demo', 'saves');

/** 非存档文件名，枚举时必须排除。 */
export const NON_SAVE_FILES = new Set(['catalog.json', 'steam_autocloud.vdf']);

/** 非正式档目录名。 */
export const NON_SAVE_DIRS = new Set(['备份', '_short']);

/**
 * 原始档名 → 文件名：`Buffer.from(name,'utf8').toString('base64url')`（无填充）。
 * 与游戏一致；空串抛错（游戏原文 `Local save path segment is empty`）。
 */
export function encodeSaveFileName(rawName) {
  const trimmed = String(rawName).trim();
  if (!trimmed) throw new Error('Local save path segment is empty');
  return Buffer.from(trimmed, 'utf8').toString('base64url');
}

/**
 * 文件名 → 原始档名。去掉 `.json` 后缀后按 base64url 解码。
 * 注意：`_short\<sha256>.json` 的文件名是 sha256 hex，不是 base64url，解码结果是垃圾 ——
 * 调用方应先用 `isLikelyEncodedSaveFileName()` 判断。
 */
export function decodeSaveFileName(fileName) {
  let stem = basename(String(fileName));
  if (stem.toLowerCase().endsWith('.json')) stem = stem.slice(0, -5);
  if (!stem) throw new Error('Local save path segment is empty');
  return Buffer.from(stem, 'base64url').toString('utf8');
}

/**
 * 判断一个文件名是否「看起来」是 base64url 编码的存档名。
 * 判据：去掉 .json 后只含 base64url 字符集，且能 round-trip 回同一字符串。
 * 这样可排除 `catalog.json`（含 `.`）、`_short\` 下的 sha256 hex（能 round-trip 但
 * 解码后不是可读档名，故额外要求解码结果全部是可打印 ASCII 且以 save_ 开头）。
 */
export function isLikelyEncodedSaveFileName(fileName) {
  let stem = basename(String(fileName));
  if (stem.toLowerCase().endsWith('.json')) stem = stem.slice(0, -5);
  if (!/^[A-Za-z0-9_-]+$/.test(stem)) return false;
  let decoded;
  try { decoded = Buffer.from(stem, 'base64url').toString('utf8'); } catch { return false; }
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== stem) return false;
  return /^save_[\x20-\x7e]*$/.test(decoded);
}

/** 解析存档根目录（**只解析路径，不创建、不写入**）。 */
export function resolveSaveDir(appData = process.env.APPDATA) {
  if (!appData) throw new Error('%APPDATA% is not set; pass appData explicitly');
  return join(appData, SAVE_SUBDIR);
}

/** 目录是否存在（便捷判断，不创建）。 */
export function saveDirExists(appData) {
  return existsSync(resolveSaveDir(appData));
}

/**
 * 列出存档根下的 `.json` 存档（递归 2 层：playerUid 段 → characterId 段）。
 * 排除 `catalog.json` / `steam_autocloud.vdf` / `备份` / `_short`（后者档名不可解码）。
 *
 * @returns {Array<{path:string, fileName:string, rawName:string|null, size:number,
 *                  playerUidSegment:string, characterSegment:string, inShortDir:boolean}>}
 *          `rawName` 为 null 表示文件名无法解码回原始档名。
 */
export function listSaves(rootDir = resolveSaveDir()) {
  const out = [];
  if (!existsSync(rootDir)) return out;

  const walk = (dir, depth, playerUidSegment, characterSegment) => {
    if (depth > 2) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (NON_SAVE_DIRS.has(e.name)) {
          // _short 下的档也枚举出来，但标记 inShortDir 且 rawName 为 null
          if (e.name === '_short') {
            let sub = [];
            try { sub = readdirSync(p, { withFileTypes: true }); } catch { sub = []; }
            for (const s of sub) {
              if (!s.isFile() || !s.name.toLowerCase().endsWith('.json')) continue;
              out.push({
                path: join(p, s.name), fileName: s.name, rawName: null,
                size: safeSize(join(p, s.name)),
                playerUidSegment, characterSegment, inShortDir: true,
              });
            }
          }
          continue;
        }
        if (depth === 0) walk(p, 1, e.name, '');
        else if (depth === 1) walk(p, 2, playerUidSegment, e.name);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
      if (NON_SAVE_FILES.has(e.name)) continue;
      out.push({
        path: p, fileName: e.name,
        rawName: isLikelyEncodedSaveFileName(e.name) ? decodeSaveFileName(e.name) : null,
        size: safeSize(p), playerUidSegment, characterSegment, inShortDir: false,
      });
    }
  };

  walk(rootDir, 0, '', '');
  return out;
}

function safeSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

/** 读取并解析存档 JSON。 */
export function readSave(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 读原始文本（需要字节级保真时用）。 */
export function readSaveText(path) {
  return readFileSync(path, 'utf8');
}

/**
 * 判断目标路径是否落在真实存档目录内。
 * 用 resolve() 归一化后比较，避免 `..\` 绕过。
 */
export function isInsideRealSaveDir(path, appData) {
  const real = resolve(resolveSaveDir(appData));
  const target = resolve(path);
  return target === real || target.startsWith(real + sep);
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 安全闸门（两道）：
 *   1. `path` 必填 —— 不允许「自动推导真实存档路径」这种便利重载；
 *   2. 若 `path` 落在真实存档目录内，必须显式传 `{ allowRealSave: true }`，否则抛错。
 *
 * @param {string} path 目标文件绝对路径
 * @param {object} obj  要序列化的对象
 * @param {{allowRealSave?: boolean, appData?: string, indent?: number}} [opts]
 */
export function writeSaveAtomic(path, obj, opts = {}) {
  if (!path || typeof path !== 'string') {
    throw new Error('writeSaveAtomic requires an explicit target path');
  }
  if (isInsideRealSaveDir(path, opts.appData) && opts.allowRealSave !== true) {
    throw new Error(
      `refusing to write inside the real save directory (${resolveSaveDir(opts.appData)}); ` +
      'pass { allowRealSave: true } to override',
    );
  }
  const dir = dirname(resolve(path));
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  const text = JSON.stringify(obj, null, opts.indent ?? 0);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, resolve(path));
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return resolve(path);
}
