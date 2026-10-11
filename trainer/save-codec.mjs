/**
 * save-codec.mjs — 存档 hash 计算与规范化
 *
 * 算法（与游戏字节级一致）：
 *   1. 取整个存档对象的**浅拷贝**，删掉顶层 `snapshotHash` 与 `localSaveHash` 两个字段；
 *   2. 对该对象做**递归规范化** `canonicalize()`：对象按键名 `localeCompare` 升序重排，
 *      数组保持原序（数组是值序列，不是键集合，不能排序）；
 *   3. `JSON.stringify()`（无空格）；
 *   4. UTF-8 编码后 SHA-256；
 *   5. 转小写 hex。
 *
 * 两个字段的值相同：游戏计算一次 hash 后写成 `{...r, snapshotHash: n, localSaveHash: n}`。
 * 游戏侧校验器**不重算 hash、不校验内容**，只查字段类型 +
 * `snapshotHash === localSaveHash` + `characterId`/`saveId` 匹配，所以按本文件重算赋值即可通过。
 *
 * 关键实现约束：必须用 JS 的 `localeCompare`，不能换成按码位排序或 Python 的 sort_keys ——
 * 该存档的 hash 只有在 localeCompare 语义下才能复现（见 selftest 断言 1）。
 */
import { createHash } from 'node:crypto';

/** 顶层 hash 字段名，计算 hash 时必须排除。 */
export const HASH_FIELDS = ['snapshotHash', 'localSaveHash'];

/**
 * 递归按键名 localeCompare 升序规范化。
 * - 对象 → 新对象，键按 localeCompare 升序
 * - 数组 → 新数组，顺序不变（元素递归规范化）
 * - 其它 → 原值
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** 去掉两个顶层 hash 字段的浅拷贝（不修改入参）。 */
export function stripHashes(saveObj) {
  const copy = { ...saveObj };
  for (const f of HASH_FIELDS) delete copy[f];
  return copy;
}

/** SHA-256 → 小写 hex。 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 对任意值计算「规范化后 JSON → SHA-256 → 小写 hex」。 */
export function hashValue(value) {
  return sha256Hex(JSON.stringify(canonicalize(value)));
}

/**
 * 计算存档的 hash。
 * @returns {{snapshotHash: string, localSaveHash: string}} 两者恒等
 */
export function computeHashes(saveObj) {
  const h = hashValue(stripHashes(saveObj));
  return { snapshotHash: h, localSaveHash: h };
}

/** 只算出那一个 hash 字符串（便于断言）。 */
export function computeSaveHash(saveObj) {
  return hashValue(stripHashes(saveObj));
}

/**
 * 把两个 hash 字段设成相等且正确的新值，返回**新对象**（不原地改）。
 * 保留原有键顺序（hash 字段若已存在则原位覆盖，否则追加在末尾）。
 */
export function normalizeSave(saveObj) {
  const h = computeSaveHash(saveObj);
  const out = { ...saveObj };
  for (const f of HASH_FIELDS) out[f] = h;
  return out;
}

/**
 * 校验两 hash 是否相等且与重算值一致。
 * @returns {{ok: boolean, reason: string|null, stored: string|null, recomputed: string}}
 */
export function verifyHashes(saveObj) {
  const stored = saveObj.snapshotHash ?? null;
  const local = saveObj.localSaveHash ?? null;
  const recomputed = computeSaveHash(saveObj);
  if (stored === null || local === null) {
    return { ok: false, reason: 'missing-hash-field', stored, recomputed };
  }
  if (stored !== local) {
    return { ok: false, reason: 'snapshotHash !== localSaveHash', stored, recomputed };
  }
  if (stored !== recomputed) {
    return { ok: false, reason: 'stored hash does not match recomputed hash', stored, recomputed };
  }
  return { ok: true, reason: null, stored, recomputed };
}
