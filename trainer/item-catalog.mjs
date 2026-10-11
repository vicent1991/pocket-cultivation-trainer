/**
 * item-catalog.mjs — 模板目录（读取 gamedata\items.csv）
 *
 * ⚠️ 重要限制：**csv 不是模板 id 全集。**
 *   实测（遍历全部真实存档的 snapshot.inventoryItems[].templateNumericId 去重）：
 *     存档去重后 distinct id = 1401；csv rowCount = 2080；
 *     其中 csv 收录 1314 个，**未收录 87 个**。
 *   未收录的是这些**特殊/隐藏族**（不是 `41xxxx`——`41xxxx` 反而在 csv 内，
 *   实测 `410250` / `411104` / `411402` / `411952` 均能查到，csv 中 id >= 400000 的有 1801 个）：
 *     19xxxx / 199xxx / 20xxxx / 39xxxx / 40xxxx（仅 400138,400324,400421,400425,400429,400431,400434,400435）
 *     / 49xxxx（最大一族，含 490xxx、491xxx）/ 59xxxx / 79xxxx / 89xxxx（8901xx、899xxx）
 *   因此本模块提供 `isCataloged(id)`，让调用方区分
 *   「csv 里没有这个名字」和「这个 id 不存在」。发放道具**不要求** id 在 csv 内 ——
 *   游戏本身能接受任意 id，csv 只用于显示名字/分类。
 *
 * 文件：<仓库根>\gamedata\items.csv（本模块以 `join(HERE, '..', 'gamedata', 'items.csv')` 相对定位）
 *   2298214 B / 2081 行（1 表头 + 2080 数据行）/ 14 列。
 *   表头：numericId,name,category,grade,element,iconBasename,isPublished,
 *         isObtainable,description,shape,distribution,effectList,price,modOverridePolicy
 *
 * 解析要点：`effectList`（第 12 列）是内嵌 JSON，含**双写引号**（`""`）与逗号；
 * `name` / `description` 是中文自由文本。所以**必须实现 RFC4180 引号感知解析**，
 * 不能按 `,` 直接 split，也不能按 `"` 简单切分。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_GAME_EXE, defaultModsDir, defaultWorkshopDir } from './config.mjs';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  ELEMENT_LABELS,
  ELEMENT_ORDER,
  GRADE_LABELS,
  GRADE_ORDER,
  SHAPE_SIZE_ORDER,
  labelOf,
  shapeSizeLabel,
} from './item-labels.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** csv 默认路径（trainer\ 的上一级 → gamedata\items.csv）。 */
export const DEFAULT_CSV_PATH = join(HERE, '..', 'gamedata', 'items.csv');

/** 本地模组目录默认值：%APPDATA%\Pocket Cultivation Demo\mods。 */
export const DEFAULT_MODS_DIR = defaultModsDir();

/** 创意工坊模组目录默认值：由默认 gameExe 反推（`<steamapps>\workshop\content\4777710`）。
 *  默认 gameExe 为 null（无硬编码路径），故此处默认为 null；实际值由调用方按解析后的 gameExe 传入。 */
export const DEFAULT_WORKSHOP_DIR = defaultWorkshopDir(DEFAULT_GAME_EXE);

/** 期望的表头（用于自检列顺序是否漂移）。 */
export const EXPECTED_HEADER = [
  'numericId', 'name', 'category', 'grade', 'element', 'iconBasename', 'isPublished',
  'isObtainable', 'description', 'shape', 'distribution', 'effectList', 'price',
  'modOverridePolicy',
];

