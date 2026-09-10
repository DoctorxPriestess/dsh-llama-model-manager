/**
 * OpenAI-compatible HTTP Gateway.
 *
 * The gateway is the *only* address DSH talks to. It stays up across model
 * switches, keeps a stable port, synthesizes OpenAI-shaped `/v1/models`, and
 * forwards every other request byte-for-byte to whichever llama-server is
 * currently the active model.
 *
 * Transparency rules (spec §9/§10):
 *  - the request body is forwarded VERBATIM (we parse a private copy only to
 *    read the `model` field);
 *  - no reasoning/tool/temperature/max_tokens field is ever touched;
 *  - streaming responses are piped chunk-by-chunk, never buffered.
 */
import http from 'node:http';
import { Readable } from 'node:stream';

import { RequestError } from './errors.js';
import { handleManagerApi, managerStatusPayload } from './api.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Endpoints that carry the model id in a JSON body. */
const BODY_MODEL_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
  '/v1/embeddings',
  '/v1/rerank',
]);

export class Gateway {
  /**
   * @param {object} options
   * @param {import('./manager.js').LlamaModelManager} options.manager
   * @param {import('./logger.js').Logger} options.logger
   * @param {(level: string, line: string) => void} [options.onLog]
   */
  constructor({ manager, logger, host, port, onLog = null }) {
    this.manager = manager;
    this.log = logger;
    this.host = host;
    this.port = port;
    this.onLog = onLog;
    this.server = null;
    this.listening = false;
    this.lastListenError = null;
    this.requestsHandled = 0;
  }

  get address() {
    return `http://${this.host}:${this.port}`;
  }

