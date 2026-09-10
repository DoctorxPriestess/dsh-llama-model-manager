/**
 * Manager API surface, shared by:
 *   - the standalone OpenAI gateway  (HTTP, loopback only)
 *   - the DSH plugin's own route     (same-origin for the settings page)
 *
 * Both call exactly the same code, so the settings page and `curl` can never
 * drift apart.
 */
import { RequestError } from './errors.js';

/**
 * @param {object} options
 * @param {import('./manager.js').LlamaModelManager} options.manager
 * @param {{address: string, host: string, port: number, listening: boolean}|null} [options.gateway]
 * @param {string} options.method
 * @param {string} options.pathname   e.g. "/manager/status"
 * @param {object} [options.body]     parsed JSON body (already read by the caller)
 * @param {Record<string, string|string[]|undefined>} [options.headers]
 * @returns {Promise<{status: number, payload: object}|null>} null when the path is not a manager endpoint
 */
export async function handleManagerApi({
  manager,
  gateway = null,
  method,
  pathname,
  body = null,
  headers = {},
  logger = null,
}) {
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && manager.config.settings.requireManagerToken) {
    const token = headers['x-llama-manager'];
    const value = Array.isArray(token) ? token[0] : token;
    if (String(value ?? '') !== '1') {
      throw new RequestError(
        '管理 API 的写操作需要请求头 x-llama-manager: 1（用于阻止跨站伪造请求）。',
        { status: 403, code: 'MISSING_MANAGER_HEADER' },
      );
    }
  }

  const statusPayload = () => managerStatusPayload(manager, gateway);

  if (pathname === '/manager/status' && method === 'GET') {
    return { status: 200, payload: statusPayload() };
  }
  if (pathname === '/manager/health' && method === 'GET') {
    return { status: 200, payload: { status: manager.state, ...statusPayload() } };
  }
  if (pathname === '/manager/logs' && method === 'GET') {
    const limit = clampInt(body?.limit, 200, 1, 2000);
    return { status: 200, payload: { logs: logger ? logger.recent(limit) : [] } };
  }
  if (pathname === '/manager/config' && method === 'GET') {
    return {
      status: 200,
      payload: { config: manager.config, configPath: manager.configPath, warnings: manager.warnings },
    };
  }
  if (pathname === '/manager/config' && (method === 'PUT' || method === 'POST')) {
    const next = body?.config ?? body;
    const applied = manager.applyConfig(next, { reason: 'api-config-update' });
    return { status: 200, payload: { ok: true, config: applied, warnings: manager.warnings } };
  }
  if (pathname === '/manager/config/validate' && method === 'POST') {
    // Validate without applying: lets the settings page show errors inline.
    const { normalizeConfig } = await import('./config.js');
    const { config, warnings } = normalizeConfig(body?.config ?? body);
    return { status: 200, payload: { ok: true, warnings, modelCount: Object.keys(config.models).length } };
  }
  if (pathname === '/manager/models' && method === 'GET') {
    return { status: 200, payload: { models: manager.listModels() } };
  }
  if (pathname === '/manager/models' && (method === 'POST' || method === 'PUT')) {
    const model = manager.upsertModel(body?.model ?? body);
    return { status: 200, payload: { ok: true, model, models: manager.listModels() } };
  }
  if (pathname.startsWith('/manager/models/')) {
    const id = decodeURIComponent(pathname.slice('/manager/models/'.length));
    if (method === 'DELETE') {
      const removed = manager.deleteModel(id);
      return { status: 200, payload: { ok: true, removed: removed.id, models: manager.listModels() } };
    }
    if (method === 'PUT' || method === 'POST') {
      const source = body?.model ?? body ?? {};
      const model = manager.upsertModel({ ...source, id: source.id ?? id });
      return { status: 200, payload: { ok: true, model, models: manager.listModels() } };
    }
  }
  if (pathname === '/manager/load' && method === 'POST') {
    const model = requireModelField(body);
    const result = await manager.load(model, { reason: 'api-load' });
    return {
      status: 200,
      payload: { ok: true, model: result.model.id, reused: !!result.reused, status: statusPayload() },
    };
  }
  if (pathname === '/manager/unload' && method === 'POST') {
    const result = await manager.unload({ reason: 'api-unload' });
    return { status: 200, payload: { ok: true, ...result, status: statusPayload() } };
  }
  if (pathname === '/manager/restart' && method === 'POST') {
    const model = typeof body?.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;
    const result = await manager.restart(model, { reason: 'api-restart' });
    return { status: 200, payload: { ok: true, model: result.model.id, status: statusPayload() } };
  }
  if (pathname === '/manager/preview' && method === 'POST') {
    const model = requireModelField(body);
    return { status: 200, payload: { ok: true, preview: manager.previewLaunch(model) } };
  }
  if (pathname === '/manager/last-error') {
    if (method === 'DELETE') {
      manager.clearLastError();
      return { status: 200, payload: { ok: true } };
    }
    return { status: 200, payload: { lastError: manager.lastError } };
  }
  if (pathname === '/manager/stale-process') {
    if (method === 'GET') {
      return { status: 200, payload: { staleProcess: manager.staleProcess } };
    }
    if (method === 'POST') {
      const cleaned = await manager.cleanupStaleProcess();
      return { status: 200, payload: { ok: true, cleaned } };
    }
  }
  if (pathname === '/manager/scan' && method === 'POST') {
    const result = await manager.scanModelDirectory(body?.dir, { recursive: body?.recursive !== false });
    return { status: 200, payload: { ok: true, ...result } };
  }
  if (pathname === '/manager/runtime' && method === 'GET') {
    return {
      status: 200,
      payload: {
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        cwd: process.cwd(),
        configPath: manager.configPath,
      },
    };
  }
  return null;
}

export function managerStatusPayload(manager, gateway) {
  const status = manager.status();
  return {
    ...status,
    gateway: gateway
      ? { host: gateway.host, port: gateway.port, listening: gateway.listening, url: gateway.address }
      : status.gateway,
  };
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

function clampInt(value, fallback, min, max) {
  const num = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}
