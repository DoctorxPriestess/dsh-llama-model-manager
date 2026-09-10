/**
 * DSH host plugin: dsh-llama-model-manager
 *
 * Responsibilities:
 *   - own the OpenAI-compatible gateway that DSH points at (default 127.0.0.1:8080);
 *   - own the llama-server model lifecycle (start / stop / switch / recover);
 *   - expose the manager API to the settings page over the DSH web server
 *     (same origin -> no CORS, no extra port to open).
 *
 * It never touches DSH's settings.yaml, llm-pi-ai provider config, or any other
 * plugin's state; everything lives in its own JSON config file.
 */
import { createRuntime } from './core/runtime.js';
import { handleManagerApi } from './core/api.js';
import { readBodyBuffer, writeJson, writeError } from './core/gateway.js';
import { resolveConfigPath } from './core/config.js';
import { RequestError } from './core/errors.js';

export const name = 'dsh-llama-model-manager';

/** Hard dependency: without the web server we cannot serve the settings page. */
export const inject = ['webServer'];

/** Route prefix owned by this plugin (kept distinct from every other plugin). */
const ROUTE_PREFIX = '/llama-model-manager/api';

/** printf-style escapes so a log line can never be mangled by %s/%d in cordis. */
const escapePercent = (line) => String(line).replace(/%/g, '%%');

export async function apply(ctx, pluginConfig = {}) {
  const log = ctx.logger ? ctx.logger() : console;
  const sink = ctx.logger
    ? (level, line) => {
        const message = escapePercent(line);
        if (level === 'error') log.error(message);
        else if (level === 'warn') log.warn(message);
        else if (level === 'debug') log.debug(message);
        else log.info(message);
      }
    : null;

  const configPath = pluginConfig?.configPath
    ? String(pluginConfig.configPath)
    : resolveConfigPath();

  let runtime;
  try {
    runtime = await createRuntime({
      configPath,
      seed: pluginConfig?.seed ?? null,
      logLevel: pluginConfig?.logLevel ?? 'info',
      sink,
    });
  } catch (error) {
    log.error(`llama-model-manager: 初始化失败，插件已停用：${error?.stack ?? error}`);
    return;
  }

  const { manager, gateway } = runtime;

  // ── settings-page API (same origin as the DSH UI) ─────────────────────────
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          void handleUiRequest(req, res).catch((error) => {
            log.error(`llama-model-manager: UI 路由异常：${error?.stack ?? error}`);
            try {
              if (!res.headersSent) writeError(res, 500, String(error?.message ?? error), { code: 'UI_ROUTE_ERROR' });
              else res.destroy();
            } catch {
              /* response already closed */
            }
          });
        },
      }),
    'llama-model-manager: ui routes',
  );

  async function handleUiRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const suffix = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const pathname = `/manager${suffix === '/' ? '/status' : suffix.replace(/\/+$/, '')}`;
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    try {
      const body = mutating ? await readJsonLoose(req) : null;
      const result = await handleManagerApi({
        manager,
        gateway,
        method: req.method,
        pathname,
        body,
        headers: req.headers,
        logger: runtime.logger,
      });
      if (!result) {
        return writeError(res, 404, `未知端点：${req.method} ${url.pathname}`, { code: 'UNKNOWN_ENDPOINT' });
      }
      // The UI wants the log tail and runtime info with every status read.
      if (pathname === '/manager/status') {
        result.payload = {
          ...result.payload,
          configPath: manager.configPath,
          recentLogs: runtime.logger.recent(120),
        };
      }
      return writeJson(res, result.status, result.payload);
    } catch (error) {
      const status = error?.status ?? 500;
      if (!(error instanceof RequestError) && status >= 500) {
        log.error(`llama-model-manager: ${req.method} ${url.pathname} 失败：${error?.stack ?? error}`);
      }
      return writeError(res, status, error?.message ?? 'internal error', {
        code: error?.code ?? 'ERROR',
        detail: error?.detail ?? null,
      });
    }
  }

  async function readJsonLoose(req) {
    const maxBytes = manager.config.settings.maxRequestBodyBytes;
    const buffer = await readBodyBuffer(req, maxBytes);
    if (buffer.length === 0) return {};
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      throw new RequestError(`请求体不是合法 JSON：${error.message}`, {
        status: 400,
        code: 'INVALID_JSON',
      });
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  const started = await runtime.start({ listen: true, preload: true });
  if (started.listenError) {
    log.error(
      `llama-model-manager: Gateway 未启动（${started.listenError.message}）；` +
        '设置页仍可使用，修正端口后重启 DSH 即可。',
    );
  }

  ctx.effect(
    () => async () => {
      await runtime.stop({ reason: 'plugin unload' });
    },
    'llama-model-manager: stop llama-server on unload',
  );

  // Ctrl+C / termination while DSH is running: stop the child before we go.
  const onSignal = () => {
    void runtime.stop({ reason: 'process signal' }).catch(() => {});
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, onSignal);
    ctx.effect(() => () => process.removeListener(signal, onSignal), `llama-model-manager: ${signal} handler`);
  }

  /**
   * Stop the child synchronously. Used from fatal paths where we cannot await.
   * Goes through the child handle rather than the pid, so a recycled pid can
   * never make us terminate an unrelated process (see process.js).
   */
  const killChildSync = () => {
    const proc = manager.current?.proc;
    if (!proc || proc.exited) return;
    proc.stopRequested = true;
    try {
      proc.child?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  // NOTE: we deliberately do NOT install `uncaughtException` /
  // `unhandledRejection` listeners. DSH does not install any of its own, so
  // adding one here would silently change host-wide behaviour: a fatal error
  // that would normally crash DSH would instead be swallowed and leave the
  // harness running in an unknown state. Orphan prevention does not need them
  // either -- the 'exit' handler below runs for crash exits as well, and the
  // leftover-process safety net covers the hard-kill cases.
  // Last resort: a synchronous kill on hard exit, so no orphan keeps GPU memory.
  const onExit = () => {
    killChildSync();
  };
  process.on('exit', onExit);
  ctx.effect(() => () => process.removeListener('exit', onExit), 'llama-model-manager: exit safety net');

  log.info(
    `llama-model-manager ready: gateway=${gateway.address} models=${Object.keys(manager.config.models).length} config=${manager.configPath}`,
  );
}
