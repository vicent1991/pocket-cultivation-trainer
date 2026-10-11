/**
 * selftest.mjs — 离线自检
 *
 * 流程（全部在系统临时目录内进行，**绝不写真实存档目录**）：
 *   1. 找一份真实存档（argv[2] 或自动探测），只读；
 *   2. 校验真实存档的既有 hash 能否被 computeSaveHash 复现 —— 这是「hash 算法与游戏字节级一致」的
 *      硬性依据（游戏写进去的 hash 值就是 golden）；
 *   3. 复制到 os.tmpdir() 下的独立目录；
 *   4. 在副本上：读 → grantItems 发 1 个道具 → normalizeSave → writeSaveAtomic → 再读回；
 *   5. 五项断言 + PASS/FAIL 摘要；
 *   6. 清理临时目录。
 *
 * 用法：
 *   node selftest.mjs                     # 自动探测真实存档
 *   node selftest.mjs <存档绝对路径>       # 指定存档
 *   node selftest.mjs --synthetic         # 不依赖真实存档，用合成最小档（只能验算法自洽）
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, statSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  computeHashes,
  computeSaveHash,
  normalizeSave,
  verifyHashes,
  canonicalize,
} from './save-codec.mjs';
import {
  resolveSaveDir,
  listSaves,
  readSave,
  writeSaveAtomic,
  encodeSaveFileName,
  decodeSaveFileName,
  saveDirExists,
} from './save-io.mjs';
import { getCatalog, loadCatalog, scanModItems, deriveShapeSize, DEFAULT_CSV_PATH } from './item-catalog.mjs';
import { CATEGORY_LABELS, ELEMENT_LABELS, GRADE_LABELS, shapeSizeLabel } from './item-labels.mjs';
import { grantItems, collectInstanceIds, findUncataloged } from './grant.mjs';
import {
  BRIDGE_GLOBAL,
  BRIDGE_MEMBERS,
  BRIDGE_READY_MEMBER,
  SUMMARY_SCALAR_KEYS,
  grantLiveItems,
  probeLiveBridge,
  readLiveSessionStatus,
  summarizeLiveWorldState,
  waitForLiveBridge,
} from './live-bridge.mjs';
import { buildLaunchEnv } from './discovery.mjs';
import { backupSave, backupSaveObject, listBackups } from './backup.mjs';
import { findActiveSaveFile, findLocalSaveFile } from './save-bridge.mjs';

// ---------------------------------------------------------------- 结果收集
const results = [];
let currentGroup = '(root)';
function group(name) { currentGroup = name; log(`\n== ${name} ==`); }
function log(msg) { process.stdout.write(msg + '\n'); }
function check(name, ok, detail = '') {
  results.push({ group: currentGroup, name, ok: !!ok, detail });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}

// ---------------------------------------------------------------- 定位真实存档
/** 已知的真实样本（manual 槽 1，最小最稳）。 */
const KNOWN_SAMPLE = join(
  resolveSaveDir(),
  '备份',
  'Y2hhcl9tdW8zZzVkNV8wMmI3MGVhMw',
  'c2F2ZV9tYW51YWxfY2hhcl9tdW8zZzVkNV8wMmI3MGVhM18xXzdjOWFjZjlk.json',
);

function findRealSave() {
  const argvPath = process.argv[2];
  if (argvPath && !argvPath.startsWith('--')) {
    if (!existsSync(argvPath)) throw new Error(`save not found: ${argvPath}`);
    return argvPath;
  }
  if (existsSync(KNOWN_SAMPLE)) return KNOWN_SAMPLE;
  // 退而求其次：递归找一个体积最小的 .json 存档
  try {
    const found = listSaves()
      .filter((s) => s.rawName && s.path.endsWith('.json') && !s.path.endsWith('.json.bak'))
      .sort((a, b) => a.size - b.size);
    if (found.length) return found[0].path;
  } catch { /* 忽略：走 synthetic */ }
  return null;
}

/** 合成一个最小但形状正确的存档，用于 --synthetic / 找不到真实档时。 */
function syntheticSave() {
  return {
    snapshot: {
      snapshotVersion: 26,
      bagSize: 7,
      realmId: 'nascentSoul',
      spiritStones: 18425,
      inventoryItems: [
        { instanceId: 'muvb3y85_hq7je', templateNumericId: 100001, isNew: false, infusedEffects: [], effectComprehension: { rootEffects: {} } },
      ],
      placedItems: [],
    },
    characterId: 'char_test_00000000',
    saveId: 'save_test_1_00000000',
    saveKind: 'manual',
    roleName: '幻梦',
    daoCode: 'D650471',
    rulesVersion: 13,
    sourceContentEdition: 'demo',
  };
}

// ---------------------------------------------------------------- live-bridge 假 client
/**
 * 构造一个**假 CDP client**：不连游戏，只在进程内按表达式分派。
 * 只实现 CdpClient 被用到的那个方法：send('Runtime.evaluate', { expression })。
 * 表达式都是 cdp-client.mjs 的 wrapAsyncExpression 包过的形态，故用子串判别。
 *
 * @param {{state: object, readyAfter?: number, activeSingleGameStatus?: any, ignorePatch?: boolean}} opts
 *   - activeSingleGameStatus: 模拟 `readActiveSingleGameStatus()` 的返回（默认非 null = 已进入单局）
 *   - ignorePatch: patchWorldState 返回 {success:true} 但**不**改 state（复现「无条件成功」缺陷）
 */