/**
 * RFC4180 引号感知 CSV 解析。
 * - `""` 在引号字段内表示一个字面 `"`
 * - 引号字段内的 `,` 与换行不切分
 * - 支持 `\n` 与 `\r\n`
 * @returns {string[][]} 行 × 列的原始字符串矩阵（不含表头剔除）
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  // 去掉 BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  // 收尾（最后一行没有换行符时）
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function toBool(v) {
  const s = String(v).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

function parseJsonCell(v) {
  const s = String(v).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return undefined; } // undefined = 解析失败
}

/**
 * 从道具的 `shape` 网格推导「占格尺寸」`RxC`。
 *
 * 与游戏**完全一致**：
 *   取所有占格（真值）单元的**包围盒**，返回 `min(行跨度,列跨度) x max(...)`。
 * 因此 `[[1],[1]]`（2 行 1 列）与 `[[1,1]]`（1 行 2 列）都归一化为 `1x2`。
 *
 * 输入可为 JSON 字符串或二维数组；null / 空 / 非法 JSON / 无占格单元 → `null`（降级，不抛错）。
 * @param {string|Array|null|undefined} shape
 * @returns {string|null} 形如 `1x1` / `2x3`，或 null
 */
export function deriveShapeSize(shape) {
  let grid = shape;
  if (typeof grid === 'string') {
    const s = grid.trim();
    if (!s) return null;
    try { grid = JSON.parse(s); } catch { return null; }
  }
  if (!Array.isArray(grid) || grid.length === 0) return null;

  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  let any = false;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue; // 只统计占格单元
      any = true;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  if (!any) return null;
  const rows = maxR - minR + 1;
  const cols = maxC - minC + 1;
  return `${Math.min(rows, cols)}x${Math.max(rows, cols)}`;
}

/**
 * 把模组「新增道具」（`{"mode":"add","item":{...}}` 的 `item`）转成与 csv 行**同名键**的目录行。
 * 键名与 csv 列一一对应，故 searchItems / getItem / listAll 无需改动即可用。
 * 缺失字段一律落为 null（而不是 undefined），保持行形状稳定。
 */
function rowFromModItem(item, numericId) {
  const shape =
    item.shape === undefined || item.shape === null
      ? null
      : typeof item.shape === 'string'
        ? item.shape
        : JSON.stringify(item.shape);
  const price = Number(item.price);
  return {
    templateNumericId: numericId,
    name: item.name === undefined || item.name === null ? '' : String(item.name),
    category: item.category === undefined || item.category === null ? '' : String(item.category),
    grade: item.grade ?? null,
    element: item.element ?? null,
    iconBasename: item.iconBasename ?? null,
    isPublished: typeof item.isPublished === 'boolean' ? item.isPublished : null,
    isObtainable: typeof item.isObtainable === 'boolean' ? item.isObtainable : null,
    description: item.description ?? null,
    shape,
    shapeSize: deriveShapeSize(shape),
    distribution: item.distribution ?? null,
    effectList: item.effectList ?? null,
    price: Number.isFinite(price) ? price : null,
    modOverridePolicy: item.modOverridePolicy ?? null,
  };
}

/** 一个路径是否是普通文件（不存在 / 是目录 → false）。 */
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * 扫描**单个模组根目录**，收集新增道具（只认 `mode:"add"`，忽略 `mode:"override"` 的补丁）。
 *
 * 目录解析（两段式，不再递归更深）：根目录的每个直接子目录 D ——
 *   1. `<D>\manifest.json` 存在 → 模组目录 = D（depth 0；创意工坊的 `<publishedFileId>\manifest.json`）；
 *   2. 否则看 D 的直接子目录 S：`<S>\manifest.json` 存在 → 模组目录 = S（depth 1；创意工坊的
 *      `<publishedFileId>\<modId>\manifest.json`）。
 * 两者都没有 → 忽略 D（根下的杂散文件 / 非模组目录，例如 `README-创意工坊.txt`、`*.vdf`）。
 *
 * 道具文件在 `<modDir>\<manifest.domains.items.path>\*.json`。无 `items` domain 的模组跳过。
 * 健壮性：**任何一个坏文件都不会打断整次扫描** —— 记进 `errors` 继续；
 * 模组目录整体不存在 → 返回空结果（不是错误）。
 *
 * @param {string|null|undefined} root
 * @param {'local'|'workshop'} origin
 * @returns {{ items: object[], mods: object[], errors: {file:string,message:string}[] }}
 */
