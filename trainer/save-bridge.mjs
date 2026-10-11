/**
 * save-bridge.mjs —— 通过游戏 preload 暴露的 `window.pocketCultivationDesktop` 读写存档。
 *
 * 关键事实：
 *   - 全局 API 挂在**主世界** `window.pocketCultivationDesktop`；contextIsolation + sandbox
 *     下有多个 executionContext，只有 `auxData.isDefault === true` 的那个能看到它。
 *   - `localSave.read(e)` / `localSave.write(e)` 是 Electron IPC invoke 的包装，
 *     **一律返回 Promise**，且每个方法只收**一个参数对象**。
 *       read(e)  : e = { playerUid, characterId?, saveId?, allowRecovery? } → Promise<存档对象>
 *       write(e) : e = { playerUid, save: <完整存档对象> }               → Promise<{summary, removedSaveIds}>
 *   - `playerUid` 形如 `steam-<SteamID64>`，
 *     **绝不硬编码** —— 从存档目录的 base64url 目录名反解。
 *
 * 本模块**只做桥接**：不决定何时写、不备份、不校验。写盘前的备份与两步确认由
 * `gui-server.mjs` / `cli.mjs` 负责。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeSaveFileName, listSaves, resolveSaveDir } from './save-io.mjs';
import { evaluateJson } from './cdp-client.mjs';

/** preload 通过 contextBridge 暴露的全局对象名。 */
export const API_GLOBAL = 'window.pocketCultivationDesktop';

/** 顶层同步方法（非 Promise）。 */
export const SYNC_API_METHODS = ['getRuntimeConfig'];
/** localSave 命名空间下会写盘的方法（本工具永不调用）。 */
export const DESTRUCTIVE_LOCAL_SAVE_METHODS = ['write', 'remove', 'renameSummary', 'importDemoSaves'];

// ---------------------------------------------------------------------------
// playerUid / characterId 探测（纯本地，只读）
// ---------------------------------------------------------------------------

/**
 * 枚举存档目录里出现的 playerUid 段，反解成 `steam-<SteamID64>`。
 * 只读；不创建任何文件。
 *
 * @param {string} [rootDir]
 * @returns {Array<{segment:string, playerUid:string|null, saveCount:number, characters:string[]}>}
 */
export function detectPlayerUids(rootDir = resolveSaveDir()) {
  /** @type {Map<string, {segment:string, playerUid:string|null, saveCount:number, characters:Set<string>}>} */
  const bySegment = new Map();

  const add = (segment, characterSegment) => {
    let entry = bySegment.get(segment);
    if (!entry) {
      let playerUid = null;
      try { playerUid = decodeSaveFileName(segment); } catch { playerUid = null; }
      entry = { segment, playerUid, saveCount: 0, characters: new Set() };
      bySegment.set(segment, entry);
    }
    entry.saveCount += 1;
    if (characterSegment) {
      try { entry.characters.add(decodeSaveFileName(characterSegment)); } catch { /* 忽略不可解码段 */ }
    }
  };

  for (const s of listSaves(rootDir)) {
    if (s.inShortDir || !s.playerUidSegment) continue;
    add(s.playerUidSegment, s.characterSegment);
  }

  // 兜底：目录里还没有任何存档文件时，直接解码第一层目录名。
  if (bySegment.size === 0) {
    let ents = [];
    try { ents = readdirSync(rootDir, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      let decoded = null;
      try { decoded = decodeSaveFileName(e.name); } catch { continue; }
      if (!decoded || !decoded.includes('-')) continue;
      add(e.name, '');
      let subs = [];
      try { subs = readdirSync(join(rootDir, e.name), { withFileTypes: true }); } catch { subs = []; }
      const entry = bySegment.get(e.name);
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        try { entry.characters.add(decodeSaveFileName(sub.name)); } catch { /* ignore */ }
      }
    }
  }

  return [...bySegment.values()]
    .map((e) => ({
      segment: e.segment,
      playerUid: e.playerUid,
      saveCount: e.saveCount,
      characters: [...e.characters].sort(),
    }))
    .sort((a, b) => b.saveCount - a.saveCount || String(a.segment).localeCompare(String(b.segment)));
}