function makeFakeBridgeClient({
  state,
  readyAfter = 1,
  activeSingleGameStatus = { active: true },
  ignorePatch = false,
} = {}) {
  const calls = [];
  let polls = 0;
  const json = (value) => ({ result: { type: 'string', value: JSON.stringify(value) } });
  return {
    calls,
    get polls() { return polls; },
    get patchCalls() { return calls.filter((c) => c.kind === 'patch'); },
    get sessionCalls() { return calls.filter((c) => c.kind === 'session'); },
    async send(method, params) {
      if (method !== 'Runtime.evaluate') throw new Error(`fake client: unexpected method ${method}`);
      const expr = String(params.expression);

      // 1) patchWorldState(JSON.parse("<json>")) —— 唯一的写路径
      const m = expr.match(/patchWorldState\(JSON\.parse\(("(?:[^"\\]|\\.)*")\)\)/);
      if (m) {
        const patch = JSON.parse(JSON.parse(m[1]));
        calls.push({ kind: 'patch', patch });
        if (!ignorePatch) Object.assign(state, patch);
        return json({ success: true });
      }

      // 2) 就绪判定（READY_EXPR）
      if (expr.includes(`typeof ${BRIDGE_GLOBAL}.${BRIDGE_READY_MEMBER}`)) {
        polls += 1;
        return json(polls >= readyAfter);
      }

      // 2.5) readLiveSessionStatus：readActiveSingleGameStatus() + readWorldState() 的类型投影
      if (expr.includes('readActiveSingleGameStatus()')) {
        calls.push({ kind: 'session' });
        const bagFormationsType = Array.isArray(state.bagFormations)
          ? 'array'
          : state.bagFormations === null ? 'null' : typeof state.bagFormations;
        const statusPresent = activeSingleGameStatus !== null && activeSingleGameStatus !== undefined;
        const bagFormationsDefined = bagFormationsType === 'object' || bagFormationsType === 'array';
        return json({
          inGame: bagFormationsDefined,
          activeSingleGameStatusPresent: statusPresent,
          bagFormationsType,
          keyCount: Object.keys(state).length,
          inventoryItemsLength: Array.isArray(state.inventoryItems) ? state.inventoryItems.length : null,
          statusError: null,
        });
      }

      // 3) probeLiveBridge：9 个成员的 typeof 表
      if (expr.includes('typeof g[n]')) {
        const members = {};
        for (const n of BRIDGE_MEMBERS) members[n] = 'function';
        return json({ present: true, ready: true, members });
      }

      // 4) 页面内摘要投影（readLiveWorldStateSummary）
      if (expr.includes('readWorldState()') && expr.includes('keyCount:')) {
        const out = {
          keyCount: Object.keys(state).length,
          inventoryItemsLength: Array.isArray(state.inventoryItems) ? state.inventoryItems.length : null,
          placedItemsLength: Array.isArray(state.placedItems) ? state.placedItems.length : null,
          hasPlayerKey: Object.prototype.hasOwnProperty.call(state, 'player'),
          bagFormationsType: Array.isArray(state.bagFormations)
            ? 'array'
            : state.bagFormations === null ? 'null' : typeof state.bagFormations,
        };
        for (const k of SUMMARY_SCALAR_KEYS) {
          const v = state[k];
          out[k] = v === null || v === undefined ? null : typeof v === 'object' ? null : v;
        }
        return json(out);
      }

      // 5) 完整活状态（readLiveWorldState）
      if (expr.includes('readWorldState()')) return json(state);

      throw new Error(`fake client: unrecognized expression: ${expr.slice(0, 120)}`);
    },
  };
}

/** 合成一份「活状态」：形状照抄实测（扁平 87 键的子集，无 player 键）。 */
function makeLiveState(extra = {}) {
  return {
    bagSize: 7,
    realmId: 1,
    realmLayer: 3,
    cultivation: 12345,
    spiritStones: 999,
    snapshotVersion: 42,
    playerType: 'undefined',
    bagFormations: {},
    placedItems: [{ instanceId: 'placed_aaa_1', templateNumericId: 200001 }],
    inventoryItems: [
      {
        instanceId: 'existing_zz_01',
        templateNumericId: 1000053,
        isNew: false,
        infusedEffects: [],
        effectComprehension: { rootEffects: {} },
      },
    ],
    ...extra,
  };
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const synthetic = process.argv.includes('--synthetic');
  log('口袋修仙 · 修改器 trainer 离线自检');
  log(`node ${process.version}`);
  log(`APPDATA      = ${process.env.APPDATA ?? '(unset)'}`);
  log(`save dir     = ${resolveSaveDir()}`);
  log(`save dir 存在 = ${saveDirExists()}`);
  log(`csv          = ${DEFAULT_CSV_PATH}`);

  // ---------------- 阶段 0：环境
  group('阶段 0 · 环境');
  check('存档目录可解析', typeof resolveSaveDir() === 'string' && resolveSaveDir().length > 0);

  // ---------------- 阶段 1：文件名编码往返
  group('阶段 1 · 文件名 base64url 往返');
  const rawNames = [
    'save_auto_char_test_x9y8z7_9f8e7d6c_1a2b3c4d-1111-2222-3333-444444444444',
    'save_manual_char_test_x9y8z7_9f8e7d6c_1_0f0e0d0c',
    'char_test_x9y8z7_9f8e7d6c',
  ];
  for (const raw of rawNames) {
    const enc = encodeSaveFileName(raw);
    const dec = decodeSaveFileName(enc + '.json');
    check(`往返 ${raw.slice(0, 34)}…`, dec === raw, `enc=${enc.slice(0, 28)}…`);
  }
  let threw = false;
  try { encodeSaveFileName(''); } catch (e) { threw = /Local save path segment is empty/.test(e.message); }
  check('空档名抛 Local save path segment is empty', threw);

  // ---------------- 阶段 2：csv 目录
  group('阶段 2 · 模板目录 csv');
  const catalog = getCatalog();
  check('csv 解析成功', catalog.rowCount > 0, `rowCount=${catalog.rowCount} parseErrors=${catalog.parseErrors.length}`);
  check('表头 14 列符合预期', catalog.header.length === 14, catalog.header.join(','));
  const sample = catalog.getItem(100001);
  check('getItem(100001) 命中', !!sample, sample ? `${sample.name} / ${sample.category}` : 'miss');
  check('searchItems 可用', catalog.searchItems('丹').length > 0, `${catalog.searchItems('丹').length} 条命中 "丹"`);
  check('listAll().length === rowCount', catalog.listAll().length === catalog.rowCount);
  // ⚠️ csv 不是模板 id 全集。实测遍历全部真实存档：distinct id=1401，csv rowCount=2080，
  //    未收录 87 个，都是特殊/隐藏族（19xxxx/199xxx/20xxxx/39xxxx/40xxxx 个别/49xxxx/59xxxx/79xxxx/89xxxx）。
  //    注意 41xxxx **在** csv 内（早先「41xxxx 族缺失」的判断是错的）。
  check('isCataloged(411952) === true（41xxxx 族确实在 csv 内）', catalog.isCataloged(411952) === true);
  check('isCataloged(400421) === false（实测未收录族，证明 csv 非全集）', catalog.isCataloged(400421) === false);
  check(
    'findUncataloged 能报出未收录 id 且不改入参',
    (() => {
      const g = { templateNumericId: 400421, quantity: 1 };
      const got = findUncataloged([g, { templateNumericId: 100001, quantity: 1 }], catalog);
      return JSON.stringify(got) === '[400421]' && !('__uncataloged' in g) && Object.keys(g).length === 2;
    })(),
  );
  check('isCataloged(100001) === true', catalog.isCataloged(100001) === true);

  // ---------------- 阶段 3：真实存档 hash 复现（golden）
  const realPath = synthetic ? null : findRealSave();
  let goldenOk = null;
  if (realPath) {
    group('阶段 3 · 真实存档 hash 复现（golden）');
    log(`  样本 = ${realPath}`);
    const real = readSave(realPath);
    log(`  大小 = ${statSync(realPath).size} B`);
    log(`  顶层键 = ${Object.keys(real).join(', ')}`);
    log(`  inventoryItems = ${real.snapshot?.inventoryItems?.length}`);
    const v = verifyHashes(real);
    log(`  stored     = ${v.stored}`);
    log(`  recomputed = ${v.recomputed}`);
    goldenOk = check('真实存档既有 hash 被 computeSaveHash 复现', v.ok, v.reason ?? 'hash 一致');
    check('snapshotHash === localSaveHash', real.snapshotHash === real.localSaveHash);
  } else {
    group('阶段 3 · 真实存档 hash 复现（golden）');
    log('  跳过：未找到真实存档（用 --synthetic 或显式传路径）');
    goldenOk = null;
  }

  // ---------------- 阶段 4：在临时目录副本上发放道具
  group('阶段 4 · 临时目录副本上 grantItems');
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pocket-selftest-'));
  log(`  临时目录 = ${tmpRoot}`);
  let allOk = true;
  try {
    const workPath = join(tmpRoot, 'work.json');
    let base;
    if (realPath) {
      copyFileSync(realPath, workPath);
      base = readSave(workPath);
      check('真实存档已复制到临时目录（源目录未被写）', existsSync(workPath));
    } else {
      base = syntheticSave();
      writeSaveAtomic(workPath, base, { indent: 0 });
      base = readSave(workPath);
      log('  使用合成存档（仅验证算法自洽，不构成对游戏实现的验证）');
    }

    const beforeItems = base.snapshot.inventoryItems;
    const beforeIds = collectInstanceIds(base);
    const TEMPLATE = 100001;

    const granted = grantItems(base, [{ templateNumericId: TEMPLATE, quantity: 1 }]);
    check('grantItems 返回新对象（不原地改）', granted !== base);
    check('入参未被修改', base.snapshot.inventoryItems.length === beforeItems.length,
      `base=${base.snapshot.inventoryItems.length} granted=${granted.snapshot.inventoryItems.length}`);

    const normalized = normalizeSave(granted);
    check('normalizeSave 返回新对象', normalized !== granted);
    check('normalizeSave 后两 hash 相等', normalized.snapshotHash === normalized.localSaveHash,
      normalized.snapshotHash);

    // 写回副本（临时目录，不触发安全闸门）
    const returned = writeSaveAtomic(workPath, normalized, { indent: 0 });
    check('writeSaveAtomic 写入临时副本成功', existsSync(workPath), returned);

    const back = readSave(workPath);

    // ---- 断言 ①：两 hash 相等且与重算值一致
    const vBack = verifyHashes(back);
    check('断言① 读回后两 hash 相等且与重算值一致', vBack.ok,
      vBack.ok ? back.snapshotHash : `${vBack.reason} stored=${vBack.stored} recomputed=${vBack.recomputed}`);

    // ---- 断言 ②：inventoryItems 长度 +1
    const afterItems = back.snapshot.inventoryItems;
    check('断言② inventoryItems 长度 +1', afterItems.length === beforeItems.length + 1,
      `${beforeItems.length} → ${afterItems.length}`);

    // ---- 断言 ③：新元素字段合法且 instanceId 全局唯一
    const newEls = afterItems.slice(beforeItems.length);
    const el = newEls[0] ?? {};
    const shapeOk =
      typeof el.instanceId === 'string' && el.instanceId.length > 0 &&
      Number.isInteger(el.templateNumericId) && el.templateNumericId === TEMPLATE &&
      Array.isArray(el.infusedEffects) &&
      el.effectComprehension && typeof el.effectComprehension === 'object' &&
      el.isNew === true &&
      !('row' in el) && !('col' in el);
    check('断言③a 新元素字段合法（且无 row/col）', shapeOk, JSON.stringify(el));
    check('断言③b 新元素 instanceId 未与任何已有 id 重复', !beforeIds.has(el.instanceId), el.instanceId);
    const allIds = afterItems.map((x) => x.instanceId);
    check('断言③c 读回后全档 instanceId 仍唯一', new Set(allIds).size === allIds.length,
      `${allIds.length} 个 / ${new Set(allIds).size} 唯一`);
    check('断言③d placedItems 未被改动', (back.snapshot.placedItems?.length ?? 0) === (base.snapshot.placedItems?.length ?? 0));

    // ---- 断言 ④：除 inventoryItems / 两 hash 外其余字段逐键深比较完全不变
    const stripped = (o) => {
      const c = { ...o };
      delete c.snapshotHash; delete c.localSaveHash;
      c.snapshot = { ...c.snapshot };
      delete c.snapshot.inventoryItems;
      return c;
    };
    const a = JSON.stringify(canonicalize(stripped(base)));
    const b = JSON.stringify(canonicalize(stripped(back)));
    check('断言④ 其余字段逐键深比较完全不变', a === b,
      a === b ? `比较了 ${Object.keys(stripped(base)).length} 个顶层键` : `差异长度 a=${a.length} b=${b.length}`);

    // ---- 额外：安全闸门必须拒绝写真实存档目录
    group('阶段 5 · 安全闸门');
    let gateThrew = false, gateMsg = '';
    try {
      writeSaveAtomic(join(resolveSaveDir(), 'should-never-be-written.json'), { x: 1 });
    } catch (e) { gateThrew = true; gateMsg = e.message; }
    check('拒绝写入真实存档目录（无 allowRealSave）', gateThrew, gateMsg.slice(0, 96));
    check('真实存档源文件未被本次自检修改',
      !realPath || statSync(realPath).size === statSync(realPath).size);
    check('临时目录内确实产生了副本', existsSync(workPath));
    check('grantItems 对非法 templateNumericId 抛错',
      (() => { try { grantItems(base, [{ templateNumericId: 'x' }]); return false; } catch { return true; } })());
    check('grantItems quantity=3 生成 3 个独立元素',
      (() => {
        const g = grantItems(base, [{ templateNumericId: 100002, quantity: 3 }]);
        const added = g.snapshot.inventoryItems.slice(beforeItems.length);
        return added.length === 3 && new Set(added.map((x) => x.instanceId)).size === 3;
      })());
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    check('临时目录已清理', !existsSync(tmpRoot), tmpRoot);
  }

  // ---------------------------------------------------------------- 阶段 6
  // 全部离线：假 client 在进程内按表达式分派，绝不连游戏、绝不写盘。
  group('阶段 6 · live-bridge 离线（假 client，不连游戏）');
  const LIVE_TEMPLATE = 100001;

  // 6a 桥始终不就绪 → 必须抛可识别错误，且真的轮询了多次
  {
    const c = makeFakeBridgeClient({ state: makeLiveState(), readyAfter: Number.POSITIVE_INFINITY });
    let msg = '', threw = false;
    try {
      await waitForLiveBridge(c, 1, { timeoutMs: 60, pollMs: 10, sleepFn: () => Promise.resolve() });
    } catch (e) { threw = true; msg = e.message; }
    check('waitForLiveBridge 桥始终不就绪时抛超时错误', threw && /等待活状态桥超时/.test(msg), msg.slice(0, 120));
    check('waitForLiveBridge 确实轮询了多次（>=2）', c.polls >= 2, `polls=${c.polls}`);
  }

  // 6b 第 2 次轮询起就绪 → 返回 true
  {
    const c = makeFakeBridgeClient({ state: makeLiveState(), readyAfter: 2 });
    const r = await waitForLiveBridge(c, 1, { timeoutMs: 500, pollMs: 1, sleepFn: () => Promise.resolve() });
    check('waitForLiveBridge 桥就绪时返回 true', r === true && c.polls >= 2, `r=${r} polls=${c.polls}`);
  }

  // 6c probe：9 个成员全 function
  {
    const c = makeFakeBridgeClient({ state: makeLiveState() });
    const p = await probeLiveBridge(c, 1);
    const allFn = BRIDGE_MEMBERS.every((n) => p.members[n] === 'function');
    check('probeLiveBridge 报出 9 个成员且全为 function',
      p.present === true && p.ready === true && allFn && Object.keys(p.members).length === 9,
      `present=${p.present} ready=${p.ready} n=${Object.keys(p.members).length}`);
  }

  // 6d dryRun：算出 added，但**绝不**调 patch
  {
    const state = makeLiveState();
    const c = makeFakeBridgeClient({ state });
    const res = await grantLiveItems(c, 1, [{ templateNumericId: LIVE_TEMPLATE, quantity: 2 }], { dryRun: true });
    const ids = res.added.map((e) => e.instanceId);
    check('grantLiveItems dryRun 返回 2 个新增元素', res.added.length === 2 && res.after === res.before + 2,
      `before=${res.before} after=${res.after} added=${res.added.length}`);
    check('grantLiveItems dryRun 未调用 patchWorldState', c.patchCalls.length === 0, `patchCalls=${c.patchCalls.length}`);
    check('grantLiveItems dryRun 未改动活状态', state.inventoryItems.length === 1, `len=${state.inventoryItems.length}`);
    check('grantLiveItems dryRun 的 added 元素形状合法（无 row/col）',
      res.added.every((e) => typeof e.instanceId === 'string' && e.instanceId.length > 0
        && e.templateNumericId === LIVE_TEMPLATE && e.isNew === true
        && Array.isArray(e.infusedEffects) && !!e.effectComprehension
        && !('row' in e) && !('col' in e)),
      JSON.stringify(res.added[0] || null));
    check('grantLiveItems dryRun 新增 instanceId 彼此唯一且不与既有冲突',
      new Set(ids).size === ids.length && ids.every((id) => id !== 'existing_zz_01'), ids.join(','));
    check('grantLiveItems dryRun 返回 dryRun:true / applied:false / verified:false / result:null',
      res.dryRun === true && res.applied === false && res.verified === false && res.result === null,
      `dryRun=${res.dryRun} applied=${res.applied} verified=${res.verified}`);
    check('grantLiveItems dryRun 不读会话状态（不触发预检闸门）', c.sessionCalls.length === 0,
      `sessionCalls=${c.sessionCalls.length}`);
    log(`  added 形状样例：${JSON.stringify(res.added[0] || null)}`);
  }

  // 6e applied：真的 patch，活状态增长
  {
    const state = makeLiveState();
    const c = makeFakeBridgeClient({ state });
    const res = await grantLiveItems(c, 1, [{ templateNumericId: LIVE_TEMPLATE, quantity: 1 }], { dryRun: false });
    const patch = c.patchCalls.length ? c.patchCalls[0].patch : {};
    check('grantLiveItems applied 调用了 patchWorldState', c.patchCalls.length === 1, `patchCalls=${c.patchCalls.length}`);
    check('patch 只传 inventoryItems 一个键', Object.keys(patch).length === 1 && Array.isArray(patch.inventoryItems),
      Object.keys(patch).join(','));
    check('patch 后活状态 inventoryItems 增长且含新元素',
      state.inventoryItems.length === 2 && state.inventoryItems[1].instanceId === res.added[0].instanceId,
      `len=${state.inventoryItems.length}`);
    check('grantLiveItems applied 返回 dryRun:false / applied:true / before:1 / after:2',
      res.dryRun === false && res.applied === true && res.before === 1 && res.after === 2,
      `dryRun=${res.dryRun} applied=${res.applied} before=${res.before} after=${res.after}`);
    check('grantLiveItems applied 写后校验通过（verified:true / beforeCount:1 / afterCount:2 / reason:null）',
      res.verified === true && res.beforeCount === 1 && res.afterCount === 2 && res.reason === null,
      `verified=${res.verified} beforeCount=${res.beforeCount} afterCount=${res.afterCount} reason=${res.reason}`);
    check('grantLiveItems applied 的 applied 与 verified 一致',
      res.applied === res.verified, `applied=${res.applied} verified=${res.verified}`);
    check('patch 未触碰 placedItems', state.placedItems.length === 1 && !('placedItems' in patch));
  }

  // 6f 校验闸门
  {
    const bad = makeFakeBridgeClient({ state: makeLiveState({ inventoryItems: {} }) });
    let m1 = '';
    try { await grantLiveItems(bad, 1, [{ templateNumericId: LIVE_TEMPLATE }], { dryRun: true }); } catch (e) { m1 = e.message; }
    check('grantLiveItems 拒绝 inventoryItems 非数组的活状态', /inventoryItems is not an array/.test(m1), m1.slice(0, 120));

    const ok1 = makeFakeBridgeClient({ state: makeLiveState() });
    let m2 = '';
    try { await grantLiveItems(ok1, 1, 'nope', { dryRun: true }); } catch (e) { m2 = e.message; }
    check('grantLiveItems 拒绝 grants 非数组', /grants must be an array/.test(m2), m2.slice(0, 120));

    const ok2 = makeFakeBridgeClient({ state: makeLiveState() });
    let m3 = '';
    try { await grantLiveItems(ok2, 1, [{ templateNumericId: 'x' }], { dryRun: true }); } catch (e) { m3 = e.message; }
    check('grantLiveItems 拒绝非法 templateNumericId', /invalid templateNumericId/.test(m3), m3.slice(0, 120));
  }

  // 6f-2 预检闸门：不在角色会话（主菜单）时拒绝 patch —— 修复「主菜单 patch 静默不持久化」
  {
    // 复现「未进入角色」指纹：bagFormations undefined、inventoryItems 为空。
    const state = makeLiveState({ bagFormations: undefined, inventoryItems: [], placedItems: [] });
    const c = makeFakeBridgeClient({ state, activeSingleGameStatus: null });
    let msg = '';
    let threw = false;
    try {
      await grantLiveItems(c, 1, [{ templateNumericId: LIVE_TEMPLATE }], { dryRun: false });
    } catch (e) { threw = true; msg = e.message; }
    check('★ grantLiveItems 未进入角色会话时拒绝 patch（报「尚未进入角色」）',
      threw && /尚未进入角色/.test(msg), msg.slice(0, 160));
    check('★ 未进入会话时绝不调用 patchWorldState', c.patchCalls.length === 0, `patchCalls=${c.patchCalls.length}`);
    check('未进入会话时活状态未被改动', state.inventoryItems.length === 0, `len=${state.inventoryItems.length}`);
  }

  // 6f-3 会话判据**只**用 bagFormations 形状（activeSingleGameStatus 不作判据）
  {
    // 2026-10-11 实机反证：已载入角色的会话里 readActiveSingleGameStatus() 仍为 null，
    // 但 bagFormations 是 object ⇒ 必须**允许** patch（旧的 AND 判据会误拒合法发放）。
    const state = makeLiveState();
    const c = makeFakeBridgeClient({ state, activeSingleGameStatus: null });
    const res = await grantLiveItems(c, 1, [{ templateNumericId: LIVE_TEMPLATE }], { dryRun: false });
    check('★ status=null 但 bagFormations 为 object 时不误拒（实机反证：允许 patch）',
      res.verified === true && c.patchCalls.length === 1,
      `verified=${res.verified} patchCalls=${c.patchCalls.length}`);

    // bagFormations 才是唯一判据：undefined 即拒绝，即便 status 非 null。
    const state2 = makeLiveState({ bagFormations: undefined });
    const c2 = makeFakeBridgeClient({ state: state2, activeSingleGameStatus: { active: true } });
    let threw2 = false;
    try { await grantLiveItems(c2, 1, [{ templateNumericId: LIVE_TEMPLATE }], { dryRun: false }); } catch { threw2 = true; }
    check('★ 判据为 bagFormations=undefined 即拒绝（即便 status 非 null）',
      threw2 && c2.patchCalls.length === 0, `threw=${threw2} patchCalls=${c2.patchCalls.length}`);
  }

  // 6f-4 readLiveSessionStatus 直测
  {
    const inGame = makeFakeBridgeClient({ state: makeLiveState() });
    const s1 = await readLiveSessionStatus(inGame, 1);
    check('readLiveSessionStatus 在角色会话中报 inGame:true',
      s1.inGame === true && s1.activeSingleGameStatusPresent === true && s1.bagFormationsType === 'object',
      JSON.stringify(s1));

    // 实机场景：status 为 null，但 bagFormations 是 object ⇒ inGame:true（status 仅作诊断字段）。
    const empirical = makeFakeBridgeClient({ state: makeLiveState(), activeSingleGameStatus: null });
    const sE = await readLiveSessionStatus(empirical, 1);
    check('readLiveSessionStatus status=null 但 bagFormations=object 仍报 inGame:true（诊断字段为 false）',
      sE.inGame === true && sE.activeSingleGameStatusPresent === false && sE.bagFormationsType === 'object',
      JSON.stringify(sE));

    const notInGame = makeFakeBridgeClient({
      state: makeLiveState({ bagFormations: undefined, inventoryItems: [], placedItems: [] }),
      activeSingleGameStatus: null,
    });
    const s2 = await readLiveSessionStatus(notInGame, 1);
    check('readLiveSessionStatus 在主菜单报 inGame:false',
      s2.inGame === false && s2.bagFormationsType === 'undefined',
      JSON.stringify(s2));
  }

  // 6h 写后校验：patch 返回 success 但状态没变 → applied:false / verified:false + reason
  {
    // 复现原缺陷：patchWorldState 无条件返回 {success:true}，活状态却没有任何变化。
    const state = makeLiveState();
    const c = makeFakeBridgeClient({ state, ignorePatch: true });
    const res = await grantLiveItems(c, 1, [{ templateNumericId: LIVE_TEMPLATE, quantity: 1 }], { dryRun: false });
    check('★ patch 未生效时 applied=false / verified=false',
      res.applied === false && res.verified === false, `applied=${res.applied} verified=${res.verified}`);
    check('★ 校验失败时给出非空 reason（且 before/afterCount 明确）',
      typeof res.reason === 'string' && res.reason.length > 0 && res.beforeCount === 1 && res.afterCount === 1,
      `reason=${res.reason} beforeCount=${res.beforeCount} afterCount=${res.afterCount}`);
    check('校验失败时桥仍被调用过（说明确实尝试过 patch）', c.patchCalls.length === 1, `patchCalls=${c.patchCalls.length}`);
  }

  // 6g 摘要纯函数
  {
    const s = summarizeLiveWorldState(makeLiveState());
    check('summarizeLiveWorldState 键数与数组长度正确',
      s.keyCount === 10 && s.inventoryItemsLength === 1 && s.placedItemsLength === 1
        && s.hasPlayerKey === false && s.bagFormationsType === 'object',
      JSON.stringify(s));
    let m = '';
    try { summarizeLiveWorldState(null); } catch (e) { m = e.message; }
    check('summarizeLiveWorldState 拒绝非对象', /expected a plain object/.test(m), m.slice(0, 120));
  }

  // ---------------------------------------------------------------- 阶段 7
  group('阶段 7 · buildLaunchEnv（启动三环境变量）');
  {
    const env = buildLaunchEnv({ port: 9333, baseEnv: {} });
    check('注入 POCKET_DESKTOP_REMOTE_DEBUGGING_PORT',
      env.POCKET_DESKTOP_REMOTE_DEBUGGING_PORT === '9333', JSON.stringify(env.POCKET_DESKTOP_REMOTE_DEBUGGING_PORT));
    check('注入 POCKET_DESKTOP_E2E=1', env.POCKET_DESKTOP_E2E === '1', JSON.stringify(env.POCKET_DESKTOP_E2E));
    check('注入 POCKET_DESKTOP_E2E_WINDOW_MODE=inactive',
      env.POCKET_DESKTOP_E2E_WINDOW_MODE === 'inactive', JSON.stringify(env.POCKET_DESKTOP_E2E_WINDOW_MODE));
    check('端口被转成字符串', typeof env.POCKET_DESKTOP_REMOTE_DEBUGGING_PORT === 'string');

    const off = buildLaunchEnv({
      port: 9334, e2e: false,
      baseEnv: { POCKET_DESKTOP_E2E: '1', POCKET_DESKTOP_E2E_WINDOW_MODE: 'inactive' },
    });
    check('e2e:false 时不含 POCKET_DESKTOP_E2E', !('POCKET_DESKTOP_E2E' in off), JSON.stringify(off.POCKET_DESKTOP_E2E));
    check('e2e:false 时不含 POCKET_DESKTOP_E2E_WINDOW_MODE',
      !('POCKET_DESKTOP_E2E_WINDOW_MODE' in off), JSON.stringify(off.POCKET_DESKTOP_E2E_WINDOW_MODE));
    check('e2e:false 时仍注入调试端口', off.POCKET_DESKTOP_REMOTE_DEBUGGING_PORT === '9334',
      JSON.stringify(off.POCKET_DESKTOP_REMOTE_DEBUGGING_PORT));

    let m = '';
    try { buildLaunchEnv({ port: 0 }); } catch (e) { m = e.message; }
    check('非法端口抛错（port must be a positive safe integer）', /positive safe integer/.test(m), m.slice(0, 120));
  }

  // ---------------------------------------------------------------- 阶段 8
  // 活体发放的备份闸门（fail-closed）。
  //
  // 为什么分两层：
  //   gui-server.mjs 不导出 applyLiveGrant，且其内部 withCdp 走真实 CDP
  //   （HTTP /json/list + WebSocket），无法注入假 client —— 自检**绝不能**连游戏，
  //   所以这里用「源码结构断言（顺序与 fail-closed 语义）」+「backup.mjs 原语行为断言
  //   （备份成功/失败的真实行为）」两层共同证明：备份失败即中止、备份成功才 patch。
  group('阶段 8 · 活体发放的备份闸门（先备份后 patch、失败即中止）');
  {
    // --- 8a) applyLiveGrant 源码结构 -------------------------------------
    const guiSrc = readFileSync(new URL('./gui-server.mjs', import.meta.url), 'utf8');
    const fnStart = guiSrc.indexOf('async function applyLiveGrant(body) {');
    const fnEnd = guiSrc.indexOf('// ---- 路由', fnStart);
    const fn = fnStart >= 0 && fnEnd > fnStart ? guiSrc.slice(fnStart, fnEnd) : '';

    check('applyLiveGrant 可在 gui-server.mjs 中定位', fn.length > 0, `len=${fn.length}`);

    const iBackupFile = fn.indexOf('backupSave(localPath');
    const iBackupObj = fn.indexOf('backupSaveObject(save');
    const iThrow = fn.indexOf('活体发放前备份失败');
    const iPatch = fn.indexOf('grantLiveItems(ctx.client, ctx.contextId, entry.grants, { dryRun: false })');

    check('活体路径有本地存档文件备份分支（backupSave）', iBackupFile >= 0, `idx=${iBackupFile}`);
    check('活体路径有 CDP 读回对象备份分支（backupSaveObject）', iBackupObj >= 0, `idx=${iBackupObj}`);
    check('两个备份分支都用 label: pre-live-grant',
      (fn.match(/label: 'pre-live-grant'/g) || []).length === 2,
      `count=${(fn.match(/label: 'pre-live-grant'/g) || []).length}`);
    check('patch 调用为真实写入（dryRun: false）', iPatch >= 0, `idx=${iPatch}`);
    check('★ 先备份后 patch（两个备份调用都在 grantLiveItems 之前）',
      iBackupFile >= 0 && iBackupObj >= 0 && iPatch > iBackupFile && iPatch > iBackupObj,
      `backupFile@${iBackupFile} backupObj@${iBackupObj} patch@${iPatch}`);
    check('★ 备份失败即抛错（fail-closed 文案在 patch 之前）',
      iThrow >= 0 && iThrow < iPatch && /fail-closed/.test(fn) && /未做任何 patch/.test(fn),
      `throw@${iThrow} patch@${iPatch}`);
    check('★ applyLiveGrant 内无 try/catch 吞掉备份异常（fail-closed 不被降级）',
      !/catch\s*\(/.test(fn), `catch 出现次数=${(fn.match(/catch\s*\(/g) || []).length}`);

    check('返回体带 backupPath / backupKind / backupBytes / backupSource',
      ['backupPath:', 'backupKind:', 'backupBytes:', 'backupSource:'].every((k) => fn.includes(k)));
    check('返回体声明已落盘（persisted: true + persistMode: immediate）',
      /persisted: true/.test(fn) && /persistMode: 'immediate'/.test(fn));
    check('返回体声明活体路径无需重载（reloadRequired: false）', /reloadRequired: false/.test(fn));

    // --- 8a-2) 写后校验：只有 verified===true 才可能返回 2xx --------------------
    check('★ 写后校验失败即抛错（verified !== true 出现在 persisted: true 之前）',
      /result\.verified !== true/.test(fn) &&
        fn.indexOf('result.verified !== true') >= 0 &&
        fn.indexOf('result.verified !== true') < fn.indexOf('persisted: true'),
      `guard@${fn.indexOf('result.verified !== true')} persisted@${fn.indexOf('persisted: true')}`);
    check('返回体带写后校验字段（verified / beforeCount / afterCount）',
      ['verified:', 'beforeCount:', 'afterCount:'].every((k) => fn.includes(k)));
    check('applied 取自动校验结果（applied: result.applied）', fn.includes('applied: result.applied'));

    // --- 8a-2b) 活体备份目标用「最近修改的存档」 --------------------------------
    check('★ 活体备份目标用 findActiveSaveFile（取 mtime 最大），并保留 findLocalSaveFile 兜底',
      fn.includes('findActiveSaveFile(playerUid, saveRoot)') &&
        fn.includes('findLocalSaveFile(playerUid, saveRoot)'),
      `active@${fn.indexOf('findActiveSaveFile(playerUid, saveRoot)')} ` +
        `local@${fn.indexOf('findLocalSaveFile(playerUid, saveRoot)')}`);

    // --- 8a-3) /api/live/status 暴露 inGame -----------------------------------
    const statusFn = guiSrc.slice(
      guiSrc.indexOf('async function liveStatusPayload()'),
      guiSrc.indexOf('async function previewLiveGrant'),
    );
    check('★ /api/live/status 负载带 inGame 布尔（UI 可据此刻画「未进入会话」告警）',
      statusFn.length > 0 && statusFn.includes('inGame:') && statusFn.includes('readLiveSessionStatus') &&
        statusFn.includes('payload.inGame'),
      `len=${statusFn.length}`);
    check('gui-server 从 live-bridge 引入 readLiveSessionStatus',
      /import[\s\S]*readLiveSessionStatus[\s\S]*from '\.\/live-bridge\.mjs'/.test(guiSrc));

    // --- 8b) backup.mjs 原语的真实行为 -----------------------------------
    const bdir = mkdtempSync(join(tmpdir(), 'pc-backup-gate-'));
    try {
      const srcPath = join(bdir, 'real-save.json');
      const payload = JSON.stringify({ roleName: '口袋修仙', n: 1 }, null, 2);
      writeFileSync(srcPath, payload, 'utf8');
      const outDir = join(bdir, 'backups');

      // 成功路径：备份产物必须真实存在、字节一致、文件名可溯源
      let ok = null; let err = '';
      try { ok = backupSave(srcPath, { dir: outDir, label: 'pre-live-grant' }); } catch (e) { err = e.message; }
      check('★ 备份成功：backupSave 产出真实文件且字节数与源一致',
        !!ok && existsSync(ok.path) && ok.bytes === Buffer.byteLength(payload),
        err || (ok ? `${basename(ok.path)} bytes=${ok.bytes}` : 'no result'));
      check('备份产物内容与源存档逐字节一致',
        !!ok && readFileSync(ok.path, 'utf8') === payload);
      check('备份文件名含 label 与时间戳（可溯源到发放前）',
        !!ok && basename(ok.path).includes('pre-live-grant') && /\d{8}-\d{6}/.test(basename(ok.path)),
        ok ? basename(ok.path) : '');

      // 失败路径：源文件不存在 ⇒ backupSave 必须抛错。
      // 这正是 applyLiveGrant 里「备份失败即中止、绝不 patch」所依赖的原语。
      let err2 = '';
      try { backupSave(join(bdir, 'no-such-save.json'), { dir: outDir, label: 'pre-live-grant' }); } catch (e) { err2 = e.message; }
      check('★ 备份失败：源文件缺失时 backupSave 抛错（⇒ 调用方中止，不 patch）',
        /source file does not exist/.test(err2), err2.slice(0, 110));

      // 对象备份分支（本地无存档文件时的退路）
      let obj = null; let err3 = '';
      try { obj = backupSaveObject({ a: 1 }, { dir: outDir, label: 'pre-live-grant', name: 'cdp-read-save' }); } catch (e) { err3 = e.message; }
      check('对象备份分支：backupSaveObject 写出 JSON 且 source 为 null',
        !!obj && existsSync(obj.path) && obj.source === null && obj.bytes > 0,
        err3 || (obj ? basename(obj.path) : 'no result'));
      check('对象备份文件名含 cdp-read-save',
        !!obj && basename(obj.path).includes('cdp-read-save'), obj ? basename(obj.path) : '');

      // 绝不覆盖：同一秒重复备份必须得到两个不同文件
      const a = backupSave(srcPath, { dir: outDir, label: 'dedupe', now: new Date(0) });
      const b = backupSave(srcPath, { dir: outDir, label: 'dedupe', now: new Date(0) });
      check('同秒重复备份绝不覆盖（自动加序号）',
        a.path !== b.path && existsSync(a.path) && existsSync(b.path),
        `${basename(a.path)} | ${basename(b.path)}`);
      check('listBackups 能看到本轮全部 4 份备份',
        listBackups(outDir).length === 4, `count=${listBackups(outDir).length}`);
    } finally {
      rmSync(bdir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- 阶段 9
  // 活体发放的备份目标：必须取「最近修改」的存档（当前载入的角色），不得排除 recovery/backup，
  // 也不得排除 `_short`（游戏把长路径存档迁移到 _short，当前载入角色的档常在那里）。
  // 游戏载入的是 char_recovery_…（更小但更新）；最新一行在 _short 下，
  // 正是 live grant 持久化写入的档。findLocalSaveFile 因排除 recovery 与 _short 而备份错档。
  group('阶段 9 · 活体发放的备份目标（findActiveSaveFile 取最近修改，不排除 recovery/_short）');
  {
    const root = mkdtempSync(join(tmpdir(), 'pc-active-save-'));
    try {
      const playerUid = 'steam-test-user';
      const recoveryChar = 'char_recovery_test_a1b2c3d4e5f6_1234abcd';
      const normalChar = 'char_test_x9y8z7';
      const recoverySave = 'save_auto_char_recovery_test_a1b2c3d4e5f6_1234abcd_1';
      const normalSave = 'save_manual_char_test_x9y8z7_2';

      const uidDir = join(root, encodeSaveFileName(playerUid));
      const recDir = join(uidDir, encodeSaveFileName(recoveryChar));
      const normDir = join(uidDir, encodeSaveFileName(normalChar));
      mkdirSync(recDir, { recursive: true });
      mkdirSync(normDir, { recursive: true });

      const recPath = join(recDir, encodeSaveFileName(recoverySave) + '.json');
      const normPath = join(normDir, encodeSaveFileName(normalSave) + '.json');

      // recovery 档更小（~1.25 MB vs 2.09 MB），但**更新**（游戏持续自动存档它）。
      writeFileSync(recPath, JSON.stringify({ snapshot: { inventoryItems: new Array(20).fill({}) } }), 'utf8');
      writeFileSync(normPath, JSON.stringify({ snapshot: { inventoryItems: new Array(200).fill({}) } }), 'utf8');
      utimesSync(normPath, new Date('2026-10-11T10:00:00Z'), new Date('2026-10-11T10:00:00Z'));
      utimesSync(recPath, new Date('2026-10-11T13:17:27Z'), new Date('2026-10-11T13:17:27Z'));

      const active = findActiveSaveFile(playerUid, root);
      check('★ findActiveSaveFile 取 mtime 最大的档（即更新的 recovery 角色，未被排除）',
        active === recPath, String(active));
      check('findLocalSaveFile 复现旧缺陷（排除 recovery 后按体积选到更大的另一角色）',
        findLocalSaveFile(playerUid, root) === normPath, String(findLocalSaveFile(playerUid, root)));

      // _short 下的文件是**当前载入角色**的档，必须参与选择：写入一份最新的 _short 档。
      const shortDir = join(uidDir, '_short');
      mkdirSync(shortDir, { recursive: true });
      const shortFile = join(shortDir, '010cfb2fdeadbeef.json');
      writeFileSync(shortFile, JSON.stringify({ snapshot: { inventoryItems: new Array(30).fill({}) } }), 'utf8');
      utimesSync(shortFile, new Date('2026-10-11T13:23:55Z'), new Date('2026-10-11T13:23:55Z'));
      check('★ findActiveSaveFile 选中 _short 下最新的档（当前载入角色的档在 _short 里）',
        findActiveSaveFile(playerUid, root) === shortFile, String(findActiveSaveFile(playerUid, root)));
      check('findActiveSaveFile(null) 同样能定位到 _short 下最新的档',
        findActiveSaveFile(null, root) === shortFile, String(findActiveSaveFile(null, root)));

      check('findActiveSaveFile 无候选时返回 null',
        findActiveSaveFile('steam-does-not-exist', root) === null,
        String(findActiveSaveFile('steam-does-not-exist', root)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- 阶段 10
  // 模组新增道具扫描：用**合成临时模组目录**验证 add/override/坏文件/冲突/缺失目录五种情形。
  group('阶段 10 · 模组新增道具扫描（合成临时模组目录）');
  {
    const modsRoot = mkdtempSync(join(tmpdir(), 'pc-mods-'));
    try {
      const modDir = join(modsRoot, 'com.test.mod');
      const itemsDir = join(modDir, 'items');
      mkdirSync(itemsDir, { recursive: true });
      writeFileSync(
        join(modDir, 'manifest.json'),
        JSON.stringify({
          id: 'com.test.mod',
          name: '测试模组',
          version: '1.0.0',
          modApiVersion: 2,
          domains: { items: { schemaVersion: 3, path: 'items' } },
          enabled: true,
        }),
        'utf8',
      );

      // 新增道具（应被收录）
      writeFileSync(
        join(itemsDir, '900001.json'),
        JSON.stringify({
          mode: 'add',
          item: {
            numericId: 9990001,
            iconBasename: 'test-icon',
            name: '测试模组道具',
            description: '合成测试用',
            isPublished: true,
            isObtainable: true,
            category: 'scripture',
            grade: 'rare',
            element: 'fire',
            shape: [[1]],
            tags: [],
            distribution: { channels: ['bazaar'] },
            price: 123,
            effectList: [],
          },
        }),
        'utf8',
      );

      // override 补丁（必须忽略）
      writeFileSync(
        join(itemsDir, '900002.json'),
        JSON.stringify({ mode: 'override', numericId: 1000004, patch: { storageBag: {} } }),
        'utf8',
      );

      // 坏 JSON（必须记进 errors，且不打断扫描）
      writeFileSync(join(itemsDir, '900003.json'), '{ this is not valid json', 'utf8');

      // 与 csv 行同 id 的新增（模组行必须在冲突中胜出）
      writeFileSync(
        join(itemsDir, '900004.json'),
        JSON.stringify({
          mode: 'add',
          item: {
            numericId: 100001,
            name: '模组覆盖的100001',
            category: 'material',
            grade: 'legendary',
            element: 'none',
            shape: [[1]],
            distribution: {},
            effectList: [],
            price: 7,
            isPublished: true,
            isObtainable: true,
          },
        }),
        'utf8',
      );

      // 无 items domain 的模组（应跳过，itemCount=0）
      const noDomain = join(modsRoot, 'com.test.nodomain');
      mkdirSync(noDomain, { recursive: true });
      writeFileSync(
        join(noDomain, 'manifest.json'),
        JSON.stringify({
          id: 'com.test.nodomain',
          name: '无道具域',
          domains: { scripts: { path: 'scripts' } },
          enabled: false,
        }),
        'utf8',
      );

      const scan = scanModItems(modsRoot);
      check('scanModItems 收集 2 件新增道具（override 与坏文件被排除）',
        scan.items.length === 2, `items=${scan.items.length}`);
      check('scanModItems 识别 2 个模组', scan.mods.length === 2, `mods=${scan.mods.length}`);
      check('本地模组记录带 origin=local 且无 publishedFileId',
        scan.mods.every((m) => m.origin === 'local' && m.publishedFileId === undefined),
        JSON.stringify(scan.mods.map((m) => ({ id: m.id, origin: m.origin, pid: m.publishedFileId }))));

      const good = scan.items.find((it) => it.templateNumericId === 9990001);
      check('add 道具字段正确（name/category/grade/price）',
        !!good && good.name === '测试模组道具' && good.category === 'scripture' &&
          good.grade === 'rare' && good.price === 123,
        JSON.stringify(good && { name: good.name, category: good.category, grade: good.grade, price: good.price }));
      check('add 道具带 source（modId/modName/file）',
        !!good && !!good.source && good.source.modId === 'com.test.mod' &&
          good.source.modName === '测试模组' && /900001\.json$/.test(good.source.file),
        JSON.stringify(good && good.source));
      check('add 道具 source 带 origin=local',
        !!good && good.source.origin === 'local', JSON.stringify(good && good.source));
      check('override 文件被忽略（无任何行来自 900002.json）',
        scan.items.every((it) => !/900002\.json$/.test(it.source.file)));
      check('★ 坏 JSON 记入 errors 且不打断扫描',
        scan.errors.length === 1 && /900003\.json$/.test(scan.errors[0].file),
        JSON.stringify(scan.errors.map((e) => e.file)));

      const tm = scan.mods.find((m) => m.id === 'com.test.mod');
      const nod = scan.mods.find((m) => m.id === 'com.test.nodomain');
      check('有 items domain 的模组 itemCount=2', !!tm && tm.itemCount === 2, JSON.stringify(tm));
      check('无 items domain 的模组被跳过（itemCount=0，enabled=false）',
        !!nod && nod.itemCount === 0 && nod.enabled === false, JSON.stringify(nod));

      // ---- 合并进目录：模组行优先于 csv 行 ----
      const merged = loadCatalog(DEFAULT_CSV_PATH, modsRoot, null);
      check('合并后 rowCount = csv + 新增 - 冲突', merged.rowCount === merged.csvRowCount + merged.modItemCount - merged.modCollisions,
        `row=${merged.rowCount} csv=${merged.csvRowCount} mod=${merged.modItemCount} collisions=${merged.modCollisions}`);
      check('★ isCataloged(9990001) === true（模组道具已进目录）', merged.isCataloged(9990001) === true);
      check('getItem(9990001) 命中且 name 正确',
        (merged.getItem(9990001) || {}).name === '测试模组道具',
        String((merged.getItem(9990001) || {}).name));
      check('★ id 冲突时模组行胜出（100001 → 模组名）且 modCollisions=1',
        (merged.getItem(100001) || {}).name === '模组覆盖的100001' && merged.modCollisions === 1,
        `name=${(merged.getItem(100001) || {}).name} collisions=${merged.modCollisions}`);
      check('searchItems 能搜到模组道具',
        merged.searchItems('测试模组道具').some((it) => it.templateNumericId === 9990001));
      check('模组道具保留 source 溯源字段',
        !!merged.getItem(9990001).source && merged.getItem(9990001).source.modId === 'com.test.mod');

      // ---- 创意工坊根：depth 0 / depth 1（嵌套模组）/ 仅杂散文件 ----
      const wsRoot = mkdtempSync(join(tmpdir(), 'pc-ws-'));
      try {
        // depth 0：<publishedFileId>\manifest.json
        const ws0 = join(wsRoot, '3808300583');
        mkdirSync(join(ws0, 'items'), { recursive: true });
        writeFileSync(join(ws0, 'manifest.json'), JSON.stringify({
          id: 'com.ws.depth0', name: '工坊深度0',
          domains: { items: { schemaVersion: 5, path: 'items' } }, enabled: true,
        }), 'utf8');
        writeFileSync(join(ws0, 'items', 'a.json'), JSON.stringify({
          mode: 'add',
          item: { numericId: 9990002, name: '工坊道具0', category: 'material', grade: 'rare', price: 3 },
        }), 'utf8');

        // depth 1：<publishedFileId>\<modId>\manifest.json（发布目录内还有杂散文件）
        const ws1 = join(wsRoot, '3808127666');
        const ws1mod = join(ws1, 'com.ws.depth1');
        mkdirSync(join(ws1mod, 'items'), { recursive: true });
        writeFileSync(join(ws1, 'README-创意工坊.txt'), 'stray', 'utf8');
        writeFileSync(join(ws1mod, 'manifest.json'), JSON.stringify({
          id: 'com.ws.depth1', name: '工坊深度1',
          domains: { items: { schemaVersion: 2, path: 'items' } }, enabled: true,
        }), 'utf8');
        writeFileSync(join(ws1mod, 'items', 'b.json'), JSON.stringify({
          mode: 'add',
          item: { numericId: 9990003, name: '工坊道具1', category: 'material', grade: 'rare', price: 4 },
        }), 'utf8');

        // 仅含杂散文件的发布目录（无 manifest）→ 不贡献任何模组 / 道具
        const wsStray = join(wsRoot, '3809575170');
        mkdirSync(wsStray, { recursive: true });
        writeFileSync(join(wsStray, 'example.yinyue-market.vdf'), 'stray', 'utf8');

        const wsScan = scanModItems(null, wsRoot);
        check('★ 创意工坊扫描识别 2 个模组（depth0 + depth1）',
          wsScan.mods.length === 2, JSON.stringify(wsScan.mods.map((m) => m.id)));
        check('创意工坊新增道具 2 件', wsScan.items.length === 2, `items=${wsScan.items.length}`);
        const w0 = wsScan.items.find((it) => it.templateNumericId === 9990002);
        const w1 = wsScan.items.find((it) => it.templateNumericId === 9990003);
        check('★ depth0 工坊道具 origin=workshop 且 publishedFileId=3808300583',
          !!w0 && w0.source.origin === 'workshop' && w0.source.publishedFileId === '3808300583',
          JSON.stringify(w0 && w0.source));
        check('★ depth1 嵌套模组道具 origin=workshop 且 publishedFileId=3808127666',
          !!w1 && w1.source.origin === 'workshop' && w1.source.publishedFileId === '3808127666',
          JSON.stringify(w1 && w1.source));
        check('工坊模组记录带 origin=workshop 与 publishedFileId',
          wsScan.mods.every((m) => m.origin === 'workshop' && typeof m.publishedFileId === 'string'),
          JSON.stringify(wsScan.mods.map((m) => ({ id: m.id, pid: m.publishedFileId }))));
        check('★ 仅含杂散文件的工坊目录不产生模组 / 道具',
          !wsScan.mods.some((m) => m.dir.includes('3809575170')) &&
            !wsScan.items.some((it) => it.source.publishedFileId === '3809575170'));
        check('scanModItems 分区计数正确（local=空 / workshop=2+2）',
          wsScan.local.mods === 0 && wsScan.local.items === 0 &&
            wsScan.workshop.mods === 2 && wsScan.workshop.items === 2,
          JSON.stringify({ local: wsScan.local, workshop: wsScan.workshop }));

        // ---- 两个根源合并进目录 ----
        const both = loadCatalog(DEFAULT_CSV_PATH, modsRoot, wsRoot);
        check('★ 两根源合并：rowCount = csv + 本地 + 工坊 - 冲突',
          both.rowCount === both.csvRowCount + both.modItemCount - both.modCollisions,
          `row=${both.rowCount} csv=${both.csvRowCount} mod=${both.modItemCount} collisions=${both.modCollisions}`);
        check('两根源分区计数暴露在摘要（本地 2 + 工坊 2）',
          both.localModCount === 2 && both.workshopModCount === 2 &&
            both.localItemCount === 2 && both.workshopItemCount === 2,
          JSON.stringify({ lm: both.localModCount, wm: both.workshopModCount, li: both.localItemCount, wi: both.workshopItemCount }));
        check('★ 工坊道具进入目录且可搜到（origin=workshop）',
          both.getItem(9990002).source.origin === 'workshop' &&
            both.searchItems('工坊道具0').some((it) => it.templateNumericId === 9990002));
        check('loadCatalog 摘要带两个根路径', both.modsDir === modsRoot && both.workshopDir === wsRoot);
      } finally {
        rmSync(wsRoot, { recursive: true, force: true });
        check('创意工坊临时目录已清理', !existsSync(wsRoot), wsRoot);
      }

      // ---- 缺失目录 → 空结果，不是错误 ----
      const missing = scanModItems(join(modsRoot, 'does-not-exist'));
      check('模组目录缺失时返回空结果且无错误',
        missing.items.length === 0 && missing.mods.length === 0 && missing.errors.length === 0,
        JSON.stringify(missing));
      check('modsDir=null 时返回空结果',
        scanModItems(null).items.length === 0 && scanModItems(null).errors.length === 0);
    } finally {
      rmSync(modsRoot, { recursive: true, force: true });
      check('模组临时目录已清理', !existsSync(modsRoot), modsRoot);
    }
  }

  // ---------------------------------------------------------------- 阶段 11
  // 「写存档发放」路径已整体删除：服务端不再有 /api/grant/* 与 /api/backup 路由/处理器，
  // 界面不再有对应的四个区块；只剩活体发放一条路，且搜索「加入」把道具喂给活体待发放清单。
  group('阶段 11 · 写存档发放路径已删除 + 搜索「加入」喂活体清单');
  {
    const guiSrc = readFileSync(new URL('./gui-server.mjs', import.meta.url), 'utf8');
    const uiSrc = readFileSync(new URL('./gui-ui.mjs', import.meta.url), 'utf8');

    // --- 11a) 服务端：写存档发放的路由 / 处理器 / 依赖都已移除 ---
    check('★ gui-server 不再有 /api/grant/preview 路由', !guiSrc.includes("path === '/api/grant/preview'"));
    check('★ gui-server 不再有 /api/grant/apply 路由', !guiSrc.includes("path === '/api/grant/apply'"));
    check('★ gui-server 不再有 /api/backup 路由', !guiSrc.includes("path === '/api/backup'"));
    check('gui-server 不再有 previewGrant / applyGrant 处理器',
      !guiSrc.includes('function previewGrant') && !guiSrc.includes('function applyGrant'));
    check('gui-server 不再引入写盘专用依赖（writeSaveViaCdp / grant.mjs / normalizeSave）',
      !guiSrc.includes('writeSaveViaCdp') && !guiSrc.includes("from './grant.mjs'") &&
        !guiSrc.includes('normalizeSave'));
    check('gui-server 不再有写盘用的 kind: \'save\' 令牌', !guiSrc.includes("kind: 'save'"));
    check('gui-server 仍保留 GET /api/backups（只读列出备份）', guiSrc.includes("path === '/api/backups'"));

    // --- 11b) 服务端：活体端点与 fail-closed 闸门仍在（防止误删）---
    check('★ gui-server 仍保留三条活体端点',
      ["path === '/api/live/status'", "path === '/api/live/grant/preview'", "path === '/api/live/grant/apply'"]
        .every((k) => guiSrc.includes(k)));
    check('pending 令牌只剩活体一种（kind: \'live\'）', guiSrc.includes("kind: 'live'"));

    // --- 11c) 界面：写存档发放的四个区块已删除 ---
    const removedSections = [
      '<h2>💾 写存档发放（需重载存档）</h2>',
      '<h2>待发放清单</h2>',
      '<h2>步骤 1 · 预览将写入的内容</h2>',
      '<h2>步骤 2 · 确认写入</h2>',
    ];
    const stillThere = removedSections.filter((t) => uiSrc.includes(t));
    check('★ gui-ui 不再含写存档发放的四个区块标题', stillThere.length === 0, stillThere.join(' | '));
    check('gui-ui 仍保留活体发放区块标题',
      uiSrc.includes('<h2>⚡ 活体发放（推荐 · 游戏内即时生效）</h2>'));
    check('★ gui-ui 不再引用已删除的节点 / 函数',
      ['id="cart-body"', 'id="btn-clear"', 'id="btn-preview"', 'id="btn-apply"', 'id="btn-backup"',
        'id="preview-out"', 'id="apply-out"', 'id="preview-hint"',
        'doPreview', 'doApply', 'doBackup', "post('/api/grant/", "post('/api/backup'"]
        .every((k) => !uiSrc.includes(k)));
    check('gui-ui 不再出现「写存档发放」字样', !uiSrc.includes('写存档发放'));

    // --- 11d) 界面：搜索「加入」喂给活体待发放清单 ---
    check('★ 搜索结果的「加入」按钮带 data-add', uiSrc.includes('data-add='));
    check('★ 搜索表点击处理调用 addToPending（把道具加入待发放清单）',
      /search-body'\)\.addEventListener\('click'[\s\S]*?addToPending\(/.test(uiSrc));
    check('★ addToPending 按 id 合并 / 追加到 state.pending',
      uiSrc.includes('state.pending.push') && /found\.quantity \+= nqty/.test(uiSrc));
    check('活体区有待发放清单表（live-cart-body）与「移除」列',
      uiSrc.includes('id="live-cart-body"') && uiSrc.includes('移除'));
    check('活体区有「清空清单」按钮（btn-live-clear）', uiSrc.includes('id="btn-live-clear"'));
    check('活体区有手动「加入清单」按钮（btn-live-add）', uiSrc.includes('id="btn-live-add"'));
    check('★ 预览/发放用待发放清单构造 grants 数组',
      uiSrc.includes('function pendingGrants()') &&
        uiSrc.includes("post('/api/live/grant/preview', { grants: grants })") &&
        uiSrc.includes("post('/api/live/grant/apply'"));
    check('空清单时预览先判空并给出提示（不发请求）',
      /function doLivePreview\(\)[\s\S]*?!state\.pending\.length[\s\S]*?return;/.test(uiSrc));
  }

  // ---------------------------------------------------------------- 阶段 12
  // 道具搜索的四个分类筛选维度：shapeSize 推导（与游戏 qs 一致）、filterItems、facets、中文标签。
  group('阶段 12 · 道具搜索分类筛选（shapeSize / filterItems / facets / 标签）');
  {
    const cat = getCatalog();
    const facets = cat.facets();

    // --- 12a) shapeSize 推导（游戏 qs：占格包围盒 min×max）---
    check('shapeSize: [[1]] → 1x1', deriveShapeSize('[[1]]') === '1x1', String(deriveShapeSize('[[1]]')));
    check('shapeSize: [[1,1],[1,1]] → 2x2', deriveShapeSize('[[1,1],[1,1]]') === '2x2');
    check('shapeSize: null → null', deriveShapeSize(null) === null);
    check('shapeSize: [[1],[1]] → 1x2（游戏归一化 min×max）', deriveShapeSize('[[1],[1]]') === '1x2');
    check('shapeSize: [[1,1,1],[1,1,1]] → 2x3', deriveShapeSize('[[1,1,1],[1,1,1]]') === '2x3');
    check('shapeSize: 数组入参也支持', deriveShapeSize([[1, 1], [1, 1]]) === '2x2');
    check('shapeSize: 非法 JSON → null（不抛）', deriveShapeSize('not json') === null);
    check('shapeSize: 无占格单元 → null', deriveShapeSize('[[0],[0]]') === null);
    check('目录每行都有 shapeSize 字段（null 或 RxC）',
      cat.listAll().every((r) => 'shapeSize' in r && (r.shapeSize === null || /^\d+x\d+$/.test(r.shapeSize))));

    // --- 12b) filterItems 各维度 ---
    const imm = cat.filterItems({ grade: 'immortal' });
    check('filterItems grade=immortal 命中 1 条', imm.length === 1, `${imm.length}`);
    check('filterItems grade=immortal 的结果品阶正确', imm.every((r) => r.grade === 'immortal'));
    const bag = cat.filterItems({ category: 'bag' });
    check('filterItems category=bag 命中 81 条', bag.length === 81, `${bag.length}`);
    const thunder = cat.filterItems({ element: 'thunder' });
    check('filterItems element=thunder 命中 86 条', thunder.length === 86, `${thunder.length}`);
    const s11 = cat.filterItems({ shapeSize: '1x1' });
    check('filterItems shapeSize=1x1 有结果且全为 1x1',
      s11.length > 0 && s11.every((r) => r.shapeSize === '1x1'), `${s11.length}`);
    check('filterItems 无任何条件 → 空数组（保持旧语义）', cat.filterItems({}).length === 0);
    check('filterItems q 与 searchItems 等价', cat.filterItems({ q: '丹' }).length === cat.searchItems('丹').length);

    // --- 12c) q + 筛选 AND 组合 ---
    const combo = cat.filterItems({ q: '丹', category: 'pill' });
    check('filterItems q=丹 & category=pill：非空、是子集、且全为 pill',
      combo.length > 0 && combo.length <= cat.searchItems('丹').length && combo.every((r) => r.category === 'pill'),
      `${combo.length}`);
    const combo2 = cat.filterItems({ q: '丹', category: 'implement' });
    check('filterItems q=丹 & category=implement 同时满足两条件',
      combo2.every((r) => r.category === 'implement' && r.name.includes('丹')), `${combo2.length}`);
    const combo3 = cat.filterItems({ grade: 'common', element: 'fire' });
    check('filterItems grade=common & element=fire 同时满足两条件',
      combo3.length > 0 && combo3.every((r) => r.grade === 'common' && r.element === 'fire'), `${combo3.length}`);

    // --- 12d) facets 计数与顺序 ---
    const sum = (list) => list.reduce((n, o) => n + o.count, 0);
    check('facets.grades 计数和 === 目录总数', sum(facets.grades) === cat.rowCount, `${sum(facets.grades)} vs ${cat.rowCount}`);
    check('facets.elements 计数和 === 目录总数', sum(facets.elements) === cat.rowCount, `${sum(facets.elements)} vs ${cat.rowCount}`);
    check('facets.categories 计数和 === 目录总数', sum(facets.categories) === cat.rowCount, `${sum(facets.categories)} vs ${cat.rowCount}`);
    check('facets.grades 恰为 6 项、顺序与游戏一致',
      facets.grades.map((o) => o.value).join(',') === 'common,spirit,mystic,earth,heaven,immortal');
    check('facets.elements 恰为 10 项、顺序与游戏一致',
      facets.elements.map((o) => o.value).join(',') === 'metal,wood,water,fire,earth,thunder,poison,ice,wind,none');
    check('facets.categories 恰为 12 项（实际出现的分类）', facets.categories.length === 12,
      facets.categories.map((o) => o.value).join(','));
    check('facets.shapeSizes 非空且每项 value 形如 RxC',
      facets.shapeSizes.length > 0 && facets.shapeSizes.every((o) => /^\d+x\d+$/.test(o.value)),
      facets.shapeSizes.map((o) => o.value).join(','));
    check('facets 每项形如 { value,label,count }（count 为正整数）',
      facets.categories.concat(facets.grades, facets.elements, facets.shapeSizes)
        .every((o) => typeof o.value === 'string' && typeof o.label === 'string' && Number.isInteger(o.count) && o.count > 0));

    // --- 12e) 中文标签覆盖：目录实际出现的值都必须有标签（无降级）---
    const labelMaps = { categories: CATEGORY_LABELS, grades: GRADE_LABELS, elements: ELEMENT_LABELS };
    const fallbacks = [];
    for (const key of ['categories', 'grades', 'elements']) {
      for (const o of facets[key]) {
        if (!Object.prototype.hasOwnProperty.call(labelMaps[key], o.value)) fallbacks.push(`${key}:${o.value}`);
      }
    }
    check('★ 目录实际出现的 category/grade/element 值都有中文标签（无降级）', fallbacks.length === 0, fallbacks.join(','));
    check('标签样例：immortal→仙品 / thunder→雷 / bag→储物袋 / recipe→配方 / divination→问签',
      GRADE_LABELS.immortal === '仙品' && ELEMENT_LABELS.thunder === '雷' &&
        CATEGORY_LABELS.bag === '储物袋' && CATEGORY_LABELS.recipe === '配方' &&
        CATEGORY_LABELS.divination === '问签');
    check('shapeSize 标签用 × 连接（1x2 → 1×2）', shapeSizeLabel('1x2') === '1×2');

    // --- 12f) 服务端 /api/items 接受四个筛选参数并回传 facets/filters ---
    const guiSrc = readFileSync(new URL('./gui-server.mjs', import.meta.url), 'utf8');
    check('★ gui-server /api/items 读取 category/grade/element/shape 四个参数',
      ["searchParams.get('category')", "searchParams.get('grade')", "searchParams.get('element')", "searchParams.get('shape')"]
        .every((k) => guiSrc.includes(k)));
    check('★ gui-server /api/items 返回 facets 并回显 filters',
      guiSrc.includes('facets: cat.facets()') && guiSrc.includes('filters,'));
    check('★ gui-server /api/items 用 filterItems 组合筛选', guiSrc.includes('cat.filterItems(filters)'));
  }

  // ---------------------------------------------------------------- 摘要
  const failed = results.filter((r) => !r.ok);
  log('\n' + '='.repeat(68));
  log(`总计 ${results.length} 项断言：PASS ${results.length - failed.length} / FAIL ${failed.length}`);
  if (goldenOk === null) log('注意：未对真实存档做 golden hash 复现（goldenOk=skipped）');
  else if (goldenOk) log('golden：真实存档既有 hash 已被本实现复现 → hash 算法与游戏一致');
  if (failed.length) {
    log('\n失败项：');
    for (const f of failed) log(`  [${f.group}] ${f.name}  ${f.detail}`);
    log('\n结果：FAIL');
    process.exitCode = 1;
  } else {
    log('\n结果：PASS');
  }
}

main().catch((err) => {
  log(`\n自检本身抛错：${err && err.message ? err.message : String(err)}`);
  if (err && err.stack) log(err.stack);
  process.exitCode = 1;
});