function scanModRoot(root, origin) {
  const out = { items: [], mods: [], errors: [] };
  if (!root) return out; // 未配置 / 缺失 → 空结果

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // 目录不存在 / 不可读 → 空结果，不算错误
  }

  // 先解析出模组目录 + 发布 id（创意工坊 = workshop 根下的第一段路径）。
  const targets = []; // { dir, publishedFileId, fallbackId }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue; // 杂散文件直接忽略
    const child = join(root, ent.name);
    if (isFile(join(child, 'manifest.json'))) {
      targets.push({ dir: child, publishedFileId: ent.name, fallbackId: ent.name });
      continue; // depth 0 命中 → 不再往下找
    }
    let subs;
    try { subs = readdirSync(child, { withFileTypes: true }); } catch { continue; }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const subDir = join(child, sub.name);
      if (isFile(join(subDir, 'manifest.json'))) {
        targets.push({ dir: subDir, publishedFileId: ent.name, fallbackId: sub.name });
      }
    }
  }

  for (const { dir: modDir, publishedFileId, fallbackId } of targets) {
    const manifestPath = join(modDir, 'manifest.json');

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      out.errors.push({ file: manifestPath, message: `manifest 不可读或非法 JSON：${err.message}` });
      continue;
    }
    if (!manifest || typeof manifest !== 'object') {
      out.errors.push({ file: manifestPath, message: 'manifest 不是 JSON 对象' });
      continue;
    }

    const isWorkshop = origin === 'workshop';
    const modId = typeof manifest.id === 'string' && manifest.id ? manifest.id : fallbackId;
    const modName = typeof manifest.name === 'string' && manifest.name ? manifest.name : modId;
    const record = {
      id: modId,
      name: modName,
      dir: modDir,
      enabled: manifest.enabled !== false,
      itemCount: 0,
      origin,
    };
    if (isWorkshop) record.publishedFileId = publishedFileId;
    out.mods.push(record);

    const itemsDomain = manifest.domains && manifest.domains.items;
    if (!itemsDomain || typeof itemsDomain.path !== 'string' || !itemsDomain.path) {
      continue; // 没有 items domain → 跳过（例如只有 scripts / maps 的模组）
    }

    const itemsDir = join(modDir, itemsDomain.path);
    let files;
    try {
      files = readdirSync(itemsDir).filter((f) => typeof f === 'string' && f.endsWith('.json'));
    } catch (err) {
      out.errors.push({ file: itemsDir, message: `items 目录不可读：${err.message}` });
      continue;
    }

    for (const fname of files) {
      const file = join(itemsDir, fname);
      let doc;
      try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        out.errors.push({ file, message: `非法 JSON：${err.message}` });
        continue; // 单个坏文件不影响其它文件
      }
      if (!doc || typeof doc !== 'object') {
        out.errors.push({ file, message: '文件内容不是 JSON 对象' });
        continue;
      }
      if (doc.mode !== 'add') continue; // 只收新增；override 补丁忽略
      const item = doc.item;
      if (!item || typeof item !== 'object') {
        out.errors.push({ file, message: 'mode="add" 但缺少 item 对象' });
        continue;
      }
      const numericId = Number(item.numericId);
      if (!Number.isInteger(numericId)) {
        out.errors.push({
          file,
          message: `item.numericId 不是整数：${JSON.stringify(item.numericId)}`,
        });
        continue;
      }
      const source = { modId, modName, file, origin };
      if (isWorkshop) source.publishedFileId = publishedFileId;
      out.items.push({
        ...rowFromModItem(item, numericId),
        source,
      });
      record.itemCount += 1;
    }
  }

  return out;
}

/**
 * 扫描**两个**模组根目录（本地 + 创意工坊）并合并成一份结果。
 * 目录解析规则见 `scanModRoot`；本地根的 `<modsDir>\<modId>\manifest.json` 即 depth 0 情形。
 *
 * @param {string|null|undefined} modsDir 本地模组目录
 * @param {string|null|undefined} [workshopDir] 创意工坊模组目录
 * @returns {{
 *   items: object[], mods: object[], errors: {file:string,message:string}[],
 *   local: {mods:number, items:number}, workshop: {mods:number, items:number}
 * }}
 */
