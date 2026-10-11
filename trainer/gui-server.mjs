/**
 * gui-server.mjs —— 本地 GUI 的 HTTP 服务（node:http，零依赖）。
 *
 * 端点：
 *   GET  /                    单页界面（gui-ui.mjs 内联 HTML）
 *   GET  /api/status          连接 / 存档目录 / 备份状态
 *   GET  /api/items?q=<关键词>&category=&grade=&element=&shape=
 *                             道具搜索（读本地 items.csv + 模组新增道具）；
 *                             四个筛选维度可单选，与 q AND 组合；响应带 facets（各维度选项+计数）。
 *   GET  /api/saves           枚举本地存档文件
 *   GET  /api/backups         列出备份文件
 *   GET  /api/save/current    只读：当前存档摘要（不写盘）
 *   GET  /api/live/status     活状态桥状态 + 活状态摘要（**只读**）
 *   POST /api/live/grant/preview 活体发放步骤 1：算出发放后新增元素（**不写**活状态）
 *   POST /api/live/grant/apply   活体发放步骤 2：校验 previewToken + confirm，patch 活状态
 *
 * 只有**一条**发放路径：`/api/live/*` 改**游戏活内存**
 * （window.__pocketCultivationE2E.patchWorldState）。发放后**游戏内即时生效**，无需重载存档，
 * 并且**立即真实落盘**（发放前已强制自动备份）。
 *
 * 安全约束：
 *   - **只监听回环地址**（config.guiHost 由 config.mjs 强制为 127.0.0.1 / localhost / ::1）。
 *   - 活体发放是**两步**：必须先 `/api/live/grant/preview` 拿到 `previewToken`，再带
 *     `confirm: true` 调 `/api/live/grant/apply`。apply 前会**强制自动备份存档文件**，
 *     备份失败即中止、绝不 patch；apply 时会**重新读一次活状态**再算新增元素，避免写入过期数据。
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { getCatalog } from './item-catalog.mjs';
import { renderHtml } from './gui-ui.mjs';
import { describeTargets, fetchTargets, findMainTarget } from './discovery.mjs';
import { connectAndGetContext } from './cdp-client.mjs';
import { computeHashes, verifyHashes } from './save-codec.mjs';
import { backupSave, backupSaveObject, listBackups } from './backup.mjs';
import {
  detectPlayerUids,
  extractSave,
  findActiveSaveFile,
  findLocalSaveFile,
  listSaves,
  probeApi,
  readSaveViaCdp,
  resolvePlayerUid,
  resolveSaveDir,
  summarizeSave,
} from './save-bridge.mjs';
import {
  BRIDGE_GLOBAL,
  BRIDGE_MEMBERS,
  BRIDGE_READY_MEMBER,
  describeLiveSummary,
  grantLiveItems,
  probeLiveBridge,
  readLiveSessionStatus,
  readLiveWorldStateSummary,
  waitForLiveBridge,
} from './live-bridge.mjs';

/** preview token 有效期：10 分钟。 */
const PREVIEW_TTL_MS = 10 * 60 * 1000;
/** 请求体上限（预览请求只带 grants，很小）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** /api/items 与 /api/saves 单次返回上限。 */
const MAX_ROWS = 200;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (err) { reject(new Error(`request body is not valid JSON: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

/** 归一化前端传来的发放清单。 */
export function normalizeGrants(raw) {
  if (!Array.isArray(raw)) throw new Error('grants must be an array');
  if (raw.length === 0) throw new Error('grants is empty');
  const out = [];
  for (const g of raw) {
    const id = Number(g && g.templateNumericId);
    const qty = g && g.quantity === undefined ? 1 : Number(g && g.quantity);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`invalid templateNumericId: ${JSON.stringify(g && g.templateNumericId)}`);
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(`invalid quantity for template ${id}: ${JSON.stringify(g && g.quantity)}`);
    }
    out.push({ templateNumericId: id, quantity: qty });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CDP 会话
// ---------------------------------------------------------------------------

/**
 * 连一次主窗口、跑 fn、必定收尾。**不会自己启动游戏**（GUI 假定游戏已在跑）。
 */
async function withCdp(config, fn) {
  let targets;
  try {
    targets = await fetchTargets(config.cdpPort, { timeoutMs: 3000 });
  } catch (err) {
    throw new Error(
      `CDP 端点 127.0.0.1:${config.cdpPort} 不可达（${err.message}）。` +
        '请先用本工具（serve/read）启动游戏，或带 POCKET_DESKTOP_E2E=1 与 ' +
        'POCKET_DESKTOP_REMOTE_DEBUGGING_PORT 手动启动游戏。',
    );
  }
  const target = findMainTarget(targets);
  if (!target) {
    throw new Error(
      '未找到主窗口 target（判据：type === "page" && title === "口袋修仙"）。当前 targets：\n' +
        describeTargets(targets),
    );
  }
  const ctx = await connectAndGetContext(target, {
    timeoutMs: config.cdpTimeoutMs,
    contextTimeoutMs: config.contextTimeoutMs,
    label: 'gui',
  });
  try {
    return await fn(ctx);
  } finally {
    try { ctx.unsubscribe(); } catch { /* ignore */ }
    try { ctx.client.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * @param {{config: object, catalog?: object, logger?: (msg: string) => void}} opts
 */
export function createGuiServer({ config, catalog = null, logger = null } = {}) {
  if (!config || typeof config !== 'object') throw new Error('createGuiServer: config is required');
  const cat = catalog || getCatalog(undefined, config.modsDir, config.workshopDir);
  const log = typeof logger === 'function' ? logger : () => {};

  // 启动时预热一次目录（csv + 本地模组 + 创意工坊模组新增道具；getCatalog 自带进程级缓存）并记录一行扫描摘要。
  const modNote = cat.modErrors.length ? `, ${cat.modErrors.length} errors` : '';
  log(
    `mods: scanned ${cat.localModCount} local + ${cat.workshopModCount} workshop = ${cat.modCount} mods, ` +
      `+${cat.modItemCount} items (catalog ${cat.csvRowCount} -> ${cat.rowCount})${modNote}`,
  );

  /** @type {Map<string, {kind:'live', createdAt:number, grants:object[], preview:object}>} */
  const pending = new Map();

  function sweepPending() {
    const now = Date.now();
    for (const [token, entry] of pending) {
      if (now - entry.createdAt > PREVIEW_TTL_MS) pending.delete(token);
    }
  }

  // ---- 各端点 -------------------------------------------------------------

  async function statusPayload() {
    const saveRoot = config.saveRoot || resolveSaveDir();
    let saveRootExists = false;
    let playerUids = [];
    let saveCount = 0;
    try {
      const rows = listSaves(saveRoot);
      saveCount = rows.filter((r) => !r.inShortDir).length;
      saveRootExists = true;
    } catch { /* 目录不存在 */ }
    try { playerUids = detectPlayerUids(saveRoot); } catch { playerUids = []; }

    const cdp = {
      port: config.cdpPort,
      endpointUp: false,
      mainTargetFound: false,
      mainTargetTitle: null,
      targets: [],
      api: null,
      error: null,
    };

    try {
      const targets = await fetchTargets(config.cdpPort, { timeoutMs: 2000 });
      cdp.endpointUp = true;
      cdp.targets = targets.map((t) => ({ type: t.type, title: t.title, url: t.url }));
      const main = findMainTarget(targets);
      if (main) {
        cdp.mainTargetFound = true;
        cdp.mainTargetTitle = main.title;
        try {
          cdp.api = await withCdp(config, (ctx) => probeApi(ctx));
        } catch (err) {
          cdp.error = `已连上 target，但探测 preload API 失败：${err.message}`;
        }
      } else {
        cdp.error = '端点可达，但没有 title === "口袋修仙" 的 page target。';
      }
    } catch (err) {
      cdp.error = err.message;
    }

    return {
      ok: true,
      now: new Date().toISOString(),
      config: {
        gameExe: config.gameExe,
        cdpPort: config.cdpPort,
        guiHost: config.guiHost,
        guiPort: config.guiPort,
        backupDir: config.backupDir,
        saveRoot,
        playerUidConfigured: config.playerUid || null,
        sources: config.sources,
      },
      saveRootExists,
      saveCount,
      playerUids,
      backups: listBackups(config.backupDir).length,
      catalog: {
        csvPath: cat.csvPath,
        rowCount: cat.rowCount,
        csvRowCount: cat.csvRowCount,
        parseErrors: cat.parseErrors.length,
        modsDir: cat.modsDir,
        workshopDir: cat.workshopDir,
        modCount: cat.modCount,
        localModCount: cat.localModCount,
        workshopModCount: cat.workshopModCount,
        modItemCount: cat.modItemCount,
        localItemCount: cat.localItemCount,
        workshopItemCount: cat.workshopItemCount,
        modCollisions: cat.modCollisions,
        mods: cat.mods,
        modErrors: cat.modErrors,
      },
      cdp,
    };
  }

  // ---- 活状态桥（/api/live/*）---------------------------------------------
  // 这条路改的是**游戏活内存**（window.__pocketCultivationE2E.patchWorldState），
  // 发放后游戏内即时生效，不需要重载存档；并且会立即真实落盘（发放前已强制自动备份）。

  /** 连上 CDP 主窗口 + 等活状态桥就绪，再把 ctx 交给 fn（收尾由 withCdp 负责）。 */
  async function withLiveBridge(fn, options = {}) {
    return withCdp(config, async (ctx) => {
      await waitForLiveBridge(ctx.client, ctx.contextId, {
        timeoutMs: options.bridgeTimeoutMs === undefined ? config.launchTimeoutMs : options.bridgeTimeoutMs,
        pollMs: options.pollMs,
      });
      return fn(ctx);
    });
  }

  async function liveStatusPayload() {
    const payload = {
      ok: true,
      now: new Date().toISOString(),
      cdp: {
        port: config.cdpPort,
        endpoint: `http://127.0.0.1:${config.cdpPort}/json/list`,
        endpointUp: false,
        mainTargetFound: false,
        mainTargetTitle: null,
        error: null,
      },
      bridge: {
        global: BRIDGE_GLOBAL,
        readyMember: BRIDGE_READY_MEMBER,
        members: BRIDGE_MEMBERS.slice(),
        present: null,
        ready: false,
        memberTypes: null,
        error: null,
      },
      summary: null,
      // 是否真的处于「已进入角色的会话」：主菜单/未载入存档时为 false。
      // 不在会话中时活体发放会被拒绝（inventoryItems 为空、bagFormations undefined，patch 不持久化）。
      inGame: null,
      session: null,
      human: '',
    };

    try {
      const targets = await fetchTargets(config.cdpPort, { timeoutMs: 3000 });
      payload.cdp.endpointUp = true;
      const target = findMainTarget(targets);
      if (!target) {
        payload.ok = false;
        payload.cdp.error =
          '未找到主窗口 target（判据：type === "page" && title === "口袋修仙"）。当前 targets：\n' +
          describeTargets(targets);
        return payload;
      }
      payload.cdp.mainTargetFound = true;
      payload.cdp.mainTargetTitle = target.title;
    } catch (err) {
      payload.ok = false;
      payload.cdp.error =
        `CDP 端点 127.0.0.1:${config.cdpPort} 不可达（${err.message}）。请先用本工具启动游戏，` +
        '或带 POCKET_DESKTOP_E2E=1、POCKET_DESKTOP_E2E_WINDOW_MODE=inactive 与 ' +
        'POCKET_DESKTOP_REMOTE_DEBUGGING_PORT 手动启动游戏。';
      return payload;
    }

    try {
      const got = await withLiveBridge(async (ctx) => {
        const probe = await probeLiveBridge(ctx.client, ctx.contextId);
        const summary = await readLiveWorldStateSummary(ctx.client, ctx.contextId);
        const session = await readLiveSessionStatus(ctx.client, ctx.contextId);
        return { probe, summary, session };
      });
      payload.bridge.present = got.probe.present;
      payload.bridge.ready = got.probe.ready;
      payload.bridge.memberTypes = got.probe.members;
      payload.summary = got.summary;
      payload.session = got.session;
      payload.inGame = got.session.inGame === true;
      payload.human = describeLiveSummary(got.summary);
    } catch (err) {
      payload.ok = false;
      payload.bridge.error = (err && err.message) || String(err);
    }
    return payload;
  }

  async function previewLiveGrant(body) {
    sweepPending();
    const grants = normalizeGrants(body && body.grants);

    // dryRun：只算不写。这里**绝不**调用 patchWorldState。
    const plan = await withLiveBridge((ctx) =>
      grantLiveItems(ctx.client, ctx.contextId, grants, { dryRun: true }),
    );

    const added = grants.map((g) => {
      const item = cat.getItem(g.templateNumericId);
      return {
        templateNumericId: g.templateNumericId,
        quantity: g.quantity,
        name: item ? item.name : '(道具表未收录)',
        category: item ? item.category : null,
        grade: item ? item.grade : null,
        cataloged: !!item,
      };
    });
    const uncatalogedIds = grants
      .filter((g) => !cat.isCataloged(g.templateNumericId))
      .map((g) => g.templateNumericId);

    const preview = {
      grants,
      added,
      addedTotal: plan.added.length,
      inventoryBefore: plan.before,
      inventoryAfter: plan.after,
      uncatalogedIds,
      newInstanceIds: plan.added.map((e) => e.instanceId),
      sampleElement: plan.added.length > 0 ? plan.added[0] : null,
    };

    const lines = [];
    lines.push('活体发放：改**游戏活内存**，发放后游戏内即时生效，**不需要**重载存档。');
    lines.push(`将发放 ${grants.length} 种道具，共 ${preview.addedTotal} 件：`);
    for (const a of added) {
      lines.push(`  + ${a.quantity} × ${a.name}（ID ${a.templateNumericId}${a.cataloged ? '' : '，道具表未收录'}）`);
    }
    if (uncatalogedIds.length > 0) {
      lines.push(`提示：以下 ID 不在 items.csv 里，仍会发放：${uncatalogedIds.join(', ')}`);
    }
    lines.push('');
    lines.push(`inventoryItems：${preview.inventoryBefore} → ${preview.inventoryAfter}（+${preview.addedTotal}）`);
    lines.push(`新增 instanceId ${preview.newInstanceIds.length} 个（每个元素一个，互不重复）`);
    lines.push(`元素样例：${JSON.stringify(preview.sampleElement)}`);
    lines.push('');
    lines.push('✅ 本路径改的是游戏活内存，但会**立即真实落盘**（发放前已自动备份存档），游戏退出后依然保留；无需重载存档。');
    lines.push('以上内容尚未写入。点「确认活体发放」后才会调 patchWorldState。');

    const previewToken = randomUUID();
    pending.set(previewToken, { kind: 'live', createdAt: Date.now(), grants, preview });

    log(`live preview ok: inventory ${plan.before} -> ${plan.after} (+${plan.added.length})`);
    return { ok: true, previewToken, expiresInMs: PREVIEW_TTL_MS, preview, human: lines.join('\n') };
  }

  async function applyLiveGrant(body) {
    sweepPending();
    const token = body && body.previewToken;
    if (!token) throw new Error('previewToken is required（必须先调 /api/live/grant/preview）');
    if (body.confirm !== true) throw new Error('confirm must be true（需要用户在界面上二次确认）');
    const entry = pending.get(token);
    if (!entry) throw new Error('previewToken 不存在或已过期（有效期 10 分钟），请重新预览。');
    if (entry.kind !== 'live') {
      throw new Error(
        'previewToken 不是活体发放的令牌，请重新走 /api/live/grant/preview。',
      );
    }

    // 活体发放是**真实写入**：patchWorldState 内部强制立即持久化，
    // 游戏会立即把新快照落盘。
    // 因此必须先备份，且**备份失败即中止、绝不 patch**（fail-closed）。
    const saveRoot = config.saveRoot || resolveSaveDir();
    const playerUid = config.playerUid || resolvePlayerUid({ rootDir: saveRoot });

    const outcome = await withLiveBridge(async (ctx) => {
      // 1) 先备份（强制步骤，失败即抛，绝不走到下面的 patch）。
      //    与 backup.mjs 导出（backupSave / backupSaveObject）同一套分支顺序：
      //    优先备份真实存档文件；找不到文件时退回「经 CDP 读回存档对象 → 备份成 JSON」。
      //
      //    ⚠️ 备份目标必须用 findActiveSaveFile，不能用 findLocalSaveFile：
      //    游戏载入的常常是 char_recovery_<hash>-…（更小但更新），
      //    但 findLocalSaveFile **排除** recovery/backup 角色并按体积取最大，
      //    会选中另一个更大的正式角色 save_manual_char_<name>_<hash>_…
      //    ⇒ 活体发放的「先备份」备份错了角色，备份保证形同虚设。
      //    活状态里没有 characterId/saveId，只能以「最近修改时间」定位当前载入的角色
      //    （游戏持续自动存档它）；故这里优先 findActiveSaveFile（不排除 recovery/backup，取 mtime 最大），
      //    findLocalSaveFile 仅作兜底。
      let backup = null;
      const localPath = findActiveSaveFile(playerUid, saveRoot) || findLocalSaveFile(playerUid, saveRoot);
      if (localPath) {
        backup = {
          ...backupSave(localPath, { dir: config.backupDir, label: 'pre-live-grant' }),
          kind: 'file',
        };
      } else {
        const readBack = await readSaveViaCdp(ctx, playerUid);
        const { save } = extractSave(readBack);
        if (!save) {
          throw new Error(
            '活体发放前备份失败：本地找不到存档文件，且经 CDP 读回存档对象也失败。' +
              '已中止，未做任何 patch（fail-closed）。',
          );
        }
        backup = {
          ...backupSaveObject(save, {
            dir: config.backupDir,
            label: 'pre-live-grant',
            name: 'cdp-read-save',
          }),
          kind: 'object',
        };
      }

      // 2) 备份成功后才真正 patch（apply 时重新读一次活状态并重算新增元素，避免写入过期数据）。
      const result = await grantLiveItems(ctx.client, ctx.contextId, entry.grants, { dryRun: false });
      return { backup, result };
    });

    const { backup, result } = outcome;
    pending.delete(token);

    log(
      `live grant applied: inventory ${result.before} -> ${result.afterCount} (+${result.added.length}) ` +
        `verified=${result.verified} backup=${backup.path}`,
    );

    // 只有「写后重读校验通过」才算成功。校验失败时**不返回 2xx**（抛出 ⇒ 上层返回 500），
    // 以免把「patch 了但没持久化」误报成成功（这正是本次修复的缺陷）。
    if (result.verified !== true) {
      throw new Error(
        `活体发放未通过写后校验：applied=false, verified=false。` +
          `${result.reason || '写后重读的数量与期望不符'}。` +
          `发放前备份：${backup.path}（kind=${backup.kind}，${backup.bytes} B）。` +
          `请确认游戏已进入某个存档（角色会话）后重试。`,
      );
    }

    return {
      ok: true,
      applied: result.applied,
      verified: result.verified,
      playerUid,
      backupPath: backup.path,
      backupKind: backup.kind,
      backupBytes: backup.bytes,
      backupSource: backup.source,
      inventoryBefore: result.before,
      inventoryAfter: result.after,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      addedTotal: result.added.length,
      added: result.added,
      bridgeResult: result.result,
      reloadRequired: false,
      persisted: true,
      persistMode: 'immediate',
      message:
        '活体发放完成并通过写后校验：道具已进入当前运行的活状态，游戏内立即可见，无需重载存档。' +
        '本路径会**立即真实落盘**（游戏内部对活状态更新强制 persist:"immediate"，' +
        '无需等到下一次自动存档），因此退出游戏后这些道具依然保留；' +
        '发放前已自动备份存档（见 backupPath）。',
    };
  }

  // ---- 路由 ---------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${config.guiHost}:${config.guiPort}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      sendHtml(res, 200, renderHtml({ guiPort: config.guiPort, cdpPort: config.cdpPort }));
      return;
    }

    if (method === 'GET' && path === '/api/status') {
      sendJson(res, 200, await statusPayload());
      return;
    }

    if (method === 'GET' && path === '/api/items') {
      const q = url.searchParams.get('q') || '';
      const filters = {
        q,
        category: url.searchParams.get('category') || '',
        grade: url.searchParams.get('grade') || '',
        element: url.searchParams.get('element') || '',
        shapeSize: url.searchParams.get('shape') || '',
      };
      const items = cat.filterItems(filters);
      sendJson(res, 200, {
        ok: true,
        q,
        filters,
        facets: cat.facets(),
        rowCount: cat.rowCount,
        csvPath: cat.csvPath,
        parseErrors: cat.parseErrors.slice(0, 20),
        total: items.length,
        items: items.slice(0, MAX_ROWS).map((it) => ({
          templateNumericId: it.templateNumericId,
          name: it.name,
          category: it.category,
          grade: it.grade,
          element: it.element,
          shapeSize: it.shapeSize,
          price: it.price,
          isObtainable: it.isObtainable,
          description: it.description,
        })),
        truncated: items.length > MAX_ROWS,
      });
      return;
    }

    if (method === 'GET' && path === '/api/saves') {
      const saveRoot = config.saveRoot || resolveSaveDir();
      let rows = [];
      try { rows = listSaves(saveRoot); } catch { rows = []; }
      const playerUid = resolvePlayerUid({ rootDir: saveRoot });
      sendJson(res, 200, {
        ok: true,
        saveRoot,
        playerUid,
        playerUids: detectPlayerUids(saveRoot),
        total: rows.length,
        saves: rows.slice(0, MAX_ROWS).map((r) => ({
          path: r.path,
          fileName: r.fileName,
          rawName: r.rawName,
          size: r.size,
          inShortDir: r.inShortDir,
        })),
        truncated: rows.length > MAX_ROWS,
      });
      return;
    }

    if (method === 'GET' && path === '/api/backups') {
      sendJson(res, 200, { ok: true, dir: config.backupDir, backups: listBackups(config.backupDir) });
      return;
    }

    // 只读便利端点：直接看当前存档摘要（不写盘）。
    if (method === 'GET' && path === '/api/save/current') {
      const saveRoot = config.saveRoot || resolveSaveDir();
      const playerUid = url.searchParams.get('playerUid') || config.playerUid || resolvePlayerUid({ rootDir: saveRoot });
      if (!playerUid) throw new Error('无法确定 playerUid');
      const result = await withCdp(config, (ctx) => readSaveViaCdp(ctx, playerUid));
      const { save } = extractSave(result);
      sendJson(res, 200, {
        ok: !!save,
        playerUid,
        summary: save ? summarizeSave(save) : null,
        verify: save ? verifyHashes(save) : null,
        recomputed: save ? computeHashes(save) : null,
      });
      return;
    }

    // ---- 活体发放（/api/live/*）：改游戏活内存，即时生效，且会立即真实落盘（发放前强制备份） ----

    // 只读：活状态摘要（游戏没开/桥没挂时返回 ok:false + error，不抛）。
    if (method === 'GET' && path === '/api/live/status') {
      sendJson(res, 200, await liveStatusPayload());
      return;
    }

    // 步骤 1：算「将要新增什么」，**不写**。
    if (method === 'POST' && path === '/api/live/grant/preview') {
      const body = await readJsonBody(req);
      sendJson(res, 200, await previewLiveGrant(body));
      return;
    }

    // 步骤 2：真正调 patchWorldState（须带 confirm:true + previewToken）。
    if (method === 'POST' && path === '/api/live/grant/apply') {
      const body = await readJsonBody(req);
      sendJson(res, 200, await applyLiveGrant(body));
      return;
    }

    sendJson(res, 404, { ok: false, error: `no route for ${method} ${path}` });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = (err && err.message) || String(err);
      log(`error ${req.method} ${req.url}: ${message}`);
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      sendJson(res, 500, { ok: false, error: message });
    });
  });

  return {
    server,
    pending,
    /** 只监听回环地址（config.mjs 已强制 guiHost 是回环）。 */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          if (err && err.code === 'EADDRINUSE') {
            reject(new Error(`GUI 端口 ${config.guiPort} 已被占用；用 --gui-port 换一个。`));
            return;
          }
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const addr = server.address();
          resolve({ host: config.guiHost, port: addr && addr.port ? addr.port : config.guiPort, url: this.url });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.guiPort, config.guiHost);
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
    get url() {
      return `http://${config.guiHost}:${config.guiPort}/`;
    },
    get address() {
      const a = server.address();
      return a && typeof a === 'object' ? a : null;
    },
  };
}

export default createGuiServer;
