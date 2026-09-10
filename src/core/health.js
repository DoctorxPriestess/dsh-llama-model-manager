/**
 * Health probing for a freshly spawned llama-server.
 *
 * Primary probe is `GET /health` (200 = ready, 503 = still loading).
 * If that endpoint is missing (404) we fall back to a lightweight endpoint that
 * never triggers inference (`/v1/models`), so an older/newer llama.cpp build
 * cannot break us. The user can override both paths in the settings.
 */
import net from 'node:net';

/** @returns {Promise<{ok: boolean, status: number, body?: string, error?: string, endpoint: string}>} */
export async function probeEndpoint({
  fetchImpl = globalThis.fetch,
  connectHost,
  port,
  pathname,
  timeoutMs = 2000,
}) {
  const url = `http://${connectHost}:${port}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    let body;
    try {
      body = await response.text();
    } catch {
      body = undefined;
    }
    return { ok: response.ok, status: response.status, body, endpoint: pathname };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.name === 'AbortError' ? `probe timeout after ${timeoutMs}ms` : error?.message ?? String(error),
      endpoint: pathname,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until the model server answers a health probe.
 *
 * @param {object} options
 * @param {() => ({exited: boolean, exitCode: number|null, tail: (n: number) => string[]})} options.processState
 * @param {string} options.connectHost
 * @param {number} options.port
 * @param {string} [options.healthPath]
 * @param {string} [options.fallbackPath]
 * @param {number} options.timeoutMs
 * @param {number} options.intervalMs
 * @param {number} [options.probeTimeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.logger]
 * @param {() => void} [options.onEarlyExit]
 * @returns {Promise<{endpoint: string, waitedMs: number}>}
 */
export async function waitForHealth({
  processState,
  connectHost,
  port,
  healthPath = '/health',
  fallbackPath = '/v1/models',
  timeoutMs = 180000,
  intervalMs = 500,
  probeTimeoutMs = 2000,
  signal,
  logger = null,
  onEarlyExit = null,
  fetchImpl = globalThis.fetch,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let useFallback = !healthPath;
  let lastObservation = 'no response yet';

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('health wait aborted');
    }
    const state = processState();
    if (state.exited) {
      if (onEarlyExit) onEarlyExit();
      const error = new Error('llama-server exited before becoming ready');
      error.code = 'EARLY_EXIT';
      error.exitCode = state.exitCode;
      error.stderrLines = state.tail(100);
      throw error;
    }

    const pathname = useFallback ? fallbackPath : healthPath;
    if (pathname) {
      const result = await probeEndpoint({ fetchImpl, connectHost, port, pathname, timeoutMs: probeTimeoutMs });
      if (result.ok) {
        return { endpoint: result.endpoint, waitedMs: Date.now() - startedAt };
      }
      if (!useFallback && (result.status === 404 || result.status === 405 || result.status === 501)) {
        logger?.warn(`${healthPath} 不存在（HTTP ${result.status}），改用 ${fallbackPath} 作为健康检查端点`);
        useFallback = true;
        continue;
      }
      lastObservation = result.status
        ? `HTTP ${result.status}${result.body ? ` ${truncate(result.body, 200)}` : ''}`
        : `连接失败：${result.error}`;
    }

    await delay(intervalMs, signal);
  }

  const error = new Error(
    `等待 llama-server 就绪超时（${timeoutMs}ms，最后状态：${lastObservation}）`,
  );
  error.code = 'HEALTH_TIMEOUT';
  error.stderrLines = processState().tail(100);
  throw error;
}

function truncate(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Check whether a TCP port can be bound. Used as a pre-flight check so a port
 * conflict is reported *before* spawning anything (and before touching VRAM).
 * @returns {Promise<{free: boolean, error?: string}>}
 */
export function checkPortAvailable(host, port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* not listening */
      }
      resolve(result);
    };
    server.once('error', (error) => finish({ free: false, error: error.code ?? error.message }));
    server.once('listening', () => finish({ free: true }));
    // NOT unref()'d: if listen() never reports back, this deadline is the only
    // thing that can settle the awaited promise. It is cleared in finish(), so
    // it cannot keep the process alive past the check.
    timer = setTimeout(() => finish({ free: false, error: 'port check timed out' }), timeoutMs);
    try {
      server.listen({ host: normalizeBindHost(host), port, exclusive: true });
    } catch (error) {
      finish({ free: false, error: error.message });
    }
  });
}

/** `0.0.0.0` cannot be probed directly with listen(); check the loopback side. */
function normalizeBindHost(host) {
  const value = String(host ?? '').trim();
  if (value === '' || value === '0.0.0.0' || value === '::' || value === '*') return '127.0.0.1';
  return value;
}

/**
 * Identify who is holding a port, using only read-only, non-invasive queries.
 * @returns {Promise<{pid: number|null, imageName: string|null}>}
 */
export async function describePortOwner(port, { execFileImpl } = {}) {
  if (!execFileImpl) return { pid: null, imageName: null };
  try {
    const { stdout } = await execFileImpl(
      'netstat',
      ['-ano', '-p', 'TCP'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const needle = `:${port}`;
    const line = String(stdout)
      .split(/\r?\n/)
      .find((entry) => entry.includes('LISTENING') && entry.trim().split(/\s+/)[2]?.endsWith(needle));
    if (!line) return { pid: null, imageName: null };
    const pid = Number.parseInt(line.trim().split(/\s+/).pop(), 10);
    if (!Number.isInteger(pid)) return { pid: null, imageName: null };
    const tasklist = await execFileImpl(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const match = /^"([^"]+)"/.exec(String(tasklist.stdout).trim());
    return { pid, imageName: match ? match[1] : null };
  } catch {
    return { pid: null, imageName: null };
  }
}
