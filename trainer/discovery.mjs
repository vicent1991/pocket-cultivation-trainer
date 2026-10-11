// discovery.mjs — 启动游戏进程 + 发现 CDP endpoint / 主窗口 target
//
// 硬事实（实测，勿改）：
//   * 必须同时注入三个环境变量：
//       POCKET_DESKTOP_E2E=1
//       POCKET_DESKTOP_REMOTE_DEBUGGING_PORT=<正整数>
//       POCKET_DESKTOP_E2E_WINDOW_MODE=inactive
//     缺 E2E=1 时游戏根本不会调用 commandLine.appendSwitch，端口变量完全不生效。
//     缺 E2E_WINDOW_MODE=inactive 时窗口被置为 hidden，永不显示。
//   * 主窗口 target 判据只有 `type === "page" && title === "口袋修仙"`。
//     另一个 target 的 title 是 "mod-script-host.html"，必须排除。
//     主窗口 url 是本地随机端口 —— 绝不可用数组下标或固定 url 匹配。
//
// 零第三方依赖：只用 node: 内建模块。
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  DEBUG_PORT_ENV,
  E2E_ENV,
  E2E_WINDOW_MODE_ENV,
  E2E_WINDOW_MODE_INACTIVE,
  GAME_TITLE,
  MOD_SCRIPT_HOST_TITLE,
} from './config.mjs';

export function assertPort(port, label = 'port') {
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(`${label} must be a positive safe integer, got ${JSON.stringify(port)}`);
  }
  return port;
}

// ---------------------------------------------------------------------------
// 启动游戏
// ---------------------------------------------------------------------------

/**
 * 纯函数：构造启动游戏用的环境变量表。抽出来是为了能离线单测（不真启动游戏）。
 *
 * 规则（已实测硬事实）：
 *   * 总是注入 POCKET_DESKTOP_REMOTE_DEBUGGING_PORT=<port>。
 *   * e2e === true 时注入 POCKET_DESKTOP_E2E=1 与
 *     POCKET_DESKTOP_E2E_WINDOW_MODE=inactive（缺后者窗口 hidden 永不显示）。
 *   * e2e === false 时两个 E2E 变量都不注入（保持窗口 normal），
 *     且会把 baseEnv 里可能残留的同名键删掉，避免父进程环境污染。
 *   * extraEnv 优先级最高（可覆盖上面任何值，也可用于显式删除）。
 *
 * @returns {Record<string,string>}
 */
export function buildLaunchEnv({ port, e2e = true, extraEnv = {}, baseEnv = process.env } = {}) {
  assertPort(port, 'port');
  const env = { ...baseEnv, [DEBUG_PORT_ENV]: String(port) };
  if (e2e) {
    env[E2E_ENV] = '1';
    env[E2E_WINDOW_MODE_ENV] = E2E_WINDOW_MODE_INACTIVE;
  } else {
    delete env[E2E_ENV];
    delete env[E2E_WINDOW_MODE_ENV];
  }
  return { ...env, ...extraEnv };
}

/**
 * 启动游戏并注入调试端口。
 * @returns {{child: import('node:child_process').ChildProcess, pid: number|undefined, port: number,
 *            exePath: string, env: Record<string,string>, spawnError: Error|null}}
 */
export function launchGame({
  exePath,
  port,
  cwd,
  detached = false,
  stdio = 'ignore',
  extraEnv = {},
  e2e = true,
} = {}) {
  assertPort(port, 'port');
  if (!exePath || typeof exePath !== 'string') {
    throw new Error(
      'launchGame: exePath is required —— 请用 --game-exe 或环境变量 POCKET_TRAINER_GAME_EXE ' +
        '指定游戏主程序路径（Pocket Cultivation.exe）',
    );
  }

  const env = buildLaunchEnv({ port, e2e, extraEnv });

  const child = spawn(exePath, [], {
    cwd: cwd || path.dirname(exePath),
    env,
    detached,
    stdio,
    windowsHide: false,
  });

  const handle = { child, pid: child.pid, port, exePath, env, spawnError: null };
  // spawn 失败（exe 不存在等）通过 'error' 事件抛出；必须挂监听器否则进程崩溃。
  child.on('error', (err) => {
    handle.spawnError = err;
  });
  return handle;
}

// ---------------------------------------------------------------------------
// 端点发现
// ---------------------------------------------------------------------------