/**
 * 选出一个 playerUid：显式传入优先，否则取存档数最多的那个。
 * @returns {string|null}
 */
export function resolvePlayerUid({ explicit = null, rootDir = resolveSaveDir() } = {}) {
  if (explicit) return explicit;
  const list = detectPlayerUids(rootDir);
  for (const entry of list) {
    if (entry.playerUid) return entry.playerUid;
  }
  return null;
}

/** 列出某个 playerUid 段下的角色目录（反解后的 characterId）。 */
export function listCharacters(playerUid, rootDir = resolveSaveDir()) {
  const target = detectPlayerUids(rootDir).find((e) => e.playerUid === playerUid);
  return target ? target.characters : [];
}

/** 找出本地磁盘上与 playerUid 对应的最新存档文件路径（只读）。 */
export function findLocalSaveFile(playerUid, rootDir = resolveSaveDir()) {
  const rows = listSaves(rootDir)
    .filter((s) => !s.inShortDir)
    .map((s) => {
      let uid = null;
      try { uid = decodeSaveFileName(s.playerUidSegment); } catch { uid = null; }
      return { ...s, uid };
    })
    .filter((s) => (playerUid ? s.uid === playerUid : true));

  if (rows.length === 0) return null;
  // 优先正式角色（非 backup / recovery），再按修改时间/大小取最新。
  const preferred = rows.filter((r) => {
    const c = r.characterSegment;
    return c && !c.includes('backup') && !c.includes('recovery');
  });
  const pool = preferred.length > 0 ? preferred : rows;
  pool.sort((a, b) => b.size - a.size);
  return pool[0].path;
}

/**
 * 找出本地磁盘上**当前正被游戏载入**的存档文件（只读）。
 *
 * 为什么不能复用 findLocalSaveFile：它**刻意排除**名字含 backup/recovery 的角色，再按体积取最大。
 * 游戏实际载入的常常是 `char_recovery_<hash>-…`（更小但更新），
 * 而 findLocalSaveFile 会选中另一个更大的正式角色 `save_manual_char_<name>_<hash>_…`
 * ⇒ 活体发放的「先备份」备份到了**错误角色**的档，备份保证形同虚设。
 * 且活状态（`readWorldState`）里**没有** characterId/saveId（86 个顶层键只有 lastSaveTime 等），
 * 无法从桥识别当前角色；可靠代理是**最近修改时间**：游戏会持续自动存档当前载入的角色。
 *
 * ⚠️ **必须把 `_short` 也当候选**。游戏会把长路径存档迁移进
 * `<playerUid>\_short\<sha256>.json`，当前载入角色的档经常就在 `_short` 下，
 * 且那正是活体发放持久化写入的文件。
 * 这些 `_short` 行的 `playerUidSegment` 有值、`characterSegment` 为空，故 playerUid 匹配仍成立。
 * 若像 findLocalSaveFile 那样排除 `_short`，就会再次备份到**另一个角色**的档。
 *
 * 选法：该 player 下（匹配反解 playerUidSegment，**不排除 inShortDir**）**mtime 最大**的那份；
 * **不排除** recovery/backup 角色。无候选返回 null。
 *
 * @param {string|null} playerUid
 * @param {string} [rootDir]
 * @returns {string|null}
 */
export function findActiveSaveFile(playerUid, rootDir = resolveSaveDir()) {
  const rows = listSaves(rootDir)
    .map((s) => {
      let uid = null;
      try { uid = decodeSaveFileName(s.playerUidSegment); } catch { uid = null; }
      return { ...s, uid };
    })
    .filter((s) => (playerUid ? s.uid === playerUid : true));

  if (rows.length === 0) return null;

  let best = null;
  let bestMtime = -Infinity;
  for (const r of rows) {
    let mtimeMs = -Infinity;
    try { mtimeMs = statSync(r.path).mtimeMs; } catch { mtimeMs = -Infinity; }
    if (mtimeMs > bestMtime) {
      bestMtime = mtimeMs;
      best = r;
    }
  }
  return best ? best.path : null;
}

