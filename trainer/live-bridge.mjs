/**
 * trainer/live-bridge.mjs —— 「活状态桥」CDP 客户端（零第三方依赖）
 *
 * 游戏渲染层在主世界 execution context 暴露全局对象：
 *   window.__pocketCultivationE2E
 * 实测 9 个成员全部是 function：
 *   startSingleGame, readWorldState, readActiveSingleGameStatus, readEffectiveWorldState,
 *   advanceJourneyCultivation, setGmTimeSpeed, pauseJourneyBreakthroughTransport,
 *   lockJourneyBreakthroughResult, patchWorldState
 *
 * 硬事实（勿凭直觉改）：
 *   - `patchWorldState` 是**顶层键浅合并**（等价于 applyLocalSnapshot）：
 *     入参直接与当前状态顶层合并，不需要 `player` 前缀，也不是深合并。
 *   - `readWorldState()` 返回 87 个顶层键的**扁平**对象，**没有 `player` 键**；
 *     `inventoryItems` 是数组（实测长度 2181），元素形状：
 *       { instanceId, templateNumericId, isNew, infusedEffects, effectComprehension }
 *     ⇒ 与 grant.mjs `materializeOne` 产出的形状完全一致（无 row/col）。
 *   - 桥的安装时机**不稳定**：实测 19197ms 时 typeof 仍为 "undefined"、19917ms 才变 "object"；
 *     另一次约 4973ms 可见；还有一次 21s 仍未出现。
 *     ⇒ **必须轮询** `patchWorldState` 是否为 function，不能一次性探测后放弃。
 *   - 启动游戏必须同时注入三个环境变量（见 config.mjs 与 discovery.mjs buildLaunchEnv）：
 *       POCKET_DESKTOP_REMOTE_DEBUGGING_PORT=<正整数>
 *       POCKET_DESKTOP_E2E=1
 *       POCKET_DESKTOP_E2E_WINDOW_MODE=inactive
 *
 * 本模块只做「薄封装 + 轮询 + 校验」，不做任何存档读写。
 * ⚠️ `patchLiveWorldState` / `grantLiveItems({ dryRun: false })` 会**真的改游戏运行时状态**。
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { DEFAULT_LAUNCH_TIMEOUT_MS } from './config.mjs';
import { connectAndGetContext, evaluateJson } from './cdp-client.mjs';
import { waitForMainTarget } from './discovery.mjs';
import { buildGrantedElements } from './grant.mjs';

/** 活状态桥全局名（含 window. 前缀，便于直接拼表达式）。 */
export const BRIDGE_GLOBAL = 'window.__pocketCultivationE2E';

/** 判定桥「可用」的成员名。 */
export const BRIDGE_READY_MEMBER = 'patchWorldState';

/** 判定「是否在角色会话中」所用的桥成员（未进入单局时返回 null）。 */
export const SESSION_STATUS_MEMBER = 'readActiveSingleGameStatus';

/** 桥的 9 个已知成员（实测全部为 function）。 */
export const BRIDGE_MEMBERS = Object.freeze([
  'startSingleGame',
  'readWorldState',
  'readActiveSingleGameStatus',
  'readEffectiveWorldState',
  'advanceJourneyCultivation',
  'setGmTimeSpeed',
  'pauseJourneyBreakthroughTransport',
  'lockJourneyBreakthroughResult',
  'patchWorldState',
]);

/** 等桥超时默认值（与启动超时一致：90s）。 */
export const DEFAULT_BRIDGE_TIMEOUT_MS = DEFAULT_LAUNCH_TIMEOUT_MS;

/** 轮询间隔默认值（ms）。 */
export const DEFAULT_BRIDGE_POLL_MS = 500;

/** 摘要里额外抓取的标量键（不存在则给 null，绝不编造）。 */
export const SUMMARY_SCALAR_KEYS = Object.freeze([
  'bagSize',
  'realmId',
  'realmLayer',
  'cultivation',
  'spiritStones',
  'snapshotVersion',
  'playerType',
]);

/** 判定「桥就绪」的表达式（不用可选链，避免个别引擎差异）。 */
const READY_EXPR =
  `!!${BRIDGE_GLOBAL} && typeof ${BRIDGE_GLOBAL}.${BRIDGE_READY_MEMBER} === 'function'`;

/** 把任意 JS 值安全注入页面表达式的字面量：JSON.parse("<转义后的 JSON 文本>")。 */
function jsonArg(value) {
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 只保留标量；对象/数组/undefined/null 一律归为 null（不编造）。 */
function scalarOrNull(value) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  return null;
}