  /** Start listening. Rejects with a descriptive error if the port is taken. */
  listen() {
    if (this.server) return Promise.resolve(this.address);
    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((error) => {
        this.log.error(`[manager] gateway handler failure: ${error?.stack ?? error}`);
        try {
          if (!res.headersSent) {
            writeError(res, 500, error?.message ?? 'internal gateway error', { code: 'GATEWAY_ERROR' });
          } else {
            res.destroy();
          }
        } catch {
          /* response already gone */
        }
      });
    });
    // Long generations / SSE must never be cut by Node's default request timeout.
    server.requestTimeout = 0;
    server.headersTimeout = 120000;
    server.keepAliveTimeout = 65000;
    this.server = server;

    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.listening = false;
        this.lastListenError = error;
        server.removeListener('listening', onListening);
        reject(
          new RequestError(
            `Gateway 无法监听 ${this.host}:${this.port}：${error.message}` +
              (error.code === 'EADDRINUSE'
                ? '（端口已被占用，请确认没有其它 llama-server 或程序占用该端口）'
                : ''),
            { status: 500, code: 'GATEWAY_LISTEN_FAILED', detail: { host: this.host, port: this.port } },
          ),
        );
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', (error) => {
          this.log.error(`[manager] gateway server error: ${error.message}`);
        });
        this.listening = true;
        this.lastListenError = null;
        this.log.info(`[manager] gateway listening on ${this.address} (OpenAI-compatible)`);
        resolve(this.address);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: this.host, port: this.port });
    });
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.listening = false;
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Force-close idle keep-alive sockets so shutdown cannot hang.
      setTimeout(() => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        resolve();
      }, 1500).unref?.();
    });
  }

  // ───────────────────────────── routing ─────────────────────────────

  async _handle(req, res) {
    const startedAt = Date.now();
    this.requestsHandled += 1;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = normalizePath(url.pathname);

    if (!this._hostAllowed(req)) {
      return writeError(res, 403, `拒绝非本机 Host 头的请求：${req.headers.host ?? '(missing)'}`, {
        code: 'FORBIDDEN_HOST',
      });
    }

    try {
      if (pathname === '/health') {
        return this._handleHealth(res);
      }
      if (pathname === '/v1/models' && req.method === 'GET') {
        return this._handleListModels(res);
      }
      if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
        return this._handleGetModel(res, decodeURIComponent(pathname.slice('/v1/models/'.length)));
      }
      if (pathname === '/manager' || pathname.startsWith('/manager/')) {
        return await this._handleManagerApi(req, res, pathname);
      }
      return await this._handleProxy(req, res, pathname, url);
    } catch (error) {
      const status = error?.status ?? 500;
      const payload = {
        code: error?.code ?? 'ERROR',
        ...(error?.detail && typeof error.detail === 'object' ? { detail: error.detail } : {}),
      };
      this.log.error(`[manager] ${req.method} ${pathname} failed (${status}): ${error?.message}`);
      return writeError(res, status, error?.message ?? 'internal error', payload);
    } finally {
      if (this.onLog) {
        try {
          this.onLog('debug', `${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
        } catch {
          /* ignore */
        }
      }
    }
  }

  _hostAllowed(req) {
    const hostHeader = String(req.headers.host ?? '');
    if (hostHeader === '') return true; // HTTP/1.0 clients and health probes
    const hostname = stripPort(hostHeader).toLowerCase();
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
      return true;
    }
    const configured = String(this.host ?? '').toLowerCase();
    if (configured && hostname === configured) return true;
    return false;
  }

  _handleHealth(res) {
    const status = this.manager.status();
    const gatewayOk = this.listening;
    const body = {
      status: gatewayOk ? (status.state === 'ready' ? 'ok' : status.state) : 'error',
      gateway: gatewayOk ? 'up' : 'down',
      state: status.state,
      currentModel: status.currentModel,
      pid: status.pid,
      queueLength: status.queueLength,
      uptimeSeconds: status.uptimeSeconds,
      lastError: status.lastError,
    };
    // Gateway health is always 200 while the gateway itself is serving: a
    // missing model is reported in the body, not as a transport failure.
    return writeJson(res, 200, body);
  }

  _handleListModels(res) {
    const created = Math.floor(this.manager.startedAt / 1000);
    const data = this.manager.listModels().map((model) => ({
      id: model.id,
      object: 'model',
      created,
      owned_by: 'local',
    }));
    return writeJson(res, 200, { object: 'list', data });
  }

  _handleGetModel(res, id) {
    const model = this.manager.listModels().find((entry) => entry.id === id);
    if (!model) {
      throw new RequestError(`未注册的模型：${id}`, { status: 404, code: 'UNKNOWN_MODEL' });
    }
    return writeJson(res, 200, {
      id: model.id,
      object: 'model',
      created: Math.floor(this.manager.startedAt / 1000),
      owned_by: 'local',
    });
  }

  _managerStatusPayload() {
    return { ...managerStatusPayload(this.manager, this), configPath: this.manager.configPath };
  }

  async _handleManagerApi(req, res, pathname, url) {
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    const body = mutating ? await readJsonBody(req, this.manager.config.settings.maxRequestBodyBytes) : null;
    const result = await handleManagerApi({
      manager: this.manager,
      gateway: this,
      method: req.method,
      pathname,
      body,
      headers: req.headers,
      logger: this.log,
    });
    if (!result) {
      throw new RequestError(`未知的管理端点：${req.method} ${pathname}`, {
        status: 404,
        code: 'UNKNOWN_MANAGER_ENDPOINT',
      });
    }
    return writeJson(res, result.status, result.payload);
  }

  // ───────────────────────────── proxying ─────────────────────────────

  async _handleProxy(req, res, pathname, url) {
    const settings = this.manager.config.settings;
    let rawBody = null;
    let requestedModel = null;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rawBody = await readBodyBuffer(req, settings.maxRequestBodyBytes);
      if (BODY_MODEL_PATHS.has(pathname) && rawBody.length > 0) {
        requestedModel = extractModelField(rawBody);
      }
    }

    if (!requestedModel) {
      // Read-only endpoints (and bodies without a model) follow the current model.
      const status = this.manager.status();
      if (!status.currentModel) {
        throw new RequestError(
          `当前没有已加载的模型，且请求未指定 model 字段（${req.method} ${pathname}）。` +
            '请在请求体中携带 model（如 "model": "<模型ID>"），或先调用 POST /manager/load。',
          { status: 503, code: 'NO_MODEL_LOADED' },
        );
      }
      requestedModel = status.currentModel;
    }

    const acquired = await this.manager.acquireForRequest(requestedModel, {
      reason: `proxy ${req.method} ${pathname}`,
    });
    const release = acquired.release;
    const controller = new AbortController();
    const untrack = this.manager.trackInflight(controller);
    let timer = null;

    const abortUpstream = () => {
      if (!controller.signal.aborted) controller.abort(new Error('client disconnected'));
    };
    res.on('close', () => {
      if (!res.writableEnded) abortUpstream();
    });

    try {
      const upstream = this.manager.current;
      if (!upstream) {
        throw new RequestError('模型在上游请求发出前被卸载。', { status: 503, code: 'MODEL_UNLOADED' });
      }
      const target = `http://${upstream.connectHost}:${upstream.port}${pathname}${url.search}`;
      const headers = buildUpstreamHeaders(req.headers);
      if (settings.proxyTimeoutMs > 0) {
        timer = setTimeout(() => controller.abort(new Error('proxy timeout')), settings.proxyTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }

      this.log.info(`[manager] proxy request ${req.method} ${pathname} -> ${upstream.connectHost}:${upstream.port}`);
      this.manager.stats.requests += 1;
      this.manager.stats.lastRequestAt = Date.now();

      const response = await this.manager.fetchImpl(target, {
        method: req.method,
        headers,
        body: rawBody && rawBody.length > 0 ? rawBody : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });

      res.statusCode = response.status;
      for (const [key, value] of response.headers) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        try {
          res.setHeader(key, value);
        } catch {
          /* ignore invalid header values from upstream */
        }
      }
      if (controller.signal.aborted) {
        res.destroy();
        return;
      }
      if (!response.body) {
        res.end();
        return;
      }
      const stream = Readable.fromWeb(response.body);
      stream.on('error', (error) => {
        this.log.warn(`[manager] upstream stream error: ${error.message}`);
        if (!res.writableEnded) res.destroy();
      });
      await new Promise((resolve) => {
        res.on('close', resolve);
        res.on('finish', resolve);
        stream.pipe(res);
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (!res.writableEnded && !res.headersSent) {
          writeError(res, 499, '客户端已断开，上游请求已取消。', { code: 'CLIENT_DISCONNECTED' });
        }
        return;
      }
      if (!res.headersSent) {
        throw new RequestError(`转发到 llama-server 失败：${error.message}`, {
          status: 502,
          code: 'UPSTREAM_ERROR',
          detail: { model: acquired.model?.id ?? null, upstream: this.manager.current?.port ?? null },
        });
      }
      if (!res.writableEnded) res.destroy();
    } finally {
      if (timer) clearTimeout(timer);
      untrack();
      release();
    }
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '');
  return pathname;
}

function stripPort(hostHeader) {
  const value = String(hostHeader);
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  const index = value.lastIndexOf(':');
  return index === -1 ? value : value.slice(0, index);
}

function buildUpstreamHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length') continue;
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

/** Read the full request body with a hard size cap. */
function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(
          reject,
          new RequestError(`请求体过大（上限 ${maxBytes} 字节）。`, {
            status: 413,
            code: 'REQUEST_TOO_LARGE',
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (error) => finish(reject, error));
    req.on('aborted', () => {
      finish(
        reject,
        new RequestError('客户端在请求体发送完成前断开。', { status: 400, code: 'REQUEST_ABORTED' }),
      );
    });
  });
}

async function readJsonBody(req, maxBytes) {
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

/** Parse a private copy of the body only to read `model`; the body itself is forwarded verbatim. */
function extractModelField(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    const model = parsed?.model;
    if (typeof model === 'string' && model.trim() !== '') return model.trim();
    return null;
  } catch {
    return null;
  }
}

function requireModelField(body) {
  const model = body?.model ?? body?.id;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new RequestError('请求体必须包含 "model"（模型 ID）。', {
      status: 400,
      code: 'MISSING_MODEL_FIELD',
    });
  }
  return model.trim();
}

/** Only used by tests. */
export { requireModelField };

function writeJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** OpenAI-style error envelope, plus the diagnostic detail the spec asks for. */
function writeError(res, status, message, { code = 'ERROR', type = null, detail = null } = {}) {
  if (res.writableEnded || res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  const payload = {
    error: {
      message,
      type: type ?? (status >= 500 ? 'server_error' : 'invalid_request_error'),
      param: null,
      code,
    },
  };
  if (detail && typeof detail === 'object') payload.error.detail = detail;
  writeJson(res, status, payload);
}

export { writeJson, writeError, readBodyBuffer };
