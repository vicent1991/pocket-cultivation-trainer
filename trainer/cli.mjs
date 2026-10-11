#!/usr/bin/env node
/**
 * cli.mjs —— 命令行入口。零第三方依赖。
 *
 *   node cli.mjs serve            起本地 GUI（默认 http://127.0.0.1:17321/）
 *   node cli.mjs read [--attach]  只读：启动游戏 → CDP 读回存档 → 与本地存档 hash 比对
 *   node cli.mjs check            静态自检（绝不启动游戏、绝不写盘）
 *   node cli.mjs live status [--port <n>]                          只读：连活状态桥并打印摘要
 *   node cli.mjs live probe  [--port <n>]                          只读：打印桥是否存在与 9 个成员类型
 *   node cli.mjs live grant  --item <id> [--quantity N] [--port <n>] [--no-dry-run]
 *                                 默认 dry-run（只算不写）；只有显式 --no-dry-run 才真写活状态
 *
 * 只读保证：
 *   - `read` 只调用 `localSave.read`（外加顶层只读的 `getRuntimeConfig`），**从不**调用
 *     `localSave.write` / `remove` / `renameSummary` / `importDemoSaves`。
 *   - `check` 完全不碰游戏进程，只读本地文件。
 *   - `live status` / `live probe` 只读；`live grant` **默认 dry-run**，不碰活状态。
 *   - 会改游戏状态的两条路：`live grant --no-dry-run`（改活内存，游戏内即时生效）与
 *     GUI 的 `/api/live/grant/apply`（同样改活内存，需两步确认 + 强制先备份）。
 */

import { existsSync } from 'node:fs';
import process from 'node:process';

import {
  USAGE,
  describeConfig,
  resolveConfig,
} from './config.mjs';
import {
  describeTargets,
  findMainTarget,
  isPortOpen,
  killGame,
  launchGame,
  waitForEndpoint,
  waitForMainTarget,
  waitForPortClosed,
} from './discovery.mjs';
import { connectAndGetContext, evaluateJson } from './cdp-client.mjs';
import { computeHashes, verifyHashes } from './save-codec.mjs';
import { getCatalog } from './item-catalog.mjs';
import { createGuiServer } from './gui-server.mjs';
import { listSaves, readSave, resolveSaveDir } from './save-io.mjs';
import {
  API_GLOBAL,
  detectPlayerUids,
  extractSave,
  findLocalSaveFile,
  probeApi,
  readSaveViaCdp,
  resolvePlayerUid,
  resolveSaveIdentity,
  summarizeSave,
} from './save-bridge.mjs';
import {
  BRIDGE_GLOBAL,
  BRIDGE_MEMBERS,
  BRIDGE_READY_MEMBER,
  closeLive,
  connectLive,
  describeLiveSummary,
  grantLiveItems,
  probeLiveBridge,
  readLiveWorldStateSummary,
} from './live-bridge.mjs';

const SUBCOMMANDS = ['serve', 'read', 'check', 'live', 'help'];

/** `live` 子动作。 */
const LIVE_ACTIONS = ['status', 'probe', 'grant'];

function line(char = '-', n = 72) {
  return char.repeat(n);
}

function head(title) {
  console.log('');
  console.log(line('='));
  console.log(title);
  console.log(line('='));
}

function ok(msg) { console.log(`  [ok]   ${msg}`); }
function bad(msg) { console.log(`  [FAIL] ${msg}`); }
function info(msg) { console.log(`  ...    ${msg}`); }

