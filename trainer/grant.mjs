/**
 * grant.mjs — 核心发放逻辑（纯函数，不做任何 IO）
 *
 * inventoryItems 元素形状（必写 `{instanceId, templateNumericId}`；数量 > 1 时写 `quantity`；
 *   排除 `row` / `col` / `placedAtWorldLogicMs` / `stackedItems`）：
 *   必现 instanceId / templateNumericId / infusedEffects / effectComprehension
 *   近必现 isNew
 *   条件 quantity / isFavorite / star / consumableUsesRemaining / ...
 *   **元素没有 `row` / `col`** —— 网格坐标只存在于 `placedItems` 与
 *   `bagFormations.slots[].placements[]`（`{instanceId,row,col}`）。本模块绝不往
 *   `placedItems` 里加东西，也不给元素加 `row`/`col`。
 *
 * `instanceId`：同一存档内唯一，长度只有 14 与 24 两种，样例 `muvb3y85_hq7je`。
 *   生成算法未知，故本模块自造：`<10位base36>_<5位base36>`，
 *   与既有形状一致，并保证在「已有 inventoryItems ∪ placedItems」内不冲突。
 *   重复 id 会被游戏自动改成 `${o.instanceId}-duplicate-${++a}` —— 那是兜底，不依赖它。
 *
 * ⚠️ quantity 语义：`quantity` 只在少数元素上出现，且值均 > 1（9/5/3/5），
 *   说明「quantity 是堆叠数」。但同 templateNumericId 是否合并、合并上限、
 *   是否影响 effectComprehension 都不确定。因此本模块**不猜**：
 *   `quantity: N` 一律生成 **N 个独立元素、各带唯一 instanceId**，而不是写一个 `quantity: N`
 *   的元素。这样无论堆叠语义如何，N 件道具都真实存在于 `inventoryItems` 中，不会因语义
 *   判断错误而丢件。若日后确认堆叠语义，改 `materializeOne()` 一处即可。
 */
import { randomBytes } from 'node:crypto';

/** 生成一个短 base36 串（长度固定）。 */
function base36(len) {
  let s = '';
  while (s.length < len) {
    s += randomBytes(8).toString('hex').split('')
      .map((c) => parseInt(c, 16).toString(36)).join('');
  }
  return s.slice(0, len);
}

/**
 * 生成一个在 `taken` 中不存在的 instanceId。
 * 形状 `<10位base36>_<5位base36>`（与实测 `muvb3y85_hq7je` 一致）。
 * @param {Set<string>} taken
 */
export function generateInstanceId(taken = new Set()) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = `${base36(10)}_${base36(5)}`;
    if (!taken.has(id)) return id;
  }
  // 极端兜底：加长随机段
  for (;;) {
    const id = `${base36(20)}_${base36(10)}`;
    if (!taken.has(id)) return id;
  }
}

/** 收集存档内所有已用 instanceId（inventoryItems ∪ placedItems）。 */
export function collectInstanceIds(saveObj) {
  const set = new Set();
  const snap = saveObj?.snapshot ?? {};
  for (const list of [snap.inventoryItems, snap.placedItems]) {
    if (!Array.isArray(list)) continue;
    for (const it of list) if (it && typeof it.instanceId === 'string') set.add(it.instanceId);
  }
  return set;
}

/** 构造单个新 inventoryItems 元素（不含 row/col）。 */
function materializeOne(templateNumericId, taken) {
  return {
    instanceId: generateInstanceId(taken),
    templateNumericId,
    isNew: true,
    infusedEffects: [],
    effectComprehension: { rootEffects: {} },
  };
}

/**
 * 发放道具，返回**新的**存档对象（入参不被修改）。
 *
 * @param {object} saveObj 完整存档对象（顶层含 `snapshot`）
 * @param {Array<{templateNumericId: number, quantity?: number}>} grants
 * @param {{catalog?: object}} [opts] `catalog` 仅用于解析失败时补充提示，不参与形状决策
 * @returns {object} 新存档对象（`snapshot.inventoryItems` 已追加）
 */
export function grantItems(saveObj, grants, opts = {}) {
  if (!saveObj || typeof saveObj !== 'object') throw new Error('grantItems: saveObj is required');
  if (!Array.isArray(grants)) throw new Error('grantItems: grants must be an array');
  const snap = saveObj.snapshot;
  if (!snap || typeof snap !== 'object') throw new Error('grantItems: saveObj.snapshot is missing');
  if (!Array.isArray(snap.inventoryItems)) {
    throw new Error('grantItems: saveObj.snapshot.inventoryItems is not an array');
  }

  const taken = collectInstanceIds(saveObj);
  const added = [];

  for (const g of grants) {
    if (!g || typeof g !== 'object') throw new Error('grantItems: each grant must be an object');
    const id = Number(g.templateNumericId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`grantItems: invalid templateNumericId ${JSON.stringify(g.templateNumericId)}`);
    }
    const qty = g.quantity === undefined ? 1 : Number(g.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(`grantItems: invalid quantity ${JSON.stringify(g.quantity)} for template ${id}`);
    }
    // 目录未收录不是错误：csv 不是模板 id 全集（实测缺 87 个特殊族 id），游戏能接受任意 id。
    // 这里不改写入参 grant，也不往返回值里塞诊断字段——调用方要诊断请用 findUncataloged()。
    for (let i = 0; i < qty; i++) {
      const el = materializeOne(id, taken);
      taken.add(el.instanceId);
      added.push(el);
    }
  }

  // 返回值必须与存档 schema 同形：只允许改 snapshot.inventoryItems。
  // 不要在这里追加 __grantedCount / __granted 之类的诊断键——它们会被 normalizeSave
  // 当成存档内容一起写盘，污染 schema（selftest 断言④会因此失败）。
  // 需要新增元素清单请单独调 buildGrantedElements()。
  const nextItems = [...snap.inventoryItems, ...added];
  return {
    ...saveObj,
    snapshot: { ...snap, inventoryItems: nextItems },
  };
}

/**
 * 纯诊断助手：列出 grants 里 catalog 未收录的 templateNumericId（去重、保持首次出现顺序）。
 * 取代早先往入参 grant 对象上写 `__uncataloged` 的做法（那会改写入参，违反纯函数约定）。
 * 未收录不是错误——csv 不是模板 id 全集。
 * @param {Array<{templateNumericId:number}>} grants
 * @param {{isCataloged:(id:number)=>boolean}} catalog
 * @returns {number[]}
 */
export function findUncataloged(grants, catalog) {
  const out = [];
  if (!catalog || typeof catalog.isCataloged !== 'function') return out;
  for (const g of Array.isArray(grants) ? grants : []) {
    const id = Number(g && g.templateNumericId);
    if (Number.isInteger(id) && !catalog.isCataloged(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 只要新元素、不要整档时用这个（便于断言）。逻辑与 grantItems 同源。
 * @returns {Array<object>} 新增的 inventoryItems 元素
 */
export function buildGrantedElements(saveObj, grants) {
  const taken = collectInstanceIds(saveObj);
  const added = [];
  for (const g of grants) {
    const id = Number(g.templateNumericId);
    const qty = g.quantity === undefined ? 1 : Number(g.quantity);
    for (let i = 0; i < qty; i++) {
      const el = materializeOne(id, taken);
      taken.add(el.instanceId);
      added.push(el);
    }
  }
  return added;
}