/**
 * 反解出与 playerUid 对应的正式角色存档标识（characterId / saveId / 本地路径）。
 *
 * 必要性：主进程侧 `read(u)` 会用 `{playerUid, characterId, saveId}` 解析存档路径
 * （内部会对 `u.characterId.trim()`），只传 `{playerUid}` 会抛
 * `TypeError: Cannot read properties of undefined (reading 'trim')`。
 * 这里从存档目录的 base64url 目录名 / 文件名反解，不硬编码。
 *
 * @param {string|null} playerUid
 * @param {string} [rootDir]
 * @returns {{playerUid:string|null, characterId:string, saveId:string, path:string}|null}
 */
export function resolveSaveIdentity(playerUid, rootDir = resolveSaveDir()) {
  const rows = listSaves(rootDir)
    .filter((s) => !s.inShortDir && s.rawName)
    .map((s) => {
      let uid = null;
      let characterId = null;
      try { uid = decodeSaveFileName(s.playerUidSegment); } catch { uid = null; }
      try { characterId = decodeSaveFileName(s.characterSegment); } catch { characterId = null; }
      return { ...s, uid, characterId };
    })
    .filter((s) => (playerUid ? s.uid === playerUid : true))
    .filter((s) => s.characterId);

  if (rows.length === 0) return null;
  const preferred = rows.filter(
    (r) => !r.characterId.includes('backup') && !r.characterId.includes('recovery'),
  );
  const pool = preferred.length > 0 ? preferred : rows;
  pool.sort((a, b) => b.size - a.size);
  const top = pool[0];
  return { playerUid: top.uid, characterId: top.characterId, saveId: top.rawName, path: top.path };
}

// ---------------------------------------------------------------------------
// CDP 侧调用
// ---------------------------------------------------------------------------

/**
 * 探测主世界里 preload API 是否真的存在（只读，无副作用）。
 * @param {{client:object, contextId:number|undefined}} ctx
 */
export async function probeApi(ctx) {
  const expr = `(() => {
    const a = ${API_GLOBAL};
    if (!a) return { present: false };
    return {
      present: true,
      topKeys: Object.keys(a).sort(),
      localSaveKeys: a.localSave ? Object.keys(a.localSave).sort() : null,
      hasLocalSave: !!a.localSave,
    };
  })()`;
  return await evaluateJson(ctx.client, expr, { contextId: ctx.contextId });
}

/** 读游戏运行时配置（同步方法，用于确认 contentEdition 等）。 */
export async function getRuntimeConfigViaCdp(ctx) {
  return await evaluateJson(ctx.client, `${API_GLOBAL}.getRuntimeConfig()`, { contextId: ctx.contextId });
}

/**
 * 经 CDP 调 `localSave.read`。
 *
 * ⚠️ 主进程侧 `read(u)` 必须能拿到 `u.characterId` / `u.saveId` 才能解析存档路径
 * （内部会对 `u.characterId.trim()`）；只传 `{playerUid}` 会抛
 * `TypeError: Cannot read properties of undefined (reading 'trim')`。
 * 缺省时由 `resolveSaveIdentity` 从存档目录反解补齐。
 *
 * @param {{client:object, contextId:number|undefined}} ctx
 * @param {string} playerUid
 * @param {{characterId?:string, saveId?:string, allowRecovery?:boolean, rootDir?:string}} [opts]
 * @returns {Promise<object>} 游戏返回的原始结构
 */