export function scanModItems(modsDir, workshopDir) {
  const local = scanModRoot(modsDir, 'local');
  const workshop = scanModRoot(workshopDir, 'workshop');
  return {
    items: [...local.items, ...workshop.items],
    mods: [...local.mods, ...workshop.mods],
    errors: [...local.errors, ...workshop.errors],
    local: { mods: local.mods.length, items: local.items.length },
    workshop: { mods: workshop.mods.length, items: workshop.items.length },
  };
}

/**
 * 加载并索引 csv，再合并本地模组新增道具。
 * 目录 = csv 行 + 模组行；同一 numericId 冲突时**模组行优先**。
 * @param {string} [csvPath]
 * @param {string|null} [modsDir]
 * @returns {{
 *   byId: Map<number, object>, header: string[], rowCount: number, csvRowCount: number,
 *   modItemCount: number, modCount: number, modCollisions: number,
 *   mods: object[], modErrors: {file:string,message:string}[],
 *   csvPath: string, modsDir: string|null, workshopDir: string|null,
 *   localModCount: number, workshopModCount: number,
 *   localItemCount: number, workshopItemCount: number,
 *   parseErrors: string[],
 *   getItem(id: number): object|null,
 *   isCataloged(id: number): boolean,
 *   searchItems(keyword: string): object[],
 *   filterItems(f: {q?,category?,grade?,element?,shapeSize?}): object[],
 *   facets(): {categories:object[], grades:object[], elements:object[], shapeSizes:object[]},
 *   listAll(): object[]
 * }}
 */