function printConfig(config) {
  console.log('生效配置：');
  for (const l of describeConfig(config)) console.log(l);
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function cmdServe(config) {
  head('口袋修仙 · 外置修改器 — 本地 GUI');
  printConfig(config);

  const catalog = getCatalog(undefined, config.modsDir, config.workshopDir);
  console.log('');
  console.log(
    `道具表：${catalog.csvPath}（${catalog.rowCount} 行 = csv ${catalog.csvRowCount} + 本地模组 ${catalog.localItemCount} ` +
      `+ 创意工坊 ${catalog.workshopItemCount}，解析错误 ${catalog.parseErrors.length} 条）`,
  );

  const gui = createGuiServer({
    config,
    catalog,
    logger: (msg) => console.log(`  [gui] ${msg}`),
  });

  const addr = await gui.listen();
  console.log('');
  console.log(line('='));
  console.log(`GUI 已启动： ${addr.url}`);
  console.log(`只监听回环地址 ${addr.host}:${addr.port}（不对外网开放）`);
  console.log(line('='));
  console.log('使用方式：');
  console.log('  1. 先启动游戏（本工具或手动，必须带 POCKET_DESKTOP_E2E=1 + 调试端口）');
  console.log('  2. 浏览器打开上面的 URL');
  console.log('');
  console.log('★ 唯一路径：活体发放——直接改游戏活内存，游戏内即时生效、**无需重载存档**；');
  console.log('  发放前会自动备份存档，且游戏内部会**立即真实落盘**，退出游戏后依然保留。');
  console.log('  3. 在「道具搜索」里搜到道具点「加入」，或直接在「活体发放」区填 ID + 数量点「加入清单」');
  console.log('  4. 点「预览（只读，不改游戏）」确认发什么 → 再点「确认活体发放（立即生效）」');
  console.log('');
  console.log('按 Ctrl+C 关闭。');

  const shutdown = async () => {
    console.log('\n正在关闭 GUI ...');
    await gui.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => { /* 保持进程存活 */ });
}

// ---------------------------------------------------------------------------
// read（只读实机验证）
// ---------------------------------------------------------------------------

async function cmdRead(config, { attach = false } = {}) {
  head('只读实机验证：CDP localSave.read  vs  本地存档文件');
  printConfig(config);
  console.log('');
  console.log('本命令**只读**：只会调用 localSave.read，绝不写盘。');

  let handle = null;
  let launched = false;
  const cleanup = [];

  try {
    if (attach) {
      info(`--attach：复用已在运行的游戏，只连 127.0.0.1:${config.cdpPort}，不自行启动。`);
      const up = await isPortOpen(config.cdpPort, { timeoutMs: 1500 });
      if (!up) {
        throw new Error(
          `CDP 端点 127.0.0.1:${config.cdpPort} 不可达。请先用 POCKET_DESKTOP_E2E=1 与 ` +
            'POCKET_DESKTOP_REMOTE_DEBUGGING_PORT 启动游戏，或去掉 --attach 让本工具自己启动。',
        );
      }
    } else {
      if (!config.gameExe) {
        throw new Error(
          '未指定游戏主程序路径：请用 --game-exe 或环境变量 POCKET_TRAINER_GAME_EXE 指定 ' +
            'Pocket Cultivation.exe 的完整路径。',
        );
      }
      handle = launchGame({ exePath: config.gameExe, port: config.cdpPort });
      launched = true;
      // launchGame 用 child.on('error') 记录失败：异步 spawn 失败不会抛异常，只会把错误
      // 挂在 handle.spawnError 上，所以这里必须显式检查，否则会白等一个永远不来的端口。
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (handle.spawnError) {
        throw new Error(`启动游戏失败：${handle.spawnError.message || handle.spawnError}`);
      }
      if (!handle.pid) {
        throw new Error(`启动游戏失败：未取得 pid（exePath=${config.gameExe}）`);
      }
      cleanup.push(async () => {
        if (!handle || !handle.pid) return;
        info(`关闭游戏进程 pid=${handle.pid} ...`);
        killGame(handle.pid, { force: true });
        const closed = await waitForPortClosed(config.cdpPort, 20000);
        if (closed) ok(`端口 ${config.cdpPort} 已释放`);
        else bad(`端口 ${config.cdpPort} 在 20s 内仍未释放`);
      });
      console.log(`已启动游戏 pid=${handle.pid}`);
      console.log(`  注入 ${'POCKET_DESKTOP_E2E'}=1 与 POCKET_DESKTOP_REMOTE_DEBUGGING_PORT=${config.cdpPort}`);
      info(`等待 CDP 端点 127.0.0.1:${config.cdpPort} ...`);
      const t0 = Date.now();
      await waitForEndpoint(config.cdpPort, config.launchTimeoutMs, {
        onPoll: (attempt) => {
          if (attempt % 8 === 0) info(`  已轮询 ${attempt} 次（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        },
      });
      ok(`CDP 端点就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    const { target, targets } = await waitForMainTarget(config.cdpPort, config.cdpTimeoutMs, {
      onPoll: (attempt) => {
        if (attempt % 8 === 0) info(`  等待主窗口 target（第 ${attempt} 次）`);
      },
    });
    console.log('');
    console.log('发现 targets：');
    for (const t of describeTargets(targets).split('\n')) console.log(`  ${t}`);
    console.log('');
    ok(`主窗口 target 命中：title=${JSON.stringify(target.title)} type=${JSON.stringify(target.type)}`);
    console.log(`        url=${target.url}`);
    console.log(`        判据：type === "page" && title === ${JSON.stringify(config.gameTitle)}`);

    const ctx = await connectAndGetContext(target, {
      timeoutMs: config.cdpTimeoutMs,
      contextTimeoutMs: config.contextTimeoutMs,
      label: 'cli-read',
    });
    cleanup.push(async () => {
      try { ctx.unsubscribe(); } catch { /* ignore */ }
      try { ctx.client.close(); } catch { /* ignore */ }
    });
    ok(`WebSocket 已连接；executionContextId = ${ctx.contextId}（auxData.isDefault === true）`);
    console.log(`        共收到 ${ctx.contexts.length} 个 execution context`);

    const api = await probeApi(ctx);
    console.log('');
    if (!api.present) {
      throw new Error(`${API_GLOBAL} 不存在——可能连到了非主世界的 execution context。`);
    }
    ok(`${API_GLOBAL} 存在；localSave 方法：${api.localSaveKeys.join(', ')}`);
    console.log(`        顶层键：${api.topKeys.join(', ')}`);

    const saveRoot = config.saveRoot || resolveSaveDir();
    const playerUid = config.playerUid || resolvePlayerUid({ rootDir: saveRoot });
    if (!playerUid) throw new Error(`无法从 ${saveRoot} 反解出 playerUid，请用 --player-uid 显式指定。`);
    console.log('');
    ok(`playerUid = ${playerUid}（来源：${config.playerUid ? 'CLI/env 显式指定' : '存档目录 base64url 反解'}）`);
    console.log(`        候选：${detectPlayerUids(saveRoot).map((p) => `${p.playerUid}(${p.saveCount})`).join(', ') || '(无)'}`);

    // ---- 经 CDP 读存档（唯一一次读操作） ----
    console.log('');
    // 实际 payload 含 characterId/saveId（主进程用三者共同解析存档路径），不再是仅 playerUid。
    const identity = resolveSaveIdentity(playerUid, saveRoot);
    info(
      `调用 ${API_GLOBAL}.localSave.read({ playerUid: "${playerUid}", ` +
        `characterId: ${JSON.stringify(identity ? identity.characterId : null)}, ` +
        `saveId: ${JSON.stringify(identity ? identity.saveId : null)} }) ...`,
    );
    const readResult = await readSaveViaCdp(ctx, playerUid);
    const { save, wrapper } = extractSave(readResult);
    if (!save) {
      throw new Error(
        'localSave.read 的返回里没找到含 snapshot 的存档对象；返回顶层键：' +
          JSON.stringify(wrapper ? Object.keys(wrapper) : null),
      );
    }
    const cdpSummary = summarizeSave(save);
    const cdpVerify = verifyHashes(save);
    ok('localSave.read 返回了一个存档对象');
    console.log(`        rulesVersion=${cdpSummary.rulesVersion} sourceContentEdition=${JSON.stringify(cdpSummary.sourceContentEdition)}`);
    console.log(`        inventoryItems=${cdpSummary.inventoryCount} placedItems=${cdpSummary.placedCount} distinctTemplateIds=${cdpSummary.distinctTemplateIds}`);
    console.log(`        snapshotHash  = ${cdpSummary.snapshotHash}`);
    console.log(`        localSaveHash = ${cdpSummary.localSaveHash}`);
    console.log(`        页内自检 verifyHashes：${cdpVerify.ok ? '通过' : '不通过（' + cdpVerify.reason + '）'}`);

    // ---- 直接读本地存档文件，本地重算 hash ----
    console.log('');
    const localPath = findLocalSaveFile(playerUid, saveRoot);
    if (!localPath) throw new Error(`在 ${saveRoot} 下找不到 ${playerUid} 的本地存档文件。`);
    info(`直接读本地存档文件：${localPath}`);
    const localSave = readSave(localPath);
    const localVerify = verifyHashes(localSave);
    const localComputed = computeHashes(localSave);
    ok(`本地文件已读取（${JSON.stringify(localSave.snapshot ? Object.keys(localSave).length : 0)} 个顶层键）`);
    console.log(`        本地重算 snapshotHash  = ${localComputed.snapshotHash}`);
    console.log(`        本地重算 localSaveHash = ${localComputed.localSaveHash}`);
    console.log(`        本地自检 verifyHashes：${localVerify.ok ? '通过' : '不通过（' + localVerify.reason + '）'}`);

    // ---- 关键比对 ----
    console.log('');
    console.log(line('='));
    console.log('关键比对（CDP 读回 vs 本地重算）');
    console.log(line('='));
    const a = cdpSummary.snapshotHash;
    const b = localComputed.snapshotHash;
    console.log(`  CDP 读回 snapshotHash : ${a}`);
    console.log(`  本地重算 snapshotHash : ${b}`);
    console.log(`  逐字符相等            : ${a === b ? 'YES' : 'NO'}`);
    console.log(`  CDP localSaveHash     : ${cdpSummary.localSaveHash}`);
    console.log(`  本地重算 localSaveHash: ${localComputed.localSaveHash}`);
    console.log(`  逐字符相等            : ${cdpSummary.localSaveHash === localComputed.localSaveHash ? 'YES' : 'NO'}`);
    console.log(line('='));

    if (a !== b) {
      throw new Error('hash 不一致：CDP 读回的存档与本地文件不是同一份内容（可能游戏已自动存档，请重跑）。');
    }
    console.log('');
    console.log('验收通过：CDP localSave.read 读回的 snapshotHash 与本地存档文件用 save-codec.mjs 重算的结果逐字符相等。');
    return 0;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i -= 1) {
      const fn = cleanup[i];
      try { await fn(); } catch (err) { bad(`清理步骤失败：${err.message}`); }
    }
    if (launched) {
      const still = await isPortOpen(config.cdpPort, { timeoutMs: 1000 }).catch(() => false);
      if (still) bad(`警告：端口 ${config.cdpPort} 仍然开着`);
    }
  }
}

// ---------------------------------------------------------------------------
// check（静态自检，不碰游戏、不写盘）
// ---------------------------------------------------------------------------

async function cmdCheck(config) {
  head('静态自检（不启动游戏、不写盘）');
  let failures = 0;
  const t = (name, fn) => {
    try {
      const detail = fn();
      ok(`${name}${detail ? ' — ' + detail : ''}`);
    } catch (err) {
      failures += 1;
      bad(`${name} — ${err.message}`);
    }
  };

  console.log(`Node ${process.version}`);
  t('全局 fetch 可用', () => {
    if (typeof fetch !== 'function') throw new Error('global fetch is missing');
    return 'function';
  });
  t('全局 WebSocket 可用', () => {
    if (typeof WebSocket !== 'function') throw new Error('global WebSocket is missing');
    return 'function';
  });

  console.log('');
  printConfig(config);

  console.log('');
  t('游戏 exe 存在', () => {
    // 只读检查：existsSync 不修改任何东西。
    if (!config.gameExe) {
      throw new Error('未指定游戏 exe：请用 --game-exe 或环境变量 POCKET_TRAINER_GAME_EXE 指定');
    }
    if (!existsSync(config.gameExe)) throw new Error(`not found: ${config.gameExe}`);
    return config.gameExe;
  });

  t('道具表可加载', () => {
    const cat = getCatalog(undefined, config.modsDir, config.workshopDir);
    if (cat.parseErrors.length > 0) {
      throw new Error(`CSV 解析出现 ${cat.parseErrors.length} 条错误：${JSON.stringify(cat.parseErrors[0])}`);
    }
    const sample = cat.searchItems('丹');
    return `${cat.rowCount} 行；搜索「丹」命中 ${sample.length} 条`;
  });

  t('模组新增道具扫描', () => {
    const cat = getCatalog(undefined, config.modsDir, config.workshopDir);
    const label = (m) =>
      `${m.name}(${m.id}·${m.origin === 'workshop' ? `工坊${m.publishedFileId}` : '本地'}${m.enabled ? '' : '·已禁用'})`;
    const names = cat.mods.map(label).join('、');
    if (cat.mods.length === 0) {
      return `未发现模组（本地 ${config.modsDir || '(未配置)'}；创意工坊 ${config.workshopDir || '(未配置)'}）`;
    }
    for (const e of cat.modErrors.slice(0, 5)) {
      info(`模组文件错误（已跳过）：${e.file} — ${e.message}`);
    }
    const errNote = cat.modErrors.length ? `；文件错误 ${cat.modErrors.length} 条（已跳过，未影响目录）` : '';
    return (
      `${cat.modCount} 个模组（本地 ${cat.localModCount} + 创意工坊 ${cat.workshopModCount}）：${names}；` +
      `新增 ${cat.modItemCount} 件道具（本地 ${cat.localItemCount} + 创意工坊 ${cat.workshopItemCount}）` +
      `（catalog ${cat.csvRowCount} → ${cat.rowCount}，id 冲突 ${cat.modCollisions}）${errNote}`
    );
  });

  t('存档根目录存在', () => {
    const saveRoot = config.saveRoot || resolveSaveDir();
    const rows = listSaves(saveRoot);
    const real = rows.filter((r) => !r.inShortDir);
    return `${saveRoot}（存档文件 ${real.length} 个）`;
  });

  t('playerUid 可确定', () => {
    const saveRoot = config.saveRoot || resolveSaveDir();
    const uid = config.playerUid || resolvePlayerUid({ rootDir: saveRoot });
    if (!uid) throw new Error('无法反解 playerUid');
    const chars = detectPlayerUids(saveRoot).find((p) => p.playerUid === uid);
    return `${uid}${chars ? `（${chars.saveCount} 个存档，角色 ${chars.characters.length} 个）` : ''}`;
  });

  t('本地存档可读且 hash 自洽', () => {
    const saveRoot = config.saveRoot || resolveSaveDir();
    const uid = config.playerUid || resolvePlayerUid({ rootDir: saveRoot });
    if (!uid) throw new Error('无法反解 playerUid');
    const path = findLocalSaveFile(uid, saveRoot);
    if (!path) throw new Error('找不到本地存档文件');
    const save = readSave(path);
    const v = verifyHashes(save);
    if (!v.ok) throw new Error(`verifyHashes 不通过：${v.reason}`);
    const c = computeHashes(save);
    if (c.snapshotHash !== v.stored) {
      throw new Error(
        `重算 hash 与存档内存储的 hash 不一致（stored=${v.stored} recomputed=${c.snapshotHash}）`,
      );
    }
    return `${path}（snapshotHash=${c.snapshotHash.slice(0, 16)}…）`;
  });

  console.log('');
  if (failures > 0) {
    console.log(`${failures} 项自检失败。`);
    return 1;
  }
  console.log('全部自检通过。');
  return 0;
}

// ---------------------------------------------------------------------------
// live（活状态桥：直接改游戏活内存，游戏内即时生效）
// ---------------------------------------------------------------------------

/** 取 `--name value` 或 `--name=value` 的值；未出现返回 null。 */
function readFlag(argv, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === name) return i + 1 < argv.length ? argv[i + 1] : null;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

/** 会吃掉下一个 argv 的选项名（用于定位位置参数 action）。 */
const LIVE_VALUE_FLAGS = new Set([
  '--item',
  '--quantity',
  '--port',
  '--cdp-port',
  '--timeout',
  '--launch-timeout',
  '--game-exe',
  '--gui-port',
  '--gui-host',
  '--backup-dir',
  '--save-root',
  '--mods-dir',
  '--workshop-dir',
  '--player-uid',
]);

/** 从 argv 里取出 `live <action>` 的 action（跳过带值选项）。 */
function liveActionOf(argv) {
  const at = argv.indexOf('live');
  if (at < 0) return null;
  for (let i = at + 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (!a.includes('=') && LIVE_VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    return a;
  }
  return null;
}

async function cmdLive(config, { action, argv }) {
  head(`活状态桥：live ${action}`);
  printConfig(config);
  console.log('');
  console.log('本路径通过 CDP 直接改**游戏活内存**（window.__pocketCultivationE2E），发放后游戏内即时生效，');
  console.log('**不需要**重载存档（GUI 的「确认活体发放」是同一条路径）。');

  const up = await isPortOpen(config.cdpPort, { timeoutMs: 1500 });
  if (!up) {
    throw new Error(
      `CDP 端点 127.0.0.1:${config.cdpPort} 不可达。请先启动游戏，且必须**同时**注入 ` +
        'POCKET_DESKTOP_E2E=1、POCKET_DESKTOP_E2E_WINDOW_MODE=inactive、' +
        `POCKET_DESKTOP_REMOTE_DEBUGGING_PORT=${config.cdpPort}（缺窗口模式变量窗口永不显示，缺 E2E 变量 CDP 不生效）。`,
    );
  }
  info(`CDP 端点在线：127.0.0.1:${config.cdpPort}`);

  let conn = null;
  try {
    conn = await connectLive(config.cdpPort, {
      launchTimeoutMs: config.launchTimeoutMs,
      cdpTimeoutMs: config.cdpTimeoutMs,
      contextTimeoutMs: config.contextTimeoutMs,
      bridgeTimeoutMs: config.launchTimeoutMs,
      label: `cli-live-${action}`,
      onPoll: ({ polls, waitedMs }) => {
        if (polls === 1 || polls % 6 === 0) {
          info(`  等待活状态桥 … 第 ${polls} 次轮询（${(waitedMs / 1000).toFixed(1)}s）`);
        }
      },
    });
    ok(
      `已连主窗口 target（title=${JSON.stringify(conn.target && conn.target.title)}）；` +
        `executionContextId=${conn.contextId}`,
    );
    ok(`活状态桥 ${BRIDGE_GLOBAL}.${BRIDGE_READY_MEMBER} 已就绪`);

    if (action === 'probe') {
      const probe = await probeLiveBridge(conn.client, conn.contextId);
      console.log('');
      console.log(`present=${probe.present} ready=${probe.ready}`);
      for (const name of BRIDGE_MEMBERS) {
        console.log(`  ${String(name).padEnd(34)} ${probe.members[name]}`);
      }
      return 0;
    }

    const summary = await readLiveWorldStateSummary(conn.client, conn.contextId);
    console.log('');
    console.log(`活状态摘要：${describeLiveSummary(summary)}`);
    console.log(`  hasPlayerKey=${summary.hasPlayerKey} bagFormationsType=${summary.bagFormationsType}`);

    if (action === 'status') return 0;

    // ---- grant ----
    const rawItem = readFlag(argv, '--item');
    if (rawItem === null) throw new Error('live grant 需要 --item <templateNumericId>');
    const templateNumericId = Number.parseInt(String(rawItem).trim(), 10);
    if (!Number.isSafeInteger(templateNumericId) || templateNumericId <= 0) {
      throw new Error(`--item must be a positive integer, got ${JSON.stringify(rawItem)}`);
    }
    const rawQty = readFlag(argv, '--quantity');
    const quantity = rawQty === null ? 1 : Number.parseInt(String(rawQty).trim(), 10);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`--quantity must be a positive integer, got ${JSON.stringify(rawQty)}`);
    }

    // 安全默认：只有显式 --no-dry-run 才真写活状态。
    const noDryRun = argv.includes('--no-dry-run') || argv.includes('--no-dry-run=true');
    const dryRun = !noDryRun;

    console.log('');
    console.log(`发放请求：templateNumericId=${templateNumericId} quantity=${quantity}`);
    console.log(`模式：${dryRun ? 'dry-run（只算不写，默认）' : '⚠️ 真实写入活状态（--no-dry-run）'}`);

    const res = await grantLiveItems(conn.client, conn.contextId, [{ templateNumericId, quantity }], { dryRun });

    console.log(`inventoryItems：${res.before} → ${res.after}（新增 ${res.added.length}）`);
    console.log(`added 形状样例：${JSON.stringify(res.added[0] === undefined ? null : res.added[0])}`);
    console.log(`added 前 3 项：${JSON.stringify(res.added.slice(0, 3))}`);

    if (res.dryRun) {
      ok('dry-run 完成：**没有**调用 patchWorldState，游戏状态未改变。');
      info('确认真实发放请追加 --no-dry-run（会立即改变你正在玩的角色）。');
    } else {
      console.log(`写后重读 inventoryItems：${res.beforeCount} → ${res.afterCount}（期望 ${res.after}）`);
      console.log(`verified = ${res.verified}`);
      if (res.verified === true) {
        ok(`已写入活状态且写后校验通过；桥返回：${JSON.stringify(res.result)}`);
        info('发放已在游戏内生效，且会立即真实落盘（无需重载存档）。');
      } else {
        bad(`写后校验失败：applied=false, verified=false；原因：${res.reason || '写后重读数量与期望不符'}`);
        info('本次不算成功（退出码 1）。请确认游戏已进入某个存档（角色会话）后重试。');
        return 1;
      }
    }
    return 0;
  } finally {
    if (conn) closeLive(conn);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const rawArgv = process.argv.slice(2);
  const sub = rawArgv.find((a) => !a.startsWith('-')) || 'help';
  if (!SUBCOMMANDS.includes(sub)) {
    console.error(`未知子命令：${sub}`);
    console.error(USAGE);
    return 2;
  }
  if (sub === 'help') {
    console.log(USAGE);
    return 0;
  }

  const config = resolveConfig({ argv: rawArgv, env: process.env });
  const attach = rawArgv.includes('--attach') || rawArgv.includes('--attach=true');

  if (sub === 'serve') return await cmdServe(config);
  if (sub === 'read') return await cmdRead(config, { attach });
  if (sub === 'check') return await cmdCheck(config);
  if (sub === 'live') {
    const action = liveActionOf(rawArgv);
    if (!action || !LIVE_ACTIONS.includes(action)) {
      console.error(`live 需要动作：${LIVE_ACTIONS.join(' | ')}（收到 ${JSON.stringify(action)}）`);
      console.error(USAGE);
      return 2;
    }
    return await cmdLive(config, { action, argv: rawArgv });
  }
  return 2;
}

main()
  .then((code) => { process.exitCode = typeof code === 'number' ? code : 0; })
  .catch((err) => {
    console.error('');
    console.error(line('!'));
    console.error(`失败：${err && err.message ? err.message : String(err)}`);
    if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    console.error(line('!'));
    process.exitCode = 1;
  });
