/**
 * Plugin-owned configuration: schema, defaults, validation, atomic persistence.
 *
 * Hard rule from the task spec: this plugin never touches DSH's own
 * settings.yaml, llm-pi-ai provider config, or any other plugin's state.
 * Everything lives in one JSON file owned by this plugin.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  llamaServerPath: '',
  gatewayHost: '127.0.0.1',
  gatewayPort: 8080,
  internalPort: 18080,
  startupTimeoutMs: 180000,
  shutdownTimeoutMs: 30000,
  /**
   * How the plugin asks llama-server to stop.
   *   'auto'     - try a real CTRL+C first (lets llama.cpp free the model),
   *                fall back to `taskkill /T /F`. Default.
   *   'ctrl-c'   - only CTRL+C; if it cannot be delivered the stop fails and
   *                the caller escalates.
   *   'taskkill' - skip CTRL+C entirely and terminate forcefully.
   * CTRL+C is delivered through a hidden console, so no window is ever shown.
   */
  stopMethod: 'auto',
  healthCheckIntervalMs: 500,
  /** How long a switch/stop waits for in-flight inference before forcing. 0 = wait forever. */
  forceShutdownAfterTimeoutMs: 300000,
  maxQueuedRequests: 10,
  maxConcurrentRequests: 1,
  /** Extra spawn attempts after the first failure. 0 = never retry. */
  maxRetries: 1,
  /** Model id auto-loaded when the plugin starts, or null for none. */
  startupModel: null,
  /** After an unexpected crash, try to reload the crashed model exactly once. */
  autoRecoverAfterCrash: false,
  /**
   * On plugin start, kill a llama-server left behind by a previous run of this
   * plugin. Only ever applied to a process this plugin spawned itself and can
   * still positively identify (pid + image name + served model path).
   */
  cleanupStaleProcessOnStart: false,
  /** Health probe path, with a non-inference fallback. */
  healthPath: '/health',
  healthFallbackPath: '/v1/models',
  healthProbeTimeoutMs: 2000,
  /** Upstream timeout for proxied requests, 0 = unlimited. */
  proxyTimeoutMs: 0,
  /** Max buffered request body forwarded upstream (bytes). */
  maxRequestBodyBytes: 134217728,
  /**
   * Require the `x-llama-manager: 1` header on mutating /manager/* calls.
   * A plain cross-site HTML form cannot set custom headers, so this blocks
   * drive-by requests to the manager API from any web page.
   */
  requireManagerToken: true,
});

/** A validation problem the user can fix from the settings page. */
export class ConfigError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ConfigError';
    this.detail = detail;
  }
}

/**
 * @returns {string} absolute path of the plugin config file.
 */
export function resolveConfigPath(env = process.env) {
  const explicit = env.DSH_LLAMA_MANAGER_CONFIG;
  if (explicit && String(explicit).trim() !== '') return path.resolve(String(explicit).trim());
  return path.join(resolveDataDir(env), 'config.json');
}

export function resolveDataDir(env = process.env) {
  const explicit = env.DSH_LLAMA_MANAGER_DATA_DIR;
  if (explicit && String(explicit).trim() !== '') return path.resolve(String(explicit).trim());
  const dshHome = env.DSH_HOME && String(env.DSH_HOME).trim() !== ''
    ? String(env.DSH_HOME).trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'llama-model-manager');
}

/** Empty model list; the user (or the settings page) adds entries. */
export function emptyConfig() {
  return { version: CONFIG_VERSION, settings: { ...DEFAULT_SETTINGS }, models: {} };
}

const NUMBER_RULES = {
  gatewayPort: { min: 1, max: 65535, integer: true },
  internalPort: { min: 1, max: 65535, integer: true },
  startupTimeoutMs: { min: 1000, max: 3600000, integer: true },
  shutdownTimeoutMs: { min: 0, max: 3600000, integer: true },
  healthCheckIntervalMs: { min: 50, max: 60000, integer: true },
  forceShutdownAfterTimeoutMs: { min: 0, max: 86400000, integer: true },
  maxQueuedRequests: { min: 0, max: 10000, integer: true },
  maxConcurrentRequests: { min: 1, max: 64, integer: true },
  maxRetries: { min: 0, max: 10, integer: true },
  healthProbeTimeoutMs: { min: 100, max: 60000, integer: true },
  proxyTimeoutMs: { min: 0, max: 86400000, integer: true },
  maxRequestBodyBytes: { min: 1024, max: 1073741824, integer: true },
};

