/**
 * gui-ui.mjs —— 单页界面（内联 CSS/JS，零依赖零 CDN）。
 *
 * 设计约束：
 *   - 只有**一条**发放路径：⚡ 活体发放（经 CDP 改游戏活内存，游戏内即时生效、无需重载，
 *     并且会立即真实落盘；发放前强制自动备份）。
 *   - 「发放」是**两步**：先把道具加入待发放清单 → 「预览」（只读，不写游戏）→ 再点
 *     「确认活体发放」才真正 patch。
 *   - 任何真实写入前必须先备份（服务端强制，备份失败即中止）。
 *
 * 注意：本文件内的界面脚本**只用字符串拼接**（不用模板字面量），
 * 这样整段 HTML 可以直接放进外层模板字符串而无需转义。
 */

export const GUI_TITLE = '口袋修仙 · 外置修改器';

/**
 * @param {{guiPort?: number, cdpPort?: number}} [opts]
 * @returns {string} 完整单页 HTML
 */
export function renderHtml({ guiPort = null, cdpPort = null } = {}) {
  const meta = JSON.stringify({ guiPort, cdpPort });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${GUI_TITLE}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 40px; background: #14161a; color: #e6e8ec;
         font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  header { padding: 16px 20px; background: #1b1f26; border-bottom: 1px solid #2a303a;
           position: sticky; top: 0; z-index: 5; display: flex; align-items: baseline; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { color: #8b93a1; font-size: 12px; }
  main { max-width: 1080px; margin: 0 auto; padding: 16px 20px; }
  section { background: #1b1f26; border: 1px solid #2a303a; border-radius: 8px;
            padding: 14px 16px; margin-bottom: 14px; }
  h2 { font-size: 14px; margin: 0 0 10px; color: #b9c2d0; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  input, button, select { font: inherit; border-radius: 6px; border: 1px solid #39414f;
         background: #12151a; color: #e6e8ec; padding: 7px 10px; }
  input[type=number] { width: 90px; }
  button { cursor: pointer; background: #232a34; }
  button:hover:not(:disabled) { background: #2c3540; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary { background: #2b6cb0; border-color: #3b82c4; }
  button.primary:hover:not(:disabled) { background: #3479c0; }
  button.danger { background: #8b2f2f; border-color: #b04040; }
  button.danger:hover:not(:disabled) { background: #a03838; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #262c36; }
  th { color: #8b93a1; font-weight: 500; }
  tbody tr:hover { background: #20262f; }
  .muted { color: #8b93a1; }
  .ok { color: #6fcf7f; }
  .warn { color: #e0b050; }
  .bad { color: #e06a6a; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
          background: #262c36; font-size: 12px; margin-right: 6px; }
  pre { background: #101318; border: 1px solid #262c36; border-radius: 6px; padding: 10px;
        overflow: auto; max-height: 320px; font-size: 12px; margin: 8px 0 0; }
  .diff-add { color: #6fcf7f; }
  .diff-del { color: #e06a6a; }
  .notice { border-left: 3px solid #e0b050; padding: 8px 12px; background: #241f14;
            border-radius: 4px; margin-top: 10px; font-size: 13px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .k { color: #8b93a1; }
</style>
</head>
<body>
<header>
  <h1>${GUI_TITLE}</h1>
  <span class="sub">本地界面 · 零依赖</span>
  <span class="sub" id="meta"></span>
</header>
<main>
  <section>
    <h2>连接状态</h2>
    <div class="row">
      <button id="btn-refresh">刷新状态</button>
      <span id="status-line" class="muted">未检测</span>
    </div>
  </section>

  <section>
    <h2>道具搜索</h2>
    <div class="row">
      <input id="q" placeholder="关键词：名称 / 数字 ID / 分类（如 丹）" style="flex:1;min-width:220px">
      <button id="btn-search" class="primary">搜索</button>
      <span class="muted" id="search-hint"></span>
    </div>
    <div class="row" style="margin-top:8px">
      <label class="k" for="f-category">分类</label>
      <select id="f-category"></select>
      <label class="k" for="f-grade">品阶</label>
      <select id="f-grade"></select>
      <label class="k" for="f-element">元素</label>
      <select id="f-element"></select>
      <label class="k" for="f-shape">占格尺寸</label>
      <select id="f-shape"></select>
      <span class="muted" style="font-size:12px">（分类查找，与关键词同时生效）</span>
    </div>
    <table>
      <thead><tr><th>ID</th><th>名称</th><th>分类</th><th>品阶</th><th>价格</th><th></th></tr></thead>
      <tbody id="search-body"><tr><td colspan="6" class="muted">（无结果）</td></tr></tbody>
    </table>
    <div class="notice">
      「加入」把道具追加到下面「⚡ 活体发放」的<strong>待发放清单</strong>（同一 ID 会累加数量）。
    </div>
  </section>

  <section id="live">
    <h2>⚡ 活体发放（推荐 · 游戏内即时生效）</h2>
    <div class="row">
      <button id="btn-live-refresh">刷新活状态</button>
      <span class="muted" id="live-status-line">（尚未读取）</span>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="k" for="live-item">道具 ID</label>
      <input id="live-item" type="number" min="1" step="1" placeholder="如 1000053">
      <label class="k" for="live-qty">数量</label>
      <input id="live-qty" type="number" min="1" step="1" value="1">
      <button id="btn-live-add">加入清单</button>
    </div>
    <table>
      <thead><tr><th>ID</th><th>名称</th><th>数量</th><th>移除</th></tr></thead>
      <tbody id="live-cart-body"><tr><td colspan="4" class="muted">（清单为空）</td></tr></tbody>
    </table>
    <div class="row" style="margin-top:10px">
      <button id="btn-live-clear">清空清单</button>
      <button id="btn-live-preview" class="primary">预览（只读，不改游戏）</button>
    </div>
    <div class="notice">
      活体发放经 CDP 直接把道具注入<strong>当前正在运行</strong>的游戏状态，<strong>立即生效、无需重载存档</strong>；
      并且会<strong>立即真实落盘</strong>（发放前自动备份存档）——游戏退出后依然保留。
    </div>
    <pre id="live-preview-out">（尚未预览）</pre>
    <div class="row">
      <button id="btn-live-apply" class="danger" disabled>确认活体发放（立即生效）</button>
    </div>
    <pre id="live-apply-out">（尚未发放）</pre>
  </section>

  <section>
    <h2>日志</h2>
    <pre id="log">（空）</pre>
  </section>
</main>
<script>
(function () {
  'use strict';
  var META = ${meta};
  var state = { pending: [], items: [], livePreview: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function baseName(p) {
    if (!p) return '(未知)';
    var s = String(p);
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  // 活体预览：只给要点（发什么 / 背包前后），不铺原始 JSON；支持多条发放。
  function describeLivePreview(pv) {
    if (!pv) return '（预览无数据）';
    var list = pv.added || [];
    var lines = ['将发放 ' + (pv.addedTotal || 0) + ' 件道具：'];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      lines.push('  + ' + a.quantity + ' × ' + a.name + '（ID ' + a.templateNumericId + '）');
    }
    lines.push('背包 inventoryItems：' + pv.inventoryBefore + ' → ' + pv.inventoryAfter);
    lines.push('（尚未写入；点「确认活体发放」才会生效）');
    return lines.join('\\n');
  }
  function log(msg) {
    var el = $('log');
    var line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.textContent = (el.textContent === '（空）' ? '' : el.textContent + '\\n') + line;
    el.scrollTop = el.scrollHeight;
  }
  function setText(id, text, cls) {
    var el = $(id);
    el.textContent = text;
    el.className = cls || 'muted';
  }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var body = null;
        try { body = t ? JSON.parse(t) : null; } catch (e) { body = { raw: t }; }
        if (!r.ok) {
          var m = (body && (body.error || body.message)) || ('HTTP ' + r.status);
          throw new Error(m);
        }
        return body;
      });
    });
  }
  function post(path, payload) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  }

  $('meta').textContent = 'gui :' + (META.guiPort === null ? '?' : META.guiPort) +
    ' · cdp :' + (META.cdpPort === null ? '?' : META.cdpPort);

  // ---- 状态 ---------------------------------------------------------------
  function refreshStatus() {
    setText('status-line', '检测中…', 'muted');
    api('/api/status').then(function (s) {
      var cls = s.cdp && s.cdp.mainTargetFound ? 'ok' : (s.cdp && s.cdp.endpointUp ? 'warn' : 'bad');
      var text = s.cdp && s.cdp.mainTargetFound
        ? '已连接：主 target 命中（title = ' + s.cdp.mainTargetTitle + '）'
        : (s.cdp && s.cdp.endpointUp
            ? '调试端口已开，但未找到主窗口（title 应为 口袋修仙）'
            : '未检测到调试端口 —— 请用本工具的 serve/read 启动游戏，或手动带 POCKET_DESKTOP_E2E=1 启动');
      setText('status-line', text, cls);
    }).catch(function (e) {
      setText('status-line', '状态查询失败：' + e.message, 'bad');
      log('状态查询失败：' + e.message);
    });
  }

  // ---- 搜索 + 分类筛选 -----------------------------------------------------
  var FILTER_IDS = ['f-category', 'f-grade', 'f-element', 'f-shape'];
  function currentFilters() {
    return {
      category: $('f-category').value,
      grade: $('f-grade').value,
      element: $('f-element').value,
      shapeSize: $('f-shape').value,
    };
  }
  // 重建某个下拉的选项：首项「全部」+ 各值「中文名（计数）」，并保持当前选中值。
  function fillSelect(id, options, selected) {
    var el = $(id);
    var html = '<option value="">全部</option>';
    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      html += '<option value="' + esc(o.value) + '">' + esc(o.label) + '（' + o.count + '）</option>';
    }
    el.innerHTML = html;
    el.value = selected || '';
  }
  function renderFacets(facets) {
    if (!facets) return;
    var sel = currentFilters();
    fillSelect('f-category', facets.categories || [], sel.category);
    fillSelect('f-grade', facets.grades || [], sel.grade);
    fillSelect('f-element', facets.elements || [], sel.element);
    fillSelect('f-shape', facets.shapeSizes || [], sel.shapeSize);
  }
  function loadFacets() {
    api('/api/items').then(function (res) {
      renderFacets(res.facets);
    }).catch(function (e) {
      log('筛选选项加载失败：' + e.message);
    });
  }
  function doSearch() {
    var q = $('q').value.trim();
    var f = currentFilters();
    var hasFilter = !!(f.category || f.grade || f.element || f.shapeSize);
    if (!q && !hasFilter) { log('请输入关键词或选择筛选条件（如：丹）'); return; }
    var qs = 'q=' + encodeURIComponent(q);
    if (f.category) qs += '&category=' + encodeURIComponent(f.category);
    if (f.grade) qs += '&grade=' + encodeURIComponent(f.grade);
    if (f.element) qs += '&element=' + encodeURIComponent(f.element);
    if (f.shapeSize) qs += '&shape=' + encodeURIComponent(f.shapeSize);
    setText('search-hint', '搜索中…');
    api('/api/items?' + qs).then(function (res) {
      state.items = res.items || [];
      renderFacets(res.facets);
      setText('search-hint', '命中 ' + state.items.length + ' 条（道具表共 ' + (res.rowCount || 0) + ' 条）');
      renderSearch();
      log('搜索 ' + (q ? '"' + q + '"' : '（仅筛选）') + '：' + state.items.length + ' 条');
    }).catch(function (e) {
      setText('search-hint', '搜索失败：' + e.message, 'bad');
    });
  }
  function renderSearch() {
    var body = $('search-body');
    if (!state.items.length) { body.innerHTML = '<tr><td colspan="6" class="muted">（无结果）</td></tr>'; return; }
    body.innerHTML = state.items.slice(0, 200).map(function (it) {
      return '<tr>' +
        '<td>' + esc(it.templateNumericId) + '</td>' +
        '<td>' + esc(it.name) + '</td>' +
        '<td>' + esc(it.category) + '</td>' +
        '<td>' + esc(it.grade) + '</td>' +
        '<td>' + esc(it.price) + '</td>' +
        '<td><button data-add="' + esc(it.templateNumericId) + '">加入</button></td>' +
        '</tr>';
    }).join('');
  }

  // ---- 待发放清单（活体发放）-----------------------------------------------
  // 清单元素：{ templateNumericId, name, quantity }。同一 ID 合并、数量累加。
  function addToPending(id, qty, name) {
    var nid = Math.floor(Number(id));
    var nqty = Math.floor(Number(qty));
    if (!Number.isFinite(nid) || nid <= 0) { log('请输入正整数道具 ID'); return; }
    if (!Number.isFinite(nqty) || nqty <= 0) { log('请输入正整数数量'); return; }
    var found = state.pending.filter(function (c) { return c.templateNumericId === nid; })[0];
    if (found) found.quantity += nqty;
    else state.pending.push({ templateNumericId: nid, name: name || '（未收录）', quantity: nqty });
    renderPending();
    log('加入清单：' + (name || '（未收录）') + ' (' + nid + ') × ' + nqty);
  }
  function renderPending() {
    var body = $('live-cart-body');
    if (!state.pending.length) { body.innerHTML = '<tr><td colspan="4" class="muted">（清单为空）</td></tr>'; }
    else {
      body.innerHTML = state.pending.map(function (c, i) {
        return '<tr>' +
          '<td>' + esc(c.templateNumericId) + '</td>' +
          '<td>' + esc(c.name) + '</td>' +
          '<td><input type="number" min="1" step="1" value="' + esc(c.quantity) + '" data-qty="' + i + '"></td>' +
          '<td><button data-del="' + i + '">移除</button></td>' +
          '</tr>';
      }).join('');
    }
    // 清单变了 → 之前的预览作废，必须重新预览才能发放。
    state.livePreview = null;
    $('btn-live-apply').disabled = true;
    $('live-preview-out').textContent = '（尚未预览）';
  }
  function pendingGrants() {
    return state.pending.map(function (c) {
      return { templateNumericId: c.templateNumericId, quantity: c.quantity };
    });
  }

  // ---- 活体发放（只读状态 + 两步确认；发放前强制备份，生效即落盘） ----------------------------
  function refreshLive() {
    setText('live-status-line', '检测中…', 'muted');
    api('/api/live/status').then(function (s) {
      var ok = s && s.ok === true;
      var text;
      var cls;
      if (!ok) {
        text = '活体不可用：' + ((s && s.error) || '未知原因');
        cls = 'bad';
      } else if (s.inGame === false) {
        // 主菜单 / 未载入存档：活体发放会被拒绝（patch 不会持久化）。
        text = '⚠️ 游戏未进入角色会话（主菜单 / 未载入存档）：活体发放会被拒绝，请先在游戏里进入一个存档。';
        cls = 'warn';
      } else {
        text = '活状态桥就绪 · 已在角色会话中 · 背包 ' + (s.summary && s.summary.inventoryItemsLength) +
          ' 件 · bagSize=' + (s.summary && s.summary.bagSize);
        cls = 'ok';
      }
      setText('live-status-line', text, cls);
    }).catch(function (e) {
      setText('live-status-line', '活状态查询失败：' + e.message, 'bad');
      log('活状态查询失败：' + e.message);
    });
  }

  function doLivePreview() {
    if (!state.pending.length) { log('待发放清单为空：先用「加入」或「加入清单」添加道具。'); return; }
    var grants = pendingGrants();
    $('btn-live-preview').disabled = true;
    $('btn-live-apply').disabled = true;
    state.livePreview = null;
    post('/api/live/grant/preview', { grants: grants }).then(function (res) {
      $('live-preview-out').textContent = describeLivePreview(res.preview);
      state.livePreview = res;
      $('btn-live-apply').disabled = !res.previewToken;
      log('活体预览完成：inventoryItems ' + res.preview.inventoryBefore + ' → ' + res.preview.inventoryAfter +
        '（未修改游戏）');
    }).catch(function (e) {
      $('live-preview-out').textContent = '预览失败：' + e.message;
      log('活体预览失败：' + e.message);
    }).then(function () { $('btn-live-preview').disabled = false; });
  }

  function doLiveApply() {
    if (!state.livePreview || !state.livePreview.previewToken) { log('请先预览'); return; }
    if (!window.confirm('确认把道具注入正在运行的游戏？会立即生效，并会立即真实落盘（发放前已自动备份存档），退出游戏后依然保留。')) return;
    $('btn-live-apply').disabled = true;
    post('/api/live/grant/apply', { previewToken: state.livePreview.previewToken, confirm: true }).then(function (res) {
      if (res && res.verified === true) {
        $('live-apply-out').textContent = '✅ 发放成功：背包 inventoryItems ' + res.beforeCount + ' → ' + res.afterCount +
          '（写后校验通过）\\n备份：' + baseName(res.backupPath);
        log('活体发放完成（写后校验通过）：inventoryItems ' + res.beforeCount + ' → ' + res.afterCount + '。');
      } else {
        $('live-apply-out').textContent = '❌ 发放未通过写后校验：' +
          ((res && res.reason) || 'verified !== true') + '（本次不算成功）。';
        log('活体发放未通过写后校验：' + ((res && res.reason) || 'verified !== true') + '（本次不算成功）。');
      }
      state.livePreview = null;
      refreshLive();
    }).catch(function (e) {
      $('live-apply-out').textContent = '发放失败：' + e.message;
      log('活体发放失败：' + e.message);
    });
  }

  // ---- 事件绑定 -----------------------------------------------------------
  $('btn-live-refresh').addEventListener('click', refreshLive);
  $('btn-live-add').addEventListener('click', function () {
    var id = Math.floor(Number($('live-item').value));
    var qty = Math.floor(Number($('live-qty').value));
    if (!Number.isFinite(id) || id <= 0) { log('请输入正整数道具 ID'); return; }
    if (!Number.isFinite(qty) || qty <= 0) { log('请输入正整数数量'); return; }
    var known = state.items.filter(function (x) { return x.templateNumericId === id; })[0];
    addToPending(id, qty, known ? known.name : '（未收录）');
  });
  $('btn-live-clear').addEventListener('click', function () {
    state.pending = [];
    renderPending();
    log('已清空待发放清单');
  });
  $('btn-live-preview').addEventListener('click', doLivePreview);
  $('btn-live-apply').addEventListener('click', doLiveApply);
  $('live-item').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btn-live-add').click(); });
  $('live-qty').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btn-live-add').click(); });
  $('btn-refresh').addEventListener('click', refreshStatus);
  $('btn-search').addEventListener('click', doSearch);
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  for (var fi = 0; fi < FILTER_IDS.length; fi++) {
    (function (id) { $(id).addEventListener('change', doSearch); })(FILTER_IDS[fi]);
  }

  $('search-body').addEventListener('click', function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute('data-add');
    if (id !== null && id !== undefined) {
      var it = state.items.filter(function (x) { return String(x.templateNumericId) === String(id); })[0];
      if (it) addToPending(it.templateNumericId, 1, it.name);
    }
  });
  $('live-cart-body').addEventListener('click', function (e) {
    var del = e.target && e.target.getAttribute && e.target.getAttribute('data-del');
    if (del !== null && del !== undefined) { state.pending.splice(Number(del), 1); renderPending(); }
  });
  $('live-cart-body').addEventListener('change', function (e) {
    var idx = e.target && e.target.getAttribute && e.target.getAttribute('data-qty');
    if (idx === null || idx === undefined) return;
    var v = Math.floor(Number(e.target.value));
    state.pending[Number(idx)].quantity = (Number.isFinite(v) && v > 0) ? v : 1;
    state.livePreview = null;
    $('btn-live-apply').disabled = true;
  });

  refreshStatus();
  loadFacets();
  log('界面就绪。');
})();
</script>
</body>
</html>
`;
}

export default renderHtml;