/** 组装 evaluateJson 的 options（contextId 为 null/undefined 时不传）。 */
function evalOptions(contextId, extra) {
  const opts = { ...(extra || {}) };
  if (contextId !== undefined && contextId !== null) opts.contextId = contextId;
  return opts;
}

/**
 * 轮询等待活状态桥就绪。
 *
 * @param {{send: Function}} client CdpClient 或任何具备 send() 的对象
 * @param {number|string|null} contextId 主世界 execution context id
 * @param {{timeoutMs?: number, pollMs?: number, onPoll?: Function, sleepFn?: Function}} [options]
 * @returns {Promise<true>} 就绪时返回 true；超时抛错
 */
export async function waitForLiveBridge(client, contextId, options = {}) {
  if (!client || typeof client.send !== 'function') {
    throw new Error('waitForLiveBridge: client with a send() method is required');
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_BRIDGE_TIMEOUT_MS : options.timeoutMs;
  const pollMs = options.pollMs === undefined ? DEFAULT_BRIDGE_POLL_MS : options.pollMs;
  const sleepFn = typeof options.sleepFn === 'function' ? options.sleepFn : sleep;
  const onPoll = typeof options.onPoll === 'function' ? options.onPoll : null;

  const startedAt = Date.now();
  let polls = 0;
  let lastError = null;

  for (;;) {
    polls += 1;
    let ready = false;
    try {
      ready = (await evaluateJson(client, READY_EXPR, evalOptions(contextId))) === true;
      if (ready) lastError = null;
    } catch (err) {
      // 桥尚未安装时求值本身可能抛错（例如 context 尚未就绪）——记录但不致命，继续轮询。
      lastError = err;
      ready = false;
    }

    const waitedMs = Date.now() - startedAt;

    if (onPoll) {
      try {
        onPoll({ polls, waitedMs, ready, lastError });
      } catch {
        // 观察者自身的异常不得影响轮询主流程。
      }
    }

    if (ready) return true;

    if (waitedMs >= timeoutMs) {
      const suffix = lastError ? `；最近一次求值错误：${lastError.message}` : '';
      throw new Error(
        `waitForLiveBridge: 等待活状态桥超时（已等待 ${waitedMs} ms，轮询 ${polls} 次，timeoutMs=${timeoutMs}）：` +
          `${BRIDGE_GLOBAL}.${BRIDGE_READY_MEMBER} 仍不是 function${suffix}`,
      );
    }

    const remain = timeoutMs - waitedMs;
    await sleepFn(Math.max(1, Math.min(pollMs, remain)));
  }
}

/**
 * 只读探测桥：是否出现、是否就绪、9 个成员各自的 typeof。
 * 不抛错（桥不存在时返回 present:false）。
 */
export async function probeLiveBridge(client, contextId, options = {}) {
  const expr =
    `(() => { const g = ${BRIDGE_GLOBAL};` +
    ` if (!g) return { present: false, ready: false, members: {} };` +
    ` const names = ${JSON.stringify(BRIDGE_MEMBERS)};` +
    ` const members = {};` +
    ` for (const n of names) members[n] = typeof g[n];` +
    ` return { present: true, ready: typeof g[${JSON.stringify(BRIDGE_READY_MEMBER)}] === 'function', members };` +
    ` })()`;
  return evaluateJson(client, expr, evalOptions(contextId, options));
}

/**
 * 读取完整活状态（扁平对象，87 个顶层键）。
 * 数据量较大（inventoryItems 实测 2181 元素），仅在确实需要全量时调用。
 */
export async function readLiveWorldState(client, contextId, options = {}) {
  const state = await evaluateJson(
    client,
    `${BRIDGE_GLOBAL}.readWorldState()`,
    evalOptions(contextId, options),
  );
  if (!isPlainObject(state)) {
    throw new Error(
      `readLiveWorldState: ${BRIDGE_GLOBAL}.readWorldState() did not return a plain object (got ${typeName(state)})`,
    );
  }
  return state;
}

/**
 * 纯函数：把完整活状态压成摘要。键不存在给 null，不编造。
 * 与 readLiveWorldStateSummary 的页面内投影保持同一形状。
 */
export function summarizeLiveWorldState(state) {
  if (!isPlainObject(state)) {
    throw new Error(`summarizeLiveWorldState: expected a plain object (got ${typeName(state)})`);
  }
  const summary = {
    keyCount: Object.keys(state).length,
    inventoryItemsLength: Array.isArray(state.inventoryItems) ? state.inventoryItems.length : null,
    placedItemsLength: Array.isArray(state.placedItems) ? state.placedItems.length : null,
    hasPlayerKey: Object.prototype.hasOwnProperty.call(state, 'player'),
    bagFormationsType: typeName(state.bagFormations),
  };
  for (const key of SUMMARY_SCALAR_KEYS) {
    summary[key] = scalarOrNull(state[key]);
  }
  return summary;
}

/**
 * 读取活状态摘要。摘要在**页面内**算好再回传，避免把 2000+ 元素整体搬过 CDP。
 * 形状与 summarizeLiveWorldState 完全一致。
 */
export async function readLiveWorldStateSummary(client, contextId, options = {}) {
  const expr =
    `(() => { const s = ${BRIDGE_GLOBAL}.readWorldState();` +
    ` if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('readWorldState() did not return an object');` +
    ` const keys = ${JSON.stringify(SUMMARY_SCALAR_KEYS)};` +
    ` const out = {` +
    ` keyCount: Object.keys(s).length,` +
    ` inventoryItemsLength: Array.isArray(s.inventoryItems) ? s.inventoryItems.length : null,` +
    ` placedItemsLength: Array.isArray(s.placedItems) ? s.placedItems.length : null,` +
    ` hasPlayerKey: Object.prototype.hasOwnProperty.call(s, 'player'),` +
    ` bagFormationsType: Array.isArray(s.bagFormations) ? 'array' : (s.bagFormations === null ? 'null' : typeof s.bagFormations)` +
    ` };` +
    ` for (const k of keys) { const v = s[k]; out[k] = (v === null || v === undefined) ? null : ((typeof v === 'object') ? null : v); }` +
    ` return out;` +
    ` })()`;
  const summary = await evaluateJson(client, expr, evalOptions(contextId, options));
  if (!isPlainObject(summary)) {
    throw new Error(`readLiveWorldStateSummary: page returned ${typeName(summary)} instead of an object`);
  }
  return summary;
}

/**
 * 只读：判定游戏是否真的处于「已进入角色的会话」。
 *
 * 判据（唯一）：`bagFormations` 已定义（是 object 或 array）。
 *   依据：未进入角色时 `bagFormations` 为 `"undefined"`，进入角色后是 object。
 *
 * ⚠️ 反证（游戏已载入角色会话时）：
 *   `GET /api/live/status` 报 `bagFormationsType="object"`、`keyCount=86`、
 *   `inventoryItemsLength=2182`、`bagSize=7`，而 `readActiveSingleGameStatus()` 仍返回 null/undefined。
 *   ⇒ `readActiveSingleGameStatus` **不是**可靠的「在会话中」信号，**绝不能用它来 gate patch**
 *   （否则会误拒合法发放）。它只作为诊断字段返回（activeSingleGameStatusPresent）。
 *
 * 在页面内算好再回传，不把 2000+ 元素搬过 CDP。
 *
 * @returns {Promise<{inGame:boolean, activeSingleGameStatusPresent:boolean,
 *   bagFormationsType:string|null, keyCount:number|null, inventoryItemsLength:number|null,
 *   statusError:string|null}>}
 */
export async function readLiveSessionStatus(client, contextId, options = {}) {
  const expr =
    `(() => { const g = ${BRIDGE_GLOBAL};` +
    ` let status = null, statusError = null;` +
    ` try { status = g.${SESSION_STATUS_MEMBER}(); } catch (e) { statusError = String((e && e.message) || e); }` +
    ` let bagFormationsType = null, keyCount = null, inventoryItemsLength = null;` +
    ` try { const s = g.readWorldState();` +
    `   bagFormationsType = Array.isArray(s.bagFormations) ? 'array' : (s.bagFormations === null ? 'null' : typeof s.bagFormations);` +
    `   keyCount = Object.keys(s).length;` +
    `   inventoryItemsLength = Array.isArray(s.inventoryItems) ? s.inventoryItems.length : null;` +
    ` } catch (e) { if (statusError === null) statusError = String((e && e.message) || e); }` +
    ` const activeSingleGameStatusPresent = (status !== null && status !== undefined);` +
    ` const bagFormationsDefined = (bagFormationsType === 'object' || bagFormationsType === 'array');` +
    ` return { inGame: bagFormationsDefined,` +
    `   activeSingleGameStatusPresent, bagFormationsType, keyCount, inventoryItemsLength, statusError };` +
    ` })()`;
  const out = await evaluateJson(client, expr, evalOptions(contextId, options));
  if (!isPlainObject(out)) {
    throw new Error(`readLiveSessionStatus: page returned ${typeName(out)} instead of an object`);
  }
  return out;
}

/** 一行文本摘要，便于 CLI/GUI 打印。 */
export function describeLiveSummary(summary) {
  if (!isPlainObject(summary)) return String(summary);
  return (
    `keys=${summary.keyCount}` +
    ` inventoryItems=${summary.inventoryItemsLength}` +
    ` placedItems=${summary.placedItemsLength}` +
    ` bagSize=${summary.bagSize}` +
    ` realm=${summary.realmId}/${summary.realmLayer}` +
    ` cultivation=${summary.cultivation}` +
    ` spiritStones=${summary.spiritStones}` +
    ` snapshotVersion=${summary.snapshotVersion}` +
    ` playerType=${JSON.stringify(summary.playerType)}`
  );
}

/**
 * ⚠️ 写操作：把 patch 顶层浅合并进活状态（等价于游戏内 applyLocalSnapshot）。
 * 表达式用 JSON.parse(<字面量>) 注入，避免引号/注入问题。
 */
export async function patchLiveWorldState(client, contextId, patch, options = {}) {
  if (!isPlainObject(patch)) {
    throw new Error(`patchLiveWorldState: patch must be a plain object (got ${typeName(patch)})`);
  }
  return evaluateJson(
    client,
    `${BRIDGE_GLOBAL}.${BRIDGE_READY_MEMBER}(${jsonArg(patch)})`,
    evalOptions(contextId, options),
  );
}

/**
 * ⚠️ 发放道具到**活状态**（游戏内即时生效，不写存档）。
 *
 * @param {{send: Function}} client
 * @param {number|string|null} contextId
 * @param {Array<{templateNumericId: number, quantity?: number}>} grants
 * @param {{dryRun?: boolean}} [options] dryRun=true 时只算不写（默认 false）
 * @returns {Promise<{added: Array<object>, before: number, after: number,
 *   beforeCount: number, afterCount: number|null, dryRun: boolean, applied: boolean,
 *   verified: boolean, reason: string|null, result: any}>}
 *   - dryRun: 不 patch、不校验、不写盘；`applied:false, verified:false`。
 *   - 非 dryRun: 先过「是否在角色会话」闸门，patch 后**重读活状态校验**
 *     `inventoryItems` 是否恰好增长 `added.length`；只有校验通过才 `applied:true, verified:true`，
 *     否则 `applied:false, verified:false` 并给出 `reason`。
 */
export async function grantLiveItems(client, contextId, grants, options = {}) {
  const dryRun = options.dryRun === true;

  if (!Array.isArray(grants)) {
    throw new Error('grantLiveItems: grants must be an array');
  }
  for (const g of grants) {
    if (!isPlainObject(g)) {
      throw new Error('grantLiveItems: each grant must be an object');
    }
    if (!Number.isInteger(g.templateNumericId) || g.templateNumericId <= 0) {
      throw new Error(`grantLiveItems: invalid templateNumericId ${JSON.stringify(g.templateNumericId)}`);
    }
    if (g.quantity !== undefined && (!Number.isInteger(g.quantity) || g.quantity <= 0)) {
      throw new Error(
        `grantLiveItems: invalid quantity ${JSON.stringify(g.quantity)} for template ${g.templateNumericId}`,
      );
    }
  }

  const state = await readLiveWorldState(client, contextId, options);
  const inventoryItems = state.inventoryItems;
  if (!Array.isArray(inventoryItems)) {
    throw new Error(
      `grantLiveItems: live world state .inventoryItems is not an array (got ${typeName(inventoryItems)})`,
    );
  }
  const placedItems = Array.isArray(state.placedItems) ? state.placedItems : [];

  // 适配层：grant.mjs 只认 saveObj.snapshot 前缀；活状态是扁平的，这里包一层。
  const adapted = { snapshot: { inventoryItems, placedItems } };
  const built = buildGrantedElements(adapted, grants);
  const added = Array.isArray(built) ? built : (built && built.added);
  if (!Array.isArray(added)) {
    throw new Error('grantLiveItems: buildGrantedElements did not yield an added[] array');
  }

  const before = inventoryItems.length;
  const after = before + added.length;

  if (dryRun) {
    // dry-run：不 patch、不校验、不写盘（只算将要新增什么）。
    return {
      added,
      before,
      after,
      beforeCount: before,
      afterCount: null,
      dryRun: true,
      applied: false,
      verified: false,
      reason: null,
      result: null,
    };
  }

  // ---- 预检闸门：必须真的在「已进入角色的会话」里，否则 patch 不会持久化 ----
  // 判据只用活状态形状 bagFormationsDefined（object/array）。
  // 反证：已载入角色的会话里 readActiveSingleGameStatus() 仍为 null，
  // 而 bagFormations 是 object、keyCount=86、inventoryItemsLength=2182 ⇒ 该成员不可靠，不作判据。
  const session = await readLiveSessionStatus(client, contextId, options);
  if (!session.inGame) {
    throw new Error(
      'grantLiveItems: 尚未进入角色会话，已拒绝 patch（活体发放只在游戏内的角色会话中生效；' +
        '主菜单/未载入存档时 bagFormations 为 undefined，patch 不会持久化）。' +
        '请先在游戏里进入一个存档（角色），再重试。' +
        ` 当前：bagFormationsType=${JSON.stringify(session.bagFormationsType)}` +
        ` keyCount=${session.keyCount}` +
        ` inventoryItemsLength=${session.inventoryItemsLength}` +
        `（诊断，非判据：activeSingleGameStatusPresent=${session.activeSingleGameStatusPresent}）` +
        `${session.statusError ? ` statusError=${session.statusError}` : ''}`,
    );
  }

  const result = await patchLiveWorldState(
    client,
    contextId,
    { inventoryItems: [...inventoryItems, ...added] },
    options,
  );

  // ---- 写后校验：重读活状态，确认 inventoryItems 恰好增长 added.length ----
  let afterCount = null;
  let verifyError = null;
  try {
    const reread = await readLiveWorldState(client, contextId, options);
    afterCount = Array.isArray(reread.inventoryItems) ? reread.inventoryItems.length : null;
  } catch (err) {
    verifyError = (err && err.message) || String(err);
  }

  const verified = afterCount === after;
  const reason = verified
    ? null
    : verifyError
      ? `写后重读活状态失败：${verifyError}`
      : `写后重读 inventoryItems 数量为 ${afterCount}，期望 ${after}` +
        `（before ${before} + added ${added.length}）`;

  return {
    added,
    before,
    after,
    beforeCount: before,
    afterCount,
    dryRun: false,
    applied: verified,
    verified,
    reason,
    result,
  };
}

/**
 * 便捷函数：等主窗口 → 连 CDP 取主 context → （默认）等活状态桥就绪。
 *
 * @param {number} port CDP 端口
 * @returns {Promise<{client, contextId, context, contexts, target, targets, unsubscribe, port}>}
 */
export async function connectLive(port, options = {}) {
  const launchTimeoutMs = options.launchTimeoutMs === undefined ? DEFAULT_LAUNCH_TIMEOUT_MS : options.launchTimeoutMs;
  const host = options.host === undefined ? '127.0.0.1' : options.host;
  const label = options.label === undefined ? 'live-bridge' : options.label;
  const waitForBridge = options.waitForBridge !== false;

  const found = await waitForMainTarget(port, launchTimeoutMs, { host });
  const conn = await connectAndGetContext(found.target, {
    timeoutMs: options.cdpTimeoutMs,
    contextTimeoutMs: options.contextTimeoutMs,
    label,
  });

  if (waitForBridge) {
    try {
      await waitForLiveBridge(conn.client, conn.contextId, {
        timeoutMs: options.bridgeTimeoutMs,
        pollMs: options.bridgePollMs,
        onPoll: options.onPoll,
      });
    } catch (err) {
      closeLive(conn);
      throw err;
    }
  }

  return { ...conn, targets: found.targets, port };
}

/** 收尾：注销事件监听并关闭 WebSocket（各自吞异常）。 */
export function closeLive(conn) {
  if (!conn) return;
  try {
    if (typeof conn.unsubscribe === 'function') conn.unsubscribe();
  } catch {
    // 收尾阶段的异常不向上抛。
  }
  try {
    if (conn.client && typeof conn.client.close === 'function') conn.client.close();
  } catch {
    // 同上。
  }
}

export default {
  BRIDGE_GLOBAL,
  BRIDGE_READY_MEMBER,
  BRIDGE_MEMBERS,
  SESSION_STATUS_MEMBER,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  DEFAULT_BRIDGE_POLL_MS,
  SUMMARY_SCALAR_KEYS,
  waitForLiveBridge,
  probeLiveBridge,
  readLiveWorldState,
  readLiveWorldStateSummary,
  readLiveSessionStatus,
  summarizeLiveWorldState,
  describeLiveSummary,
  patchLiveWorldState,
  grantLiveItems,
  connectLive,
  closeLive,
};