export function loadCatalog(csvPath = DEFAULT_CSV_PATH, modsDir = DEFAULT_MODS_DIR, workshopDir = DEFAULT_WORKSHOP_DIR) {
  const text = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`empty csv: ${csvPath}`);

  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const col of ['numericId', 'name', 'category']) {
    if (!(col in idx)) throw new Error(`csv missing required column "${col}": ${csvPath}`);
  }

  const byId = new Map();
  const parseErrors = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0].trim() === '') continue; // 尾部空行
    const id = Number(cells[idx.numericId]);
    if (!Number.isInteger(id)) {
      parseErrors.push(`row ${r + 1}: numericId not an integer: ${JSON.stringify(cells[idx.numericId])}`);
      continue;
    }
    const distribution = parseJsonCell(cells[idx.distribution]);
    const effectList = parseJsonCell(cells[idx.effectList]);
    if (distribution === undefined) parseErrors.push(`row ${r + 1} (id ${id}): distribution is not valid JSON`);
    if (effectList === undefined) parseErrors.push(`row ${r + 1} (id ${id}): effectList is not valid JSON`);

    byId.set(id, {
      templateNumericId: id,
      name: cells[idx.name],
      category: cells[idx.category],
      grade: cells[idx.grade],
      element: cells[idx.element],
      iconBasename: cells[idx.iconBasename],
      isPublished: toBool(cells[idx.isPublished]),
      isObtainable: toBool(cells[idx.isObtainable]),
      description: cells[idx.description],
      shape: cells[idx.shape],
      shapeSize: deriveShapeSize(cells[idx.shape]),
      distribution: distribution === undefined ? null : distribution,
      effectList: effectList === undefined ? null : effectList,
      price: Number(cells[idx.price]),
      modOverridePolicy: cells[idx.modOverridePolicy],
    });
  }
  const csvRowCount = byId.size;

  // ---- 合并模组新增道具（本地 + 创意工坊；模组行在 numericId 冲突时覆盖 csv 行）----
  const scan = scanModItems(modsDir, workshopDir);
  let modCollisions = 0;
  for (const row of scan.items) {
    if (byId.has(row.templateNumericId)) modCollisions += 1;
    byId.set(row.templateNumericId, row);
  }

  const all = () => [...byId.values()];

  // ---- 分类筛选（与游戏一致：关键词 + 四个维度，AND 组合）----
  const norm = (v) => (v === null || v === undefined ? '' : String(v).trim());

  /**
   * 按关键词 + 分类/品阶/元素/占格尺寸筛选目录（各维度 AND）。
   * 关键词与旧 `searchItems` 一致：匹配名称 / 数字 ID / 分类（不区分大小写）。
   * **无任何条件时返回空数组**（保持 `/api/items?q=` 的旧语义）。
   * @param {{q?:string, category?:string, grade?:string, element?:string, shapeSize?:string}} [f]
   */
  function filterItems(f = {}) {
    const k = norm(f.q).toLowerCase();
    const category = norm(f.category);
    const grade = norm(f.grade);
    const element = norm(f.element);
    const shapeSize = norm(f.shapeSize);
    if (!k && !category && !grade && !element && !shapeSize) return [];
    return all().filter((it) => {
      if (k) {
        const hit =
          it.name.toLowerCase().includes(k) ||
          String(it.templateNumericId).includes(k) ||
          norm(it.category).toLowerCase().includes(k);
        if (!hit) return false;
      }
      if (category && norm(it.category) !== category) return false;
      if (grade && norm(it.grade) !== grade) return false;
      if (element && norm(it.element) !== element) return false;
      if (shapeSize && norm(it.shapeSize) !== shapeSize) return false;
      return true;
    });
  }

  /** 统计某取值维度的计数（跳过 null/空值）。 */
  function countBy(getter) {
    const m = new Map();
    for (const it of all()) {
      const v = getter(it);
      if (v === null || v === undefined || v === '') continue;
      const key = String(v);
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }

  /** 按游戏规范顺序列出**实际出现**的选项；规范表之外的取值追加在后（排序）。 */
  function facetList(counts, order, labelFn) {
    const ordered = order.filter((v) => counts.has(v));
    const extras = [...counts.keys()].filter((v) => !order.includes(v)).sort();
    for (const v of extras) ordered.push(v);
    return ordered.map((v) => ({ value: v, label: labelFn(v), count: counts.get(v) }));
  }

  /**
   * 返回四个维度的选项列表（**全目录计数**、游戏规范顺序、`{value,label,count}`）。
   * 只列实际出现的取值；未知取值降级为原始值作标签。
   * @returns {{categories:object[], grades:object[], elements:object[], shapeSizes:object[]}}
   */
  function facets() {
    return {
      categories: facetList(countBy((it) => it.category), CATEGORY_ORDER, (v) => labelOf(CATEGORY_LABELS, v)),
      grades: facetList(countBy((it) => it.grade), GRADE_ORDER, (v) => labelOf(GRADE_LABELS, v)),
      elements: facetList(countBy((it) => it.element), ELEMENT_ORDER, (v) => labelOf(ELEMENT_LABELS, v)),
      shapeSizes: facetList(countBy((it) => it.shapeSize), SHAPE_SIZE_ORDER, shapeSizeLabel),
    };
  }

  return {
    byId,
    header,
    rowCount: byId.size,
    csvRowCount,
    modItemCount: scan.items.length,
    modCount: scan.mods.length,
    localModCount: scan.local.mods,
    workshopModCount: scan.workshop.mods,
    localItemCount: scan.local.items,
    workshopItemCount: scan.workshop.items,
    modCollisions,
    mods: scan.mods,
    modErrors: scan.errors,
    csvPath,
    modsDir: modsDir || null,
    workshopDir: workshopDir || null,
    parseErrors,
    getItem: (id) => byId.get(Number(id)) ?? null,
    isCataloged: (id) => byId.has(Number(id)),
    searchItems: (keyword) => filterItems({ q: keyword }),
    filterItems,
    facets,
    listAll: all,
  };
}

/** 进程级缓存的默认目录（避免 selftest 反复读 2.3 MB）。 */
let cached = null;
export function getCatalog(
  csvPath = DEFAULT_CSV_PATH,
  modsDir = DEFAULT_MODS_DIR,
  workshopDir = DEFAULT_WORKSHOP_DIR,
) {
  if (
    !cached ||
    cached.csvPath !== csvPath ||
    cached.modsDir !== (modsDir || null) ||
    cached.workshopDir !== (workshopDir || null)
  ) {
    cached = loadCatalog(csvPath, modsDir, workshopDir);
  }
  return cached;
}
