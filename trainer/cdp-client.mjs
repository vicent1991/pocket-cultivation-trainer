// cdp-client.mjs — 极简 CDP 客户端（零依赖，用 Node 内建全局 WebSocket）
//
// 关键点：
//   * contextIsolation:true + sandbox:true 下会有多个 execution context，
//     只有 auxData.isDefault === true 的那个是主世界，window.pocketCultivationDesktop 只在那里存在。
//   * localSave.read/write 全部是 Electron IPC invoke 包装 ⇒ 返回 Promise
//     ⇒ Runtime.evaluate 必须带 awaitPromise: true，并带 returnByValue: true。
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 20000;

function describeWsError(ev) {
  if (!ev) return 'unknown';
  if (ev.message) return ev.message;
  if (ev.error && ev.error.message) return ev.error.message;
  return ev.type || 'unknown';
}

export class CdpClient {
  constructor(wsUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'cdp' } = {}) {
    if (!wsUrl || typeof wsUrl !== 'string') throw new Error('CdpClient: wsUrl is required');
    this.wsUrl = wsUrl;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
    this.closed = false;
    this.closeInfo = null;
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === 1 && !this.closed;
  }

  connect(timeoutMs = this.timeoutMs) {
    if (this.ws) return Promise.resolve(this);
    if (typeof WebSocket !== 'function') {
      return Promise.reject(new Error('global WebSocket is unavailable in this Node runtime (need Node >= 22)'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`CdpClient(${this.label}): WebSocket open timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve(this);
      });
      ws.addEventListener('error', (ev) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CdpClient(${this.label}): WebSocket error before open: ${describeWsError(ev)}`));
      });
      ws.addEventListener('message', (ev) => this.#onMessage(ev));
      ws.addEventListener('close', (ev) => this.#onClose(ev));
    });
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(
          `${entry.method} failed: ${msg.error.message || JSON.stringify(msg.error)} (code ${msg.error.code})`,
        );
        err.code = msg.error.code;
        err.data = msg.error.data;
        err.method = entry.method;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === 'string') this.#emit(msg.method, msg.params, msg);
  }

  #onClose(ev) {
    this.closeInfo = { code: ev && ev.code, reason: ev && ev.reason };
    const alreadyClosed = this.closed;
    this.closed = true;
    this.ws = null;
    if (this.pending.size > 0) {
      const err = new Error(
        `CdpClient(${this.label}): socket closed (code=${this.closeInfo.code}` +
          `${this.closeInfo.reason ? `, reason=${this.closeInfo.reason}` : ''})`,
      );
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this.pending.clear();
    }
    if (!alreadyClosed) this.#emit('__close', this.closeInfo, null);
  }

  #emit(event, params, raw) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(params, raw);
      } catch {
        /* 监听器异常不得影响客户端本身 */
      }
    }
  }

  /** 订阅事件，返回取消订阅函数。 */
  on(event, fn) {
    if (typeof fn !== 'function') throw new Error('on: fn must be a function');
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** 发送一条 CDP 命令；resolve 为该命令的 result 对象，error 时 reject。 */
  send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed || !this.ws) {
      return Promise.reject(new Error(`CdpClient(${this.label}): not connected`));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** 等待某个事件（可带 predicate）。 */
  waitForEvent(event, { predicate = null, timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.on(event, (params, raw) => {
        if (predicate && !predicate(params, raw)) return;
        if (timer) clearTimeout(timer);
        off();
        resolve({ params, raw });
      });
      timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for event ${event} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  close() {
    const ws = this.ws;
    this.closed = true;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 主世界 context 解析
// ---------------------------------------------------------------------------

/** 优先 isDefault && type==="default"，退化到任意 isDefault===true。 */
export function pickDefaultContext(contexts) {
  if (!Array.isArray(contexts)) return null;
  return (
    contexts.find((c) => c && c.auxData && c.auxData.isDefault === true && c.auxData.type === 'default') ||
    contexts.find((c) => c && c.auxData && c.auxData.isDefault === true) ||
    null
  );
}

/**
 * 连接 target 并取出主世界 executionContextId。
 * @returns {Promise<{client: CdpClient, contextId: number|undefined, context: object|null,
 *                    contexts: object[], target: object, unsubscribe: () => void}>}
 */
export async function connectAndGetContext(
  target,
  { timeoutMs = DEFAULT_TIMEOUT_MS, contextTimeoutMs = 8000, label = 'cdp', requireDefault = true } = {},
) {
  if (!target || typeof target !== 'object') throw new Error('connectAndGetContext: target is required');
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('connectAndGetContext: target.webSocketDebuggerUrl is missing');

  const client = new CdpClient(wsUrl, { timeoutMs, label });
  await client.connect(timeoutMs);

  const contexts = [];
  const unsubscribe = client.on('Runtime.executionContextCreated', (params) => {
    if (params && params.context) contexts.push(params.context);
  });

  try {
    await client.send('Runtime.enable', {}, { timeoutMs });
  } catch (err) {
    unsubscribe();
    client.close();
    throw new Error(`connectAndGetContext: Runtime.enable failed: ${err.message}`);
  }

  const deadline = Date.now() + contextTimeoutMs;
  let context = pickDefaultContext(contexts);
  while (!context && Date.now() < deadline) {
    await sleep(50);
    context = pickDefaultContext(contexts);
  }

  const contextId = context ? context.id : undefined;
  if (contextId === undefined && requireDefault) {
    unsubscribe();
    client.close();
    throw new Error(
      `connectAndGetContext: no execution context with auxData.isDefault === true within ${contextTimeoutMs}ms; ` +
        `saw ${contexts.length} context(s): ` +
        JSON.stringify(contexts.map((c) => ({ id: c.id, name: c.name, origin: c.origin, auxData: c.auxData }))),
    );
  }

  return { client, contextId, context: context || null, contexts, target, unsubscribe };
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

export async function evaluate(
  client,
  expression,
  { contextId, awaitPromise = true, returnByValue = true, timeoutMs } = {},
) {
  if (typeof expression !== 'string') throw new Error('evaluate: expression must be a string');
  const params = { expression, awaitPromise, returnByValue };
  if (contextId !== undefined && contextId !== null) params.contextId = contextId;

  const result = await client.send('Runtime.evaluate', params, timeoutMs === undefined ? {} : { timeoutMs });

  if (result && result.exceptionDetails) {
    const d = result.exceptionDetails;
    const desc =
      (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown exception';
    const err = new Error(`evaluate: in-page exception: ${desc}`);
    err.exceptionDetails = d;
    throw err;
  }
  return result; // { result: { type, value, ... } }
}

export async function evaluateValue(client, expression, opts = {}) {
  const res = await evaluate(client, expression, opts);
  return res && res.result ? res.result.value : undefined;
}

export const ASYNC_RESULT_SENTINEL = '__pocketTrainerError';

/** 把任意表达式包成 async IIFE，异常也变成可解析的 JSON 字符串。 */
export function wrapAsyncExpression(expression) {
  return (
    '(async () => { try { const __v = await (' +
    expression +
    '); return JSON.stringify(__v === undefined ? null : __v); } catch (__e) { return JSON.stringify({ ' +
    ASYNC_RESULT_SENTINEL +
    ': String((__e && __e.message) || __e) }); } })()'
  );
}

/** evaluate 一个表达式并把结果当 JSON 解析；页内异常会以 Error 抛出。 */
export async function evaluateJson(client, expression, opts = {}) {
  const wrapped = wrapAsyncExpression(expression);
  const res = await evaluate(client, wrapped, { ...opts, awaitPromise: true, returnByValue: true });
  const text = res && res.result ? res.result.value : undefined;
  if (typeof text !== 'string') {
    throw new Error(
      `evaluateJson: expected a JSON string from the page, got ${res && res.result ? res.result.type : 'no result'}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`evaluateJson: page returned non-JSON text (first 200 chars): ${text.slice(0, 200)}`);
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof parsed[ASYNC_RESULT_SENTINEL] === 'string'
  ) {
    throw new Error(`evaluateJson: in-page error: ${parsed[ASYNC_RESULT_SENTINEL]}`);
  }
  return parsed;
}