export async function readSaveViaCdp(ctx, playerUid, opts = {}) {
  if (!playerUid) throw new Error('readSaveViaCdp: playerUid is required');
  let characterId = opts.characterId || null;
  let saveId = opts.saveId || null;
  if (!characterId || !saveId) {
    const rootDir = opts.rootDir || resolveSaveDir();
    const id = resolveSaveIdentity(playerUid, rootDir);
    if (!id) {
      throw new Error(
        `readSaveViaCdp: 无法为 playerUid "${playerUid}" 反解出 characterId/saveId（存档目录：${rootDir}）`,
      );
    }
    characterId = characterId || id.characterId;
    saveId = saveId || id.saveId;
  }
  const payload = { playerUid, characterId, saveId };
  if (opts.allowRecovery === true) payload.allowRecovery = true;
  const arg = JSON.stringify(payload);
  return await evaluateJson(ctx.client, `${API_GLOBAL}.localSave.read(${arg})`, { contextId: ctx.contextId });
}

/**
 * 经 CDP 调 `localSave.write`。**调用方必须先备份、并完成两步确认。**
 * @param {{client:object, contextId:number|undefined}} ctx
 * @param {string} playerUid
 * @param {object} saveObj 完整存档对象
 */
export async function writeSaveViaCdp(ctx, playerUid, saveObj) {
  if (!playerUid) throw new Error('writeSaveViaCdp: playerUid is required');
  if (!saveObj || typeof saveObj !== 'object' || Array.isArray(saveObj)) {
    throw new Error('writeSaveViaCdp: saveObj must be a plain save object');
  }
  const arg = JSON.stringify({ playerUid, save: saveObj });
  return await evaluateJson(ctx.client, `${API_GLOBAL}.localSave.write(${arg})`, { contextId: ctx.contextId });
}

/** 列存档摘要（只读）。 */
export async function listSummariesViaCdp(ctx, playerUid) {
  const arg = JSON.stringify({ playerUid });
  return await evaluateJson(ctx.client, `${API_GLOBAL}.localSave.listSummaries(${arg})`, {
    contextId: ctx.contextId,
  });
}

// ---------------------------------------------------------------------------
// 返回结构归一化
// ---------------------------------------------------------------------------

/**
 * `localSave.read` 的返回可能是存档对象本身，也可能被包了一层（`{save: ...}` / `{value: ...}`）。
 * 这里统一取出真正的存档对象（含 `snapshot` 字段的那个）。
 *
 * @param {any} result
 * @returns {{save: object|null, wrapper: object|null}}
 */
export function extractSave(result) {
  if (!result || typeof result !== 'object') return { save: null, wrapper: null };
  if (result.snapshot && typeof result.snapshot === 'object') return { save: result, wrapper: null };
  for (const key of ['save', 'value', 'data', 'result']) {
    const inner = result[key];
    if (inner && typeof inner === 'object' && inner.snapshot && typeof inner.snapshot === 'object') {
      return { save: inner, wrapper: result };
    }
  }
  return { save: null, wrapper: result };
}

/**
 * 生成人类可读的存档摘要（只读，不改动入参）。
 */
export function summarizeSave(saveObj) {
  if (!saveObj || typeof saveObj !== 'object') return { ok: false, reason: 'not an object' };
  const snap = saveObj.snapshot;
  if (!snap || typeof snap !== 'object') return { ok: false, reason: 'snapshot is missing' };
  const inv = Array.isArray(snap.inventoryItems) ? snap.inventoryItems : [];
  const placed = Array.isArray(snap.placedItems) ? snap.placedItems : [];
  const templates = new Set();
  for (const it of inv) {
    if (it && Number.isInteger(it.templateNumericId)) templates.add(it.templateNumericId);
  }
  return {
    ok: true,
    topLevelKeys: Object.keys(saveObj).sort(),
    rulesVersion: saveObj.rulesVersion ?? null,
    sourceContentEdition: saveObj.sourceContentEdition ?? null,
    snapshotHash: saveObj.snapshotHash ?? null,
    localSaveHash: saveObj.localSaveHash ?? null,
    inventoryCount: inv.length,
    placedCount: placed.length,
    distinctTemplateIds: templates.size,
    hasRecovery: saveObj.recovery !== null && saveObj.recovery !== undefined,
  };
}

export { listSaves, resolveSaveDir };