const STRING_RULES = {
  gatewayHost: { allowEmpty: false },
  llamaServerPath: { allowEmpty: true },
  healthPath: { allowEmpty: false },
  healthFallbackPath: { allowEmpty: true },
};

/** Settings restricted to a fixed set of values. */
const ENUM_RULES = {
  stopMethod: ['auto', 'ctrl-c', 'taskkill'],
};

const MODEL_ID_RE = /^[A-Za-z0-9._@:+-]{1,128}$/;

/**
 * Normalize + validate a raw config object.
 * @param {unknown} raw
 * @returns {{config: object, warnings: string[]}}
 * @throws {ConfigError}
 */
export function normalizeConfig(raw) {
  const warnings = [];
  if (raw === null || raw === undefined) return { config: emptyConfig(), warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('配置必须是 JSON 对象');
  }

  const source = /** @type {Record<string, any>} */ (raw);
  const settings = { ...DEFAULT_SETTINGS };
  const rawSettings = source.settings && typeof source.settings === 'object' ? source.settings : {};

  for (const [key, rule] of Object.entries(NUMBER_RULES)) {
    if (!(key in rawSettings)) continue;
    const value = rawSettings[key];
    if (value === null || value === '' || value === undefined) continue;
    const num = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(num)) {
      throw new ConfigError(`设置项 ${key} 不是有效数字：${JSON.stringify(value)}`, { key });
    }
    if (rule.integer && !Number.isInteger(num)) {
      throw new ConfigError(`设置项 ${key} 必须是整数：${value}`, { key });
    }
    if (num < rule.min || num > rule.max) {
      throw new ConfigError(`设置项 ${key} 超出允许范围 ${rule.min}-${rule.max}：${value}`, { key });
    }
    settings[key] = num;
  }

  for (const [key, rule] of Object.entries(STRING_RULES)) {
    if (!(key in rawSettings)) continue;
    const value = rawSettings[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!rule.allowEmpty && text === '') {
      throw new ConfigError(`设置项 ${key} 不能为空`, { key });
    }
    settings[key] = text;
  }

  for (const [key, allowed] of Object.entries(ENUM_RULES)) {
    if (!(key in rawSettings)) continue;
    const value = rawSettings[key];
    if (value === null || value === undefined || value === '') continue;
    const text = String(value).trim();
    if (!allowed.includes(text)) {
      throw new ConfigError(`设置项 ${key} 只能是 ${allowed.join(' / ')}，收到：${JSON.stringify(value)}`, { key });
    }
    settings[key] = text;
  }

  if ('startupModel' in rawSettings) {
    const value = rawSettings.startupModel;
    if (value === null || value === undefined || String(value).trim() === '' || String(value).trim() === 'none') {
      settings.startupModel = null;
    } else {
      settings.startupModel = String(value).trim();
    }
  }

  if ('autoRecoverAfterCrash' in rawSettings) {
    settings.autoRecoverAfterCrash = toBoolean(rawSettings.autoRecoverAfterCrash);
  }
  if ('cleanupStaleProcessOnStart' in rawSettings) {
    settings.cleanupStaleProcessOnStart = toBoolean(rawSettings.cleanupStaleProcessOnStart);
  }
  if ('requireManagerToken' in rawSettings) {
    settings.requireManagerToken = toBoolean(rawSettings.requireManagerToken);
  }

  if (settings.gatewayPort === settings.internalPort) {
    throw new ConfigError(
      `Gateway 监听端口与 llama-server 内部端口不能相同（都是 ${settings.gatewayPort}）。`,
      { gatewayPort: settings.gatewayPort, internalPort: settings.internalPort },
    );
  }

  const models = {};
  const rawModels = source.models && typeof source.models === 'object' ? source.models : {};
  if (Array.isArray(rawModels)) {
    throw new ConfigError('models 必须是对象（model ID -> 模型配置）');
  }
  for (const [id, entry] of Object.entries(rawModels)) {
    const model = normalizeModel(id, entry);
    if (models[model.id]) {
      throw new ConfigError(`模型 ID 重复（大小写不敏感）：${model.id}`, { id: model.id });
    }
    models[model.id] = model;
  }

  if (settings.startupModel && !findModel(models, settings.startupModel)) {
    warnings.push(
      `startupModel 指向的模型 ID "${settings.startupModel}" 不在模型列表中，启动预加载将被跳过。`,
    );
  }

  const config = { version: CONFIG_VERSION, settings, models };
  if (source.version !== undefined && Number(source.version) > CONFIG_VERSION) {
    warnings.push(
      `配置文件版本 ${source.version} 高于本插件支持的版本 ${CONFIG_VERSION}，未知字段已保留但可能不被识别。`,
    );
    config.version = Number(source.version);
  }
  // Preserve unknown top-level keys so we never destroy a future field.
  for (const key of Object.keys(source)) {
    if (key === 'version' || key === 'settings' || key === 'models') continue;
    config[key] = source[key];
  }
  return { config, warnings };
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off' || text === '') return false;
  return Boolean(value);
}

