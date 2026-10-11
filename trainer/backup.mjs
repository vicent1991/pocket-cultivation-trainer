/**
 * backup.mjs —— 写盘前的强制备份。
 *
 * 规则：
 *   任何真实写入（`writeSaveViaCdp`）之前**必须先调用 `backupSave()`**，
 *   把当前存档文件复制到备份目录，文件名带时间戳。
 *
 * 本模块只做「复制 + 命名 + 记录」，不写回存档、不改动源文件。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_BACKUP_DIR } from './config.mjs';

/**
 * 本地时间戳片段，形如 `20250131-142530`（本地时区，便于人读）。
 * @param {Date} [d]
 */
export function timestampSlug(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 把存档文件复制到备份目录。
 *
 * @param {string} saveFilePath 源存档绝对/相对路径
 * @param {{dir?: string, label?: string, now?: Date}} [opts]
 *        `dir` 默认 `DEFAULT_BACKUP_DIR`（`trainer/backups`）。
 * @returns {{path: string, dir: string, source: string, bytes: number, at: string}}
 */
export function backupSave(saveFilePath, { dir = DEFAULT_BACKUP_DIR, label = '', now = new Date() } = {}) {
  if (!saveFilePath) throw new Error('backupSave: saveFilePath is required');
  if (!dir) throw new Error('backupSave: { dir } is required');

  const source = resolve(saveFilePath);
  if (!existsSync(source)) throw new Error(`backupSave: source file does not exist: ${source}`);

  const destDir = resolve(dir);
  mkdirSync(destDir, { recursive: true });

  const stem = basename(source).replace(/\.json$/i, '') || 'save';
  const suffix = label ? `.${String(label).replace(/[^A-Za-z0-9_-]/g, '_')}` : '';
  let dest = join(destDir, `${stem}.${timestampSlug(now)}${suffix}.json`);

  // 同一秒内重复备份：加序号，绝不覆盖已有备份。
  let n = 2;
  while (existsSync(dest)) {
    dest = join(destDir, `${stem}.${timestampSlug(now)}${suffix}.${n}.json`);
    n += 1;
  }

  copyFileSync(source, dest);
  const bytes = statSync(dest).size;
  return { path: dest, dir: destDir, source, bytes, at: now.toISOString() };
}

/**
 * 备份一份「内存里的存档对象」（尚未落盘的预览结果）为 JSON 文件。
 * 用于把「将要写入的内容」也留一份副本。
 *
 * @param {object} saveObj
 * @param {{dir?: string, label?: string, now?: Date, name?: string}} [opts]
 */
export function backupSaveObject(saveObj, { dir = DEFAULT_BACKUP_DIR, label = 'planned', now = new Date(), name = 'planned' } = {}) {
  if (!saveObj || typeof saveObj !== 'object') throw new Error('backupSaveObject: saveObj is required');
  const destDir = resolve(dir);
  mkdirSync(destDir, { recursive: true });
  const suffix = label ? `.${String(label).replace(/[^A-Za-z0-9_-]/g, '_')}` : '';
  let dest = join(destDir, `${name}.${timestampSlug(now)}${suffix}.json`);
  let n = 2;
  while (existsSync(dest)) {
    dest = join(destDir, `${name}.${timestampSlug(now)}${suffix}.${n}.json`);
    n += 1;
  }
  writeFileSync(dest, JSON.stringify(saveObj, null, 2), 'utf8');
  return { path: dest, dir: destDir, source: null, bytes: statSync(dest).size, at: now.toISOString() };
}

/** 列出备份目录里的备份文件（按文件名倒序 = 最新在前）。 */
export function listBackups(dir = DEFAULT_BACKUP_DIR) {
  const destDir = resolve(dir);
  if (!existsSync(destDir)) return [];
  let ents = [];
  try { ents = readdirSync(destDir, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => {
      const p = join(destDir, e.name);
      let size = 0;
      let mtimeMs = 0;
      try { const st = statSync(p); size = st.size; mtimeMs = st.mtimeMs; } catch { /* ignore */ }
      return { path: p, fileName: e.name, size, mtimeMs };
    })
    .sort((a, b) => b.fileName.localeCompare(a.fileName));
}

export { DEFAULT_BACKUP_DIR };
