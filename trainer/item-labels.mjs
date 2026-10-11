/**
 * item-labels.mjs —— 道具筛选维度的**中文标签**
 *
 * 这是「道具搜索分类筛选」的显示层数据源：四个维度的 `值 → 中文名` 映射，
 * 与游戏内的筛选下拉完全一致。**未知值一律降级为原始枚举值**（见 `labelOf`），绝不抛错。
 *
 * 四个维度：
 *   - 品阶 GRADE   ：凡品 / 灵品 / 玄品 / 地品 / 天品 / 仙品（顺序即游戏下拉顺序）。
 *   - 元素 ELEMENT ：金 / 木 / 水 / 火 / 土 / 雷 / 毒 / 冰 / 风 / 无。
 *   - 分类 CATEGORY：功法 / 配方 / 丹药 / 法器 / 问签 / 宝箱 / 灵材 / 阵盘 / 符箓 /
 *                    投掷物 / 招式 / 储物袋（另有 `monster` 魔物）。
 *   - 占格尺寸 SHAPE：`RxC`，显示时把 `x` 换成全角 `×`（见 `shapeSizeLabel`）。
 *
 * 注：游戏的「分类」下拉还含 `monster`（魔物），但当前目录（items.csv + 模组）无该值，
 *     `facets()` 只列出实际出现的值，故界面不会显示它。
 */

/** 品阶 value → 中文（顺序即游戏下拉顺序）。 */
export const GRADE_LABELS = Object.freeze({
  common: '凡品',
  spirit: '灵品',
  mystic: '玄品',
  earth: '地品',
  heaven: '天品',
  immortal: '仙品',
});

/** 品阶规范顺序（游戏下拉的键序）。 */
export const GRADE_ORDER = Object.freeze(['common', 'spirit', 'mystic', 'earth', 'heaven', 'immortal']);

/** 元素 value → 中文。 */
export const ELEMENT_LABELS = Object.freeze({
  metal: '金',
  wood: '木',
  water: '水',
  fire: '火',
  earth: '土',
  thunder: '雷',
  poison: '毒',
  ice: '冰',
  wind: '风',
  none: '无',
});

/** 元素规范顺序（游戏下拉的键序）。 */
export const ELEMENT_ORDER = Object.freeze([
  'metal', 'wood', 'water', 'fire', 'earth', 'thunder', 'poison', 'ice', 'wind', 'none',
]);

/** 分类 value → 中文。 */
export const CATEGORY_LABELS = Object.freeze({
  scripture: '功法',
  recipe: '配方',
  pill: '丹药',
  implement: '法器',
  divination: '问签',
  chest: '宝箱',
  material: '灵材',
  formation: '阵盘',
  talisman: '符箓',
  throwable: '投掷物',
  spell: '招式',
  bag: '储物袋',
  monster: '魔物',
});

/** 分类规范顺序（游戏下拉的键序；`monster` 在当前目录中不出现）。 */
export const CATEGORY_ORDER = Object.freeze([
  'scripture', 'recipe', 'pill', 'implement', 'divination', 'chest',
  'material', 'formation', 'talisman', 'throwable', 'spell', 'bag', 'monster',
]);

/**
 * 占格尺寸的**规范顺序**（游戏默认调色板顺序）。目录里实际出现的尺寸都取自同一套 `min×max` 推导，
 * 但个别大尺寸（如 4x4/5x5/6x6/7x7）不在游戏的 9 项默认调色板里 —— 它们会追加在规范项之后。
 */
export const SHAPE_SIZE_ORDER = Object.freeze([
  '1x1', '1x2', '1x3', '2x2', '1x4', '1x5', '2x3', '2x4', '3x3',
]);

/** 尺寸 value → 显示标签（把 `x` 换成全角 `×`）。 */
export function shapeSizeLabel(value) {
  return String(value).replace('x', '×');
}

/**
 * 通用降级取标签：命中映射返回中文，否则返回原始值（字符串）。
 * null / undefined → null。
 * @param {Record<string,string>} map
 * @param {*} value
 * @returns {string|null}
 */
export function labelOf(map, value) {
  if (value === null || value === undefined) return null;
  const key = String(value);
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : key;
}