/**
 * Normalize a single model entry. `arguments` is kept byte-for-byte (only
 * trimmed at the very ends) because it is the user's opaque argv tail.
 */
export function normalizeModel(id, entry) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ConfigError('模型 ID 不能为空');
  }
  const modelId = id.trim();
  if (!MODEL_ID_RE.test(modelId)) {
    throw new ConfigError(
      `模型 ID 含非法字符：${modelId}（只允许字母、数字与 . _ @ : + - ，长度 1-128）`,
      { id: modelId },
    );
  }
  if (entry === null || entry === undefined) {
    throw new ConfigError(`模型 ${modelId} 的配置为空`);
  }
  if (typeof entry === 'string') {
    return { id: modelId, displayName: modelId, modelPath: entry, arguments: '', enabled: true };
  }
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ConfigError(`模型 ${modelId} 的配置必须是对象`);
  }
  const rawPath = entry.modelPath ?? entry.path ?? '';
  const modelPath = String(rawPath).trim();
  if (modelPath === '') {
    throw new ConfigError(`模型 ${modelId} 缺少 GGUF 路径（modelPath）`, { id: modelId });
  }
  const displayName = entry.displayName === undefined || entry.displayName === null
    ? modelId
    : String(entry.displayName).trim() || modelId;

  let argumentsText = entry.arguments;
  if (argumentsText === null || argumentsText === undefined) argumentsText = '';
  if (typeof argumentsText !== 'string') {
    throw new ConfigError(`模型 ${modelId} 的 arguments 必须是字符串`, { id: modelId });
  }

  const model = {
    id: modelId,
    displayName,
    modelPath,
    arguments: argumentsText.replace(/^\s+|\s+$/g, ''),
  };
  if (entry.enabled !== undefined) model.enabled = toBoolean(entry.enabled);
  else model.enabled = true;
  // Keep unknown per-model fields (forward compatible) but never let them shadow ours.
  for (const [key, value] of Object.entries(entry)) {
    if (key in model) continue;
    if (key === 'path') continue;
    model[key] = value;
  }
  return model;
}

/** Case-insensitive model lookup, also matching the GGUF path (with or without directory). */
export function findModel(models, idOrPath) {
  if (!models || idOrPath === null || idOrPath === undefined) return null;
  const needle = String(idOrPath).trim();
  if (needle === '') return null;

  if (models[needle]) return models[needle];
  const lower = needle.toLowerCase();
  for (const model of Object.values(models)) {
    if (model.id.toLowerCase() === lower) return model;
  }
  const normalized = needle.replace(/[\\/]+/g, '\\').toLowerCase();
  const base = normalized.split('\\').pop();
  for (const model of Object.values(models)) {
    const modelPath = String(model.modelPath).replace(/[\\/]+/g, '\\').toLowerCase();
    if (modelPath === normalized) return model;
    if (base && modelPath.split('\\').pop() === base) return model;
  }
  return null;
}

/** Read config from disk, creating the file with defaults when missing. */
export function loadConfig(filePath = resolveConfigPath()) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const config = emptyConfig();
      return { config, warnings: [`配置文件不存在，已使用默认配置：${filePath}`], filePath, existed: false };
    }
    throw new ConfigError(`读取配置文件失败：${filePath}（${error.message}）`, { filePath });
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON：${filePath}（${error.message}）`, { filePath });
  }
  const { config, warnings } = normalizeConfig(parsed);
  return { config, warnings, filePath, existed: true };
}

/** Atomic save: write to a temp file, fsync, then rename over the target. */
export function saveConfig(config, filePath = resolveConfigPath()) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {
      /* backup is best effort */
    }
  }
  fs.renameSync(tmp, filePath);
  return filePath;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Deep clone that survives JSON-safe configs. */
export function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}