/** GET http://<host>:<port>/json/list —— 返回 target 数组，失败 reject。 */
export function fetchTargets(port, { host = '127.0.0.1', timeoutMs = 3000 } = {}) {
  assertPort(port);
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/json/list', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = chunks.join('');
        if (res.statusCode !== 200) {
          reject(new Error(`GET http://${host}:${port}/json/list -> HTTP ${res.statusCode}`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          reject(new Error(`GET /json/list returned a non-JSON body: ${err.message}`));
          return;
        }
        if (!Array.isArray(parsed)) {
          reject(new Error('GET /json/list did not return an array'));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`GET /json/list timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(err));
  });
}

/** 轮询直到 /json/list 可用且非空（实测游戏约 7 秒才起来）。 */
export async function waitForEndpoint(port, timeoutMs = 90000, { host = '127.0.0.1', pollMs = 250, onPoll } = {}) {
  assertPort(port);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      const targets = await fetchTargets(port, { host, timeoutMs: 3000 });
      if (targets.length > 0) return targets;
      lastError = new Error('endpoint reachable but /json/list is empty');
    } catch (err) {
      lastError = err;
    }
    if (typeof onPoll === 'function') onPoll({ attempts, lastError });
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(
    `waitForEndpoint: CDP endpoint ${host}:${port} not ready within ${timeoutMs}ms ` +
      `after ${attempts} attempt(s); last error: ${lastError ? lastError.message : 'none'}`,
  );
}

// ---------------------------------------------------------------------------
// target 识别
// ---------------------------------------------------------------------------

export function describeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return '  (no targets)';
  return targets
    .map(
      (t, i) =>
        `  [${i}] type=${JSON.stringify(t && t.type)} title=${JSON.stringify(t && t.title)} url=${JSON.stringify(t && t.url)}`,
    )
    .join('\n');
}

/** 主窗口判据：type === "page" && title === "口袋修仙"。找不到返回 null。 */
export function findMainTarget(targets) {
  if (!Array.isArray(targets)) return null;
  return targets.find((t) => t && t.type === 'page' && t.title === GAME_TITLE) || null;
}

/** 同 findMainTarget，但找不到时抛错（附带完整 target 清单，便于排查）。 */
export function requireMainTarget(targets) {
  const target = findMainTarget(targets);
  if (target) return target;
  throw new Error(
    `findMainTarget: no target matched type === "page" && title === ${JSON.stringify(GAME_TITLE)}. ` +
      `Refusing to guess by array index or url (the main window url is a random local port). ` +
      `Targets seen:\n${describeTargets(targets)}`,
  );
}

/** 轮询直到主窗口 target 出现（endpoint 可能先于窗口就绪）。 */
export async function waitForMainTarget(port, timeoutMs = 90000, opts = {}) {
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let targets = [];

  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    targets = await waitForEndpoint(port, remaining, { ...opts, pollMs });
    const target = findMainTarget(targets);
    if (target) return { target, targets };
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  throw new Error(
    `waitForMainTarget: no target with title === ${JSON.stringify(GAME_TITLE)} within ${timeoutMs}ms. ` +
      `Targets seen:\n${describeTargets(targets)}`,
  );
}

/** 从 target 列表里挑出所有非主窗口的 page target（例如 mod-script-host.html）。 */
export function listSecondaryTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets.filter((t) => t && t.type === 'page' && t.title !== GAME_TITLE);
}

export { MOD_SCRIPT_HOST_TITLE };

// ---------------------------------------------------------------------------
// 进程 / 端口清理
// ---------------------------------------------------------------------------

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** 结束游戏进程（Windows 上用 taskkill /T 连同子进程树一起收掉）。 */
export function killGame(pid, { force = true } = {}) {
  if (!pid) return { ok: false, reason: 'no pid' };
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const res = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    return { ok: res.status === 0, status: res.status, method: 'taskkill' };
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return { ok: true, method: 'kill' };
  } catch (err) {
    return { ok: false, reason: err.message, method: 'kill' };
  }
}

export function isPortOpen(port, { host = '127.0.0.1', timeoutMs = 1000 } = {}) {
  assertPort(port);
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/json/version', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** 确认调试端口已释放（关闭游戏后调用）。 */
export async function waitForPortClosed(port, timeoutMs = 15000, { host = '127.0.0.1', pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isPortOpen(port, { host }))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}
