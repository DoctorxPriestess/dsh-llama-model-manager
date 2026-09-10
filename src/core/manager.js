/**
 * LlamaModelManager: the model lifecycle state machine.
 *
 * Guarantees (from the task spec):
 *  - at most ONE plugin-managed llama-server runs at any time;
 *  - every transition is serialized (single exclusive ticket);
 *  - a model switch never starts while the previous one is still running;
 *  - asking for the model that is already ready never restarts anything;
 *  - a failed switch rolls back to the previously working model when possible;
 *  - a crash never triggers an unbounded restart loop;
 *  - the plugin only ever manages processes it spawned itself.
 */
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { buildLaunchArgs, collectPathArguments, formatArgvForLog, LaunchConfigError } from './args.js';
import {
  cloneConfig,
  findModel,
  loadConfig,
  normalizeConfig,
  normalizeModel,
  resolveConfigPath,
  saveConfig,
} from './config.js';
import { Logger } from './logger.js';
import { GateAbortedError, ModelGate, QueueFullError } from './gate.js';
import { LlamaServerProcess, isExistingFile } from './process.js';
import { checkPortAvailable, describePortOwner, waitForHealth } from './health.js';
import {
  ModelUnavailableError,
  QueueFullRequestError,
  RequestError,
  StartupFailure,
  UnknownModelError,
} from './errors.js';

const execFile = promisify(execFileCallback);

export const STATE = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  SWITCHING: 'switching',
  ERROR: 'error',
});

/** Upper bound on the acquire/verify retry loop, guards against pathological contention. */
const MAX_ACQUIRE_ATTEMPTS = 25;

export class LlamaModelManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.config          normalized config object
   * @param {string} [options.configPath]
   * @param {Logger} [options.logger]
   * @param {Function} [options.spawnImpl]
   * @param {Function} [options.fetchImpl]
   * @param {Function} [options.execFileImpl]
   */
  constructor({
    config,
    configPath = null,
    logger = null,
    spawnImpl = null,
    fetchImpl = null,
    execFileImpl = null,
  } = {}) {
    super();
    this.configPath = configPath ?? resolveConfigPath();
    this.log = logger ?? new Logger();
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.execFileImpl = execFileImpl ?? execFile;

    this.config = config;
    this.state = STATE.STOPPED;
    this.current = null;
    this.lastError = null;
    this.warnings = [];
    this.staleProcess = null;
    this.startedAt = Date.now();
    this.shuttingDown = false;

    this.stats = {
      loads: 0,
      switches: 0,
      failures: 0,
      crashes: 0,
      requests: 0,
      lastRequestAt: null,
      lastSwitchAt: null,
    };

    this.gate = new ModelGate({
      maxConcurrentRequests: config.settings.maxConcurrentRequests,
      maxQueuedRequests: config.settings.maxQueuedRequests,
      onQueueChange: (length) => this.emit('queue', length),
    });

    /** @type {Set<AbortController>} */
    this._inflightControllers = new Set();
    this._crashLockModelId = null;
    this._autoRecovered = new Set();
    this._runtimePath = path.join(path.dirname(this.configPath), 'runtime.json');
  }

  // ───────────────────────────── status ─────────────────────────────

  status() {
    const current = this.current;
    return {
      state: this.state,
      currentModel: current ? current.model.id : null,
      currentModelDisplayName: current ? current.model.displayName : null,
      currentModelPath: current ? current.model.modelPath : null,
      pid: current?.proc?.pid ?? null,
      internalPort: current?.port ?? this.config.settings.internalPort,
      gateway: { host: this.config.settings.gatewayHost, port: this.config.settings.gatewayPort },
      llamaServerPath: this.config.settings.llamaServerPath,
      queueLength: this.gate.queueLength,
      inflightRequests: this.gate.inflightCount,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      modelReadyAt: current?.readyAt ?? null,
      lastError: this.lastError,
      warnings: this.warnings,
      staleProcess: this.staleProcess,
      stats: { ...this.stats },
      models: this.listModels(),
    };
  }

  listModels() {
    return Object.values(this.config.models).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      modelPath: model.modelPath,
      arguments: model.arguments,
      enabled: model.enabled !== false,
    }));
  }

  // ───────────────────────── config lifecycle ─────────────────────────

  /** Validate + apply + persist a new configuration object. */
  applyConfig(rawConfig, { persist = true, reason = 'config-update' } = {}) {
    const { config, warnings } = normalizeConfig(rawConfig);
    this.config = config;
    this.warnings = warnings;
    this.gate.configure({
      maxConcurrentRequests: config.settings.maxConcurrentRequests,
      maxQueuedRequests: config.settings.maxQueuedRequests,
    });
    if (persist) saveConfig(config, this.configPath);
    this.log.info(`[manager] config applied (${reason}), ${Object.keys(config.models).length} model(s)`);
    for (const warning of warnings) this.log.warn(`[manager] ${warning}`);
    this.emit('config', config);
    return config;
  }

  reloadConfigFromDisk() {
    const { config, warnings, filePath } = loadConfig(this.configPath);
    this.config = config;
    this.warnings = warnings;
    this.gate.configure({
      maxConcurrentRequests: config.settings.maxConcurrentRequests,
      maxQueuedRequests: config.settings.maxQueuedRequests,
    });
    return { config, warnings, filePath };
  }

  upsertModel(entry, { persist = true } = {}) {
    const model = normalizeModel(entry.id, entry);
    const next = cloneConfig(this.config);
    next.models[model.id] = model;
    this.applyConfig(next, { persist, reason: `model ${model.id} saved` });
    return model;
  }

  deleteModel(id, { persist = true } = {}) {
    const model = findModel(this.config.models, id);
    if (!model) throw new UnknownModelError(id, Object.keys(this.config.models));
    if (this.current?.model.id === model.id) {
      throw new RequestError(
        `模型 ${model.id} 正在运行，请先 Unload（或切换到其它模型）后再删除。`,
        { status: 409, code: 'MODEL_IN_USE', detail: { id: model.id } },
      );
    }
    const next = cloneConfig(this.config);
    delete next.models[model.id];
    if (next.settings.startupModel === model.id) next.settings.startupModel = null;
    this.applyConfig(next, { persist, reason: `model ${model.id} deleted` });
    return model;
  }

  /**
   * Resolve + parse the launch command for a model without starting anything.
   * Used by the settings page preview and by the "auto-fill base arguments" action.
   */
  previewLaunch(modelRef) {
    const model = this._resolveModel(modelRef);
    const launch = this._buildLaunch(model);
    return {
      modelId: model.id,
      executable: this.config.settings.llamaServerPath,
      argv: launch.argv,
      commandLine: formatArgvForLog(this.config.settings.llamaServerPath || 'llama-server', launch.argv),
      effectivePort: launch.effectivePort,
      effectiveHost: launch.effectiveHost,
      modelPathArg: launch.modelPathArg,
      autoFilled: launch.autoFilled,
      notes: launch.notes,
      userTokenCount: launch.tokenCount,
    };
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Startup: inspect leftovers, then optionally preload the configured model. */
  async initialize() {
    this.handleStaleOnStartup().catch((error) => {
      this.log.debug(`[manager] stale process inspection failed: ${error.message}`);
    });
    const startupModel = this.config.settings.startupModel;
    if (!startupModel) {
      this.log.info('[manager] startupModel = none, no model will be preloaded');
      return { preload: null };
    }
    const model = findModel(this.config.models, startupModel);
    if (!model) {
      this.log.warn(`[manager] startupModel "${startupModel}" 不在模型列表中，跳过预加载`);
      return { preload: null };
    }
    this.log.info(`[manager] preloading startup model ${model.id}`);
    // Fire and forget: DSH must not be blocked by a 180s model load.
    this.load(model.id, { reason: 'startup-model' }).then(
      () => this.log.info(`[manager] startup model ${model.id} is ready`),
      (error) => this.log.error(`[manager] startup preload of ${model.id} failed: ${error.message}`),
    );
    return { preload: model.id };
  }

  /** Stop everything and let the plugin exit cleanly. */
  async shutdown({ reason = 'plugin shutdown' } = {}) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info(`[manager] shutting down (${reason})`);
    try {
      this.gate.abortAll(reason);
    } catch {
      /* ignore */
    }
    const current = this.current;
    if (current?.proc) {
      this.log.info(`[manager] stopping llama-server pid=${current.proc.pid}`);
      try {
        await current.proc.stop({
          graceMs: Math.max(3000, this.config.settings.shutdownTimeoutMs),
          reason,
          logger: this.log,
          method: this.config.settings.stopMethod,
        });
      } catch (error) {
        this.log.warn(`[manager] stop during shutdown failed: ${error.message}`);
        try {
          await current.proc.killNow(reason);
        } catch {
          /* ignore */
        }
      }
    }
    this.current = null;
    this.setState(STATE.STOPPED);
    this._clearRuntimeState();
    this.log.info('[manager] shutdown complete');
  }

  /**
   * Main entry for the proxy: make `modelRef` the ready model and hold a shared
   * ticket so the model cannot be switched away while the request is served.
   *
   * @returns {Promise<{model: object, release: () => void}>}
   */
  async acquireForRequest(modelRef, { signal = null, reason = 'request' } = {}) {
    if (this.shuttingDown) {
      throw new ModelUnavailableError('插件正在关闭，拒绝新的请求。', { code: 'SHUTTING_DOWN' });
    }
    const resolved = this._resolveModel(modelRef);
    this._assertUsable(resolved);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw new GateAbortedError('client disconnected');
      const release = await this._acquireInference(signal);
      if (this._isReady(resolved)) {
        return { model: resolved, release };
      }
      release();
      const releaseExclusive = await this._acquireExclusive(reason);
      try {
        this._assertUsable(resolved);
        if (!this._isReady(resolved)) {
          await this._switchTo(resolved, { reason });
        }
      } finally {
        releaseExclusive();
      }
    }
    throw new ModelUnavailableError('模型切换过于频繁，请稍后重试。', { code: 'SWITCH_CONTENTION' });
  }

  /** Explicit load / preload (`POST /manager/load`). */
  async load(modelRef, { reason = 'api-load', force = false } = {}) {
    // An explicit load/restart is the user's way out of the crash lock, so it
    // deliberately ignores it (auto recovery is what stays bounded).
    const model = this._resolveModel(modelRef);
    this._assertUsable(model, { ignoreCrashLock: true });
    const release = await this._acquireExclusive(reason);
    try {
      if (this._isReady(model) && !force) {
        this.log.info(`[manager] model ${model.id} already loaded, nothing to do`);
        return { model, reused: true };
      }
      const result = await this._switchTo(model, { reason, force });
      return result;
    } finally {
      release();
    }
  }

  /** Explicit unload (`POST /manager/unload`); the gateway keeps running. */
  async unload({ reason = 'api-unload' } = {}) {
    const release = await this._acquireExclusive(reason);
    try {
      if (!this.current) {
        return { unloaded: false, note: '当前没有已加载的模型' };
      }
      const modelId = this.current.model.id;
      await this._stopCurrent({ reason });
      this._crashLockModelId = null;
      return { unloaded: true, modelId };
    } finally {
      release();
    }
  }

  /** Explicit restart (`POST /manager/restart`). */
  async restart(modelRef = null, { reason = 'api-restart' } = {}) {
    const target = modelRef ?? this.current?.model.id ?? null;
    if (!target) {
      throw new RequestError('当前没有已加载的模型，且未指定要重启的模型。', {
        status: 400,
        code: 'NO_MODEL',
      });
    }
    const model = this._resolveModel(target);
    const release = await this._acquireExclusive(reason);
    try {
      return await this._switchTo(model, { reason, force: true });
    } finally {
      release();
    }
  }

  // ───────────────────────── internals ─────────────────────────

  _resolveModel(modelRef) {
    const model = findModel(this.config.models, modelRef);
    if (!model) {
      throw new UnknownModelError(modelRef, Object.keys(this.config.models));
    }
    if (model.enabled === false) {
      throw new RequestError(`模型 ${model.id} 已被禁用。`, {
        status: 409,
        code: 'MODEL_DISABLED',
        detail: { modelId: model.id },
      });
    }
    return model;
  }

  /** Crash lock: after an unexpected crash we refuse to auto-reload until told to. */
  _assertUsable(model, { ignoreCrashLock = false } = {}) {
    if (ignoreCrashLock) return;
    if (this._crashLockModelId && this._crashLockModelId === model.id) {
      throw new ModelUnavailableError(
        `模型 ${model.id} 的 llama-server 之前异常退出，为避免无限重启已暂停自动加载。` +
          '请在设置页点击 Restart，或调用 POST /manager/restart / POST /manager/load 重新加载。',
        {
          code: 'CRASH_LOCKED',
          detail: { modelId: model.id, lastError: this.lastError },
        },
      );
    }
  }

  _isReady(model) {
    return (
      this.state === STATE.READY &&
      !!this.current &&
      this.current.model.id === model.id &&
      !this.current.proc.exited
    );
  }

  async _acquireInference(signal) {
    try {
      return await this.gate.acquireInference({ signal });
    } catch (error) {
      if (error instanceof QueueFullError) {
        throw new QueueFullRequestError(error.message, { limit: error.limit });
      }
      throw error;
    }
  }

  async _acquireExclusive(reason) {
    const { forceShutdownAfterTimeoutMs } = this.config.settings;
    try {
      return await this.gate.acquireExclusive({
        drainTimeoutMs: forceShutdownAfterTimeoutMs,
        onDrainTimeout: () => {
          this.log.warn(
            `[manager] 等待进行中的推理请求结束超过 ${forceShutdownAfterTimeoutMs}ms（${reason}），将中断该请求以继续切换`,
          );
          this._abortInflight('model switch deadline reached');
        },
      });
    } catch (error) {
      if (error instanceof QueueFullError) {
        throw new QueueFullRequestError(error.message, { limit: error.limit });
      }
      throw error;
    }
  }

  /** Track an in-flight upstream request so a forced switch can cancel it. */
  trackInflight(controller) {
    this._inflightControllers.add(controller);
    return () => this._inflightControllers.delete(controller);
  }

  _abortInflight(reason) {
    for (const controller of [...this._inflightControllers]) {
      try {
        controller.abort(new Error(reason));
      } catch {
        /* ignore */
      }
    }
    this._inflightControllers.clear();
  }

  _buildLaunch(model) {
    const settings = this.config.settings;
    try {
      return buildLaunchArgs({
        modelPath: model.modelPath,
        argumentsText: model.arguments,
        internalPort: settings.internalPort,
        host: '127.0.0.1',
        gatewayPort: settings.gatewayPort,
      });
    } catch (error) {
      if (error instanceof LaunchConfigError) {
        throw new RequestError(`模型 ${model.id} 的启动参数非法：${error.message}`, {
          status: 400,
          code: 'INVALID_LAUNCH_ARGS',
          detail: { modelId: model.id, ...error.detail },
        });
      }
      throw error;
    }
  }

  _fail(message, detail, code) {
    return new StartupFailure(message, { code, ...detail });
  }

  /** Everything we can check BEFORE spawning a process (spec §37). */
  async _preflight(model, launch) {
    const settings = this.config.settings;
    const exePath = settings.llamaServerPath;

    if (!exePath || String(exePath).trim() === '') {
      throw this._fail(
        '未配置 llama-server 可执行文件路径（llamaServerPath）。请在插件设置页填写。',
        { modelId: model.id, modelPath: model.modelPath },
        'LLAMA_SERVER_NOT_CONFIGURED',
      );
    }
    if (!isExistingFile(exePath)) {
      throw this._fail(
        `llama-server 可执行文件不存在：${exePath}`,
        { modelId: model.id, modelPath: model.modelPath, llamaServerPath: exePath },
        'LLAMA_SERVER_MISSING',
      );
    }
    if (!isExistingFile(launch.modelPathArg)) {
      throw this._fail(
        `GGUF 模型文件不存在：${launch.modelPathArg}`,
        { modelId: model.id, modelPath: launch.modelPathArg },
        'MODEL_FILE_MISSING',
      );
    }
    for (const { flag, value } of collectPathArguments(launch.argv)) {
      if (!value) continue;
      if (flag === '-m' || flag === '--model') continue; // already checked above
      if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
        if (!isExistingFile(value)) {
          throw this._fail(
            `启动参数 ${flag} 指向的文件不存在：${value}`,
            { modelId: model.id, modelPath: model.modelPath, flag, value },
            'AUX_FILE_MISSING',
          );
        }
      }
    }

    const availability = await checkPortAvailable(launch.effectiveHost, launch.effectivePort);
    if (!availability.free) {
      const owner = await describePortOwner(launch.effectivePort, { execFileImpl: this.execFileImpl });
      const ownerText = owner.pid
        ? `当前占用者：PID ${owner.pid}${owner.imageName ? ` (${owner.imageName})` : ''}`
        : '未能确定占用者';
      throw this._fail(
        `内部端口 ${launch.effectivePort} 已被占用，无法启动 llama-server。${ownerText}`,
        {
          modelId: model.id,
          modelPath: model.modelPath,
          port: launch.effectivePort,
          portOwner: owner,
        },
        'PORT_IN_USE',
      );
    }
    return launch;
  }

  async _startModel(model, { reason }) {
    const settings = this.config.settings;
    const launch = this._buildLaunch(model);
    await this._preflight(model, launch);

    this.log.info(`[manager] starting ${model.id}`);
    this.log.debug(
      `[manager] command arguments parsed successfully (user tokens: ${launch.tokenCount}, auto-filled: ${
        launch.autoFilled.length ? launch.autoFilled.join(', ') : 'none'
      })`,
    );
    for (const note of launch.notes) this.log.warn(`[manager] ${note}`);
    this.log.info(`[manager] exec: ${formatArgvForLog(settings.llamaServerPath, launch.argv)}`);

    const proc = new LlamaServerProcess({
      exePath: settings.llamaServerPath,
      argv: launch.argv,
      cwd: path.dirname(settings.llamaServerPath),
      onLogLine: (line, stream) => {
        if (stream === 'stderr') this.log.debug(`[llama] ${line}`);
        else this.log.debug(`[llama:stdout] ${line}`);
      },
      ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
    });

    const entry = {
      model,
      port: launch.effectivePort,
      connectHost: launch.connectHost,
      argv: launch.argv,
      launch,
      proc,
      startedAt: Date.now(),
      readyAt: null,
      reason,
    };
    this.current = entry;

    try {
      proc.start();
    } catch (error) {
      this.current = null;
      throw this._fail(
        `无法启动 llama-server 进程：${error.message}`,
        { modelId: model.id, modelPath: model.modelPath, llamaServerPath: settings.llamaServerPath },
        'SPAWN_FAILED',
      );
    }
    this.log.info(`[manager] llama-server spawned pid=${proc.pid}`);
    this._writeRuntimeState();

    // Crash watcher: only fires for processes that reached READY (startup exits
    // are handled synchronously below).
    proc.once('exit', (info) => this._onProcessExit(entry, info));

    this.setState(STATE.STARTING, { modelId: model.id });
    this.log.info('[manager] waiting for health');
    try {
      const health = await waitForHealth({
        processState: () => ({
          exited: proc.exited,
          exitCode: proc.exitCode,
          tail: (n) => proc.tail(n),
        }),
        connectHost: entry.connectHost,
        port: entry.port,
        healthPath: settings.healthPath,
        fallbackPath: settings.healthFallbackPath,
        timeoutMs: settings.startupTimeoutMs,
        intervalMs: settings.healthCheckIntervalMs,
        probeTimeoutMs: settings.healthProbeTimeoutMs,
        logger: this.log,
        fetchImpl: this.fetchImpl,
      });
      this.log.info(`[manager] health OK via ${health.endpoint} after ${health.waitedMs}ms`);
    } catch (error) {
      await this._cleanupFailedStart(entry);
      throw this._describeStartFailure(model, launch, proc, error);
    }

    entry.readyAt = Date.now();
    this._crashLockModelId = null;
    this.setState(STATE.READY, { modelId: model.id });
    this.stats.loads += 1;
    this.log.info(`[manager] model ${model.id} is ready`);
    return { model, reused: false, argv: launch.argv, port: entry.port };
  }

  _describeStartFailure(model, launch, proc, error) {
    const isTimeout = error.code === 'HEALTH_TIMEOUT';
    const isEarlyExit = error.code === 'EARLY_EXIT';
    const headline = isTimeout
      ? `启动模型 ${model.id} 失败：等待就绪超时`
      : isEarlyExit
        ? `启动模型 ${model.id} 失败：llama-server 在就绪前退出（exit code=${proc.exitCode ?? 'unknown'}）`
        : `启动模型 ${model.id} 失败：${error.message}`;
    const stderrLines = Array.isArray(error.stderrLines) && error.stderrLines.length
      ? error.stderrLines
      : proc.tail(60);
    return this._fail(
      headline,
      {
        modelId: model.id,
        modelPath: launch.modelPathArg,
        llamaServerPath: this.config.settings.llamaServerPath,
        exitCode: proc.exitCode,
        port: launch.effectivePort,
        commandLine: formatArgvForLog(this.config.settings.llamaServerPath, launch.argv),
        stderrTail: stderrLines.slice(-100),
        stderrLineCount: stderrLines.length,
        detail: error.message,
      },
      isTimeout ? 'STARTUP_TIMEOUT' : isEarlyExit ? 'EARLY_EXIT' : 'STARTUP_FAILED',
    );
  }

  async _cleanupFailedStart(entry) {
    if (!entry?.proc) return;
    if (!entry.proc.exited) {
      this.log.warn(`[manager] cleaning up failed llama-server pid=${entry.proc.pid}`);
      try {
        await entry.proc.killNow('failed start cleanup');
      } catch (error) {
        this.log.warn(`[manager] cleanup kill failed: ${error.message}`);
      }
    }
    if (this.current === entry) this.current = null;
    if (this.state !== STATE.ERROR) this.setState(STATE.STOPPED);
    this._clearRuntimeState();
  }

  /**
   * Transition to `model`. MUST be called while holding the exclusive ticket.
   */
  async _switchTo(model, { reason, force = false }) {
    const previous = this.current;
    const previousModel = previous?.model ?? null;

    if (!force && previousModel && previousModel.id === model.id && this._isReady(model)) {
      this.log.info(`[manager] model ${model.id} is already the current model; reusing without restart`);
      return { model, reused: true, argv: previous.argv, port: previous.port };
    }

    const isSwitch = !!previousModel && previousModel.id !== model.id;
    if (isSwitch) {
      this.log.info(`[manager] switching ${previousModel.id} -> ${model.id} (${reason})`);
      this.setState(STATE.SWITCHING, { from: previousModel.id, to: model.id });
    }

    if (previous) {
      await this._stopCurrent({ reason: isSwitch ? 'switch' : 'reload' });
    }

    const attempts = 1 + Math.max(0, this.config.settings.maxRetries);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (attempt > 1) this.log.warn(`[manager] retrying start of ${model.id} (attempt ${attempt}/${attempts})`);
        const result = await this._startModel(model, { reason });
        if (isSwitch) {
          this.stats.switches += 1;
          this.stats.lastSwitchAt = Date.now();
        }
        return { ...result, previousModel: previousModel?.id ?? null };
      } catch (error) {
        lastError = error;
        this.stats.failures += 1;
        this.log.error(`[manager] failed to start ${model.id}: ${error.message}`);
        if (error.detail?.exitCode !== undefined && error.detail?.exitCode !== null) {
          this.log.error(`[manager] exit code=${error.detail.exitCode}`);
        }
        const stderrTail = error.detail?.stderrTail ?? [];
        if (stderrTail.length) {
          this.log.error('[manager] stderr:');
          for (const line of stderrTail.slice(-40)) this.log.error(`[manager] | ${line}`);
        }
        await this._cleanupFailedStart(this.current);
      }
    }

    this._recordError(lastError);
    this.setState(STATE.ERROR, { modelId: model.id });

    // Failsafe rollback: never let one bad switch destroy a working model.
    let rolledBack = null;
    if (previousModel && previousModel.id !== model.id) {
      this.log.warn(`[manager] attempting rollback to previous model ${previousModel.id}`);
      try {
        await this._startModel(previousModel, { reason: 'rollback' });
        rolledBack = previousModel.id;
        this._crashLockModelId = model.id;
        this.log.info(`[manager] rollback to ${previousModel.id} succeeded; model is ready again`);
      } catch (rollbackError) {
        this.log.error(`[manager] rollback to ${previousModel.id} failed: ${rollbackError.message}`);
        this._recordError(rollbackError);
        this.setState(STATE.ERROR, { modelId: nextErrorModelId(model, previousModel) });
      }
    }

    if (lastError) {
      lastError.detail = {
        ...(lastError.detail ?? {}),
        rolledBackTo: rolledBack,
        previousModel: previousModel?.id ?? null,
        reason,
      };
      if (rolledBack) {
        lastError.message = `${lastError.message}（已自动回滚到 ${rolledBack}，该模型仍可使用）`;
      }
    }
    throw lastError;
  }

  async _stopCurrent({ reason }) {
    const entry = this.current;
    if (!entry) {
      this.setState(STATE.STOPPED);
      return { stopped: false };
    }
    this.setState(STATE.STOPPING, { modelId: entry.model.id });
    this.log.info(`[manager] stopping llama-server pid=${entry.proc.pid} (${reason})`);
    const result = await entry.proc.stop({
      graceMs: Math.max(1000, this.config.settings.shutdownTimeoutMs),
      reason,
      logger: this.log,
      method: this.config.settings.stopMethod,
    });
    this.log.info(
      `[manager] llama-server exited code=${entry.proc.exitCode ?? 'null'}${result.forced ? ` (forced via ${result.method})` : ` (graceful via ${result.method})`}`,
    );
    if (this.current === entry) this.current = null;
    this._clearRuntimeState();
    this.setState(STATE.STOPPED);
    return { stopped: true, code: entry.proc.exitCode, forced: !!result.forced, method: result.method ?? null };
  }

  /** Unexpected exit of a READY server. */
  _onProcessExit(entry, info) {
    if (this.current !== entry) return;
    if (entry.proc.stopRequested) return; // intentional stop, handled by _stopCurrent
    if (this.state !== STATE.READY) return; // startup failures are handled synchronously

    this.stats.crashes += 1;
    const tail = entry.proc.tail(100);
    this._recordError(
      new ModelUnavailableError(
        `模型 ${entry.model.id} 的 llama-server 意外退出：exit code=${info.code ?? 'unknown'} signal=${
          info.signal ?? 'none'
        }`,
        {
          code: 'SERVER_CRASHED',
          detail: { modelId: entry.model.id, exitCode: info.code, signal: info.signal, stderrTail: tail },
        },
      ),
    );
    this.log.error(`[manager] llama-server crashed pid=${entry.proc.pid} code=${info.code}`);
    if (tail.length) {
      this.log.error('[manager] stderr:');
      for (const line of tail.slice(-40)) this.log.error(`[manager] | ${line}`);
    }
    this.current = null;
    this._clearRuntimeState();
    this.setState(STATE.ERROR, { modelId: entry.model.id });
    this._abortInflight('llama-server crashed');

    const modelId = entry.model.id;
    if (this.config.settings.autoRecoverAfterCrash && !this._autoRecovered.has(modelId) && !this.shuttingDown) {
      this._autoRecovered.add(modelId);
      this.log.warn(`[manager] auto-recovering ${modelId} once (autoRecoverAfterCrash=true)`);
      setTimeout(() => {
        this.load(modelId, { reason: 'auto-recover-after-crash' }).catch((error) => {
          this.log.error(`[manager] auto-recovery of ${modelId} failed: ${error.message}`);
          this._crashLockModelId = modelId;
        });
      }, 500);
    } else {
      this._crashLockModelId = modelId;
      this.log.warn(
        `[manager] ${modelId} 已锁定为需手动重启状态（不会无限自动重启）；可在设置页 Restart 或调用 POST /manager/restart`,
      );
    }
  }

  _recordError(error) {
    if (!error) return;
    this.lastError = {
      message: error.message,
      code: error.code ?? error.name ?? 'ERROR',
      at: Date.now(),
      modelId: error.detail?.modelId ?? null,
      exitCode: error.detail?.exitCode ?? null,
      detail: error.detail ?? null,
    };
  }

  clearLastError() {
    this.lastError = null;
  }

  setState(next, meta = {}) {
    const previous = this.state;
    this.state = next;
    if (previous !== next) {
      this.log.debug(`[manager] state ${previous} -> ${next}${meta.modelId ? ` (${meta.modelId})` : ''}`);
    }
    this.emit('state', { state: next, previous, ...meta });
  }

  // ───────────────────────── runtime state file ─────────────────────────

  _writeRuntimeState() {
    const entry = this.current;
    if (!entry) return;
    const payload = {
      pid: entry.proc.pid,
      modelId: entry.model.id,
      modelPath: entry.model.modelPath,
      port: entry.port,
      exePath: this.config.settings.llamaServerPath,
      startedAt: entry.startedAt,
      managerPid: process.pid,
    };
    try {
      fs.mkdirSync(path.dirname(this._runtimePath), { recursive: true });
      fs.writeFileSync(this._runtimePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.log.debug(`[manager] could not write runtime state: ${error.message}`);
    }
  }

  _clearRuntimeState() {
    try {
      if (fs.existsSync(this._runtimePath)) fs.unlinkSync(this._runtimePath);
    } catch {
      /* best effort */
    }
  }

  _readRuntimeState() {
    try {
      return JSON.parse(fs.readFileSync(this._runtimePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Look for a llama-server left behind by a previous run of THIS plugin.
   * Never touches anything we cannot positively attribute to ourselves
   * (recorded pid + matching image name + matching served model on the port).
   */
  async _inspectStaleProcess({ cleanup = false } = {}) {
    const recorded = this._readRuntimeState();
    if (!recorded?.pid) return null;

    const pid = Number(recorded.pid);
    const expectedImage = path.basename(String(recorded.exePath || this.config.settings.llamaServerPath || ''));
    const imageName = await this._queryImageName(pid);
    const alive = !!imageName;
    const isOurs = alive && (!expectedImage || imageName.toLowerCase() === expectedImage.toLowerCase());

    let servesRecordedModel = false;
    if (isOurs) {
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${recorded.port}/v1/models`, {
          signal: AbortSignal.timeout(2000),
        });
        const text = await response.text();
        servesRecordedModel = text.includes(escapeForIncludes(recorded.modelPath));
      } catch {
        servesRecordedModel = false;
      }
    }

    const attribution = isOurs && servesRecordedModel;
    this.staleProcess = {
      pid,
      alive,
      imageName,
      expectedImage,
      port: recorded.port,
      modelId: recorded.modelId,
      modelPath: recorded.modelPath,
      attributable: attribution,
      cleaned: false,
      detectedAt: Date.now(),
    };

    if (!alive) {
      this.log.info(`[manager] 上次运行记录的 llama-server (pid=${pid}) 已不存在，清理状态记录`);
      this._clearRuntimeState();
      this.staleProcess = null;
      return null;
    }
    if (!attribution) {
      this.log.warn(
        `[manager] 检测到 pid=${pid} 仍存在，但无法确认它由本插件启动（image=${imageName}），不会对它做任何操作。`,
      );
      this._clearRuntimeState();
      return this.staleProcess;
    }

    this.log.warn(
      `[manager] 检测到本插件上次运行遗留的 llama-server：pid=${pid}（模型 ${recorded.modelId}，端口 ${recorded.port}）`,
    );
    const detected = this.staleProcess;
    if (!cleanup) {
      this.log.warn(
        '[manager] 未自动清理。请先在设置页点击 “清理残留进程”，否则端口占用会导致新模型无法启动。',
      );
      return detected;
    }
    await this.cleanupStaleProcess().catch((error) => {
      // A cleanup that fails must never abort plugin startup: record it so the
      // settings page can show it, and leave `detected` (cleaned=false) to the
      // caller.
      this._recordError(error);
    });
    // cleanupStaleProcess() clears this.staleProcess as part of tidying up, so
    // return the snapshot we took before calling it -- otherwise a successful
    // cleanup would always report null and the caller could not tell what was
    // removed. `cleaned` is set on this same object, so it reads back as true.
    return detected;
  }

  /**
   * Image name of a live pid, or null when no such process exists.
   *
   * Locale-independent on purpose: on a non-Chinese/English Windows the
   * "no tasks match" line from `tasklist` is localized, so matching an English
   * "INFO:" prefix would report every dead pid as alive. A real process line is
   * always `"<image>","<pid>",...`, so matching that is the reliable test.
   *
   * @param {number} pid
   * @returns {Promise<string|null>}
   */
  async _queryImageName(pid) {
    try {
      const { stdout } = await this.execFileImpl('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const match = /^"([^"]+)"/.exec(String(stdout).trim());
      const name = match ? match[1] : null;
      return name && name !== 'INFO:' ? name : null;
    } catch {
      return null;
    }
  }

  /**
   * Wait until a pid is really gone, polling with a bounded deadline.
   *
   * A single immediate check is not enough: `taskkill /T` returns as soon as it
   * has issued the terminations, but tearing down a llama-server that holds
   * ~12 GB of VRAM takes a moment longer. Checking once made a successful kill
   * look like a failure.
   *
   * @param {number} pid
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true when the process is gone
   */
  async _waitForProcessGone(pid, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this._queryImageName(pid))) return true;
      if (Date.now() >= deadline) return false;
      // NOTE: deliberately NOT unref'd. Between two polls nothing else holds the
      // event loop open, so an unref'd timer lets Node decide it has no work and
      // exit mid-await ("unsettled top-level await"). This wait is short and
      // bounded, so keeping the loop alive is exactly what we want.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Kill the recorded leftover process (only after positive attribution). */
  async cleanupStaleProcess() {
    const stale = this.staleProcess;
    if (!stale?.attributable) {
      throw new RequestError('没有可确认归属于本插件的残留进程。', {
        status: 409,
        code: 'NO_ATTRIBUTABLE_STALE_PROCESS',
        detail: { stale },
      });
    }
    this.log.warn(`[manager] 清理残留 llama-server pid=${stale.pid}`);

    // Capture taskkill's own diagnostics: a silent failure here used to be
    // reported as a success, leaving the port and the VRAM occupied.
    let taskkillNote = '';
    await new Promise((resolve) => {
      const child = execFileCallback(
        'taskkill',
        ['/PID', String(stale.pid), '/T', '/F'],
        // windowsHide is required: taskkill is a console app and Node defaults
        // to windowsHide:false, which would flash a console window.
        // encoding:'buffer' so we can decode the OEM code page ourselves.
        { windowsHide: true, encoding: 'buffer' },
        (error, stdout, stderr) => {
          const detail = decodeConsoleOutput(error ? stderr : stdout).trim();
          taskkillNote = error ? `${error.message}${detail ? ` ${detail}` : ''}` : detail;
          resolve();
        },
      );
      child.on('error', (error) => {
        taskkillNote = error.message;
        resolve();
      });
    });

    // Verify rather than assume, but give the OS time to finish teardown.
    let gone = await this._waitForProcessGone(stale.pid, 15000);
    if (!gone) {
      // One more attempt without /T in case the tree walk was the problem.
      await new Promise((resolve) => {
        const child = execFileCallback('taskkill', ['/PID', String(stale.pid), '/F'], { windowsHide: true }, () =>
          resolve(),
        );
        child.on('error', () => resolve());
      });
      gone = await this._waitForProcessGone(stale.pid, 10000);
    }

    stale.cleaned = gone;
    stale.cleanupNote = taskkillNote || null;
    if (!gone) {
      this.log.error(`[manager] 残留进程 pid=${stale.pid} 无法结束：${taskkillNote || 'taskkill 未报告原因'}`);
      throw new RequestError(
        `无法结束残留进程 pid=${stale.pid}（可能需要管理员权限）：${taskkillNote || '未知原因'}`,
        { status: 500, code: 'STALE_CLEANUP_FAILED', detail: { stale } },
      );
    }

    this.log.info(`[manager] 残留进程 pid=${stale.pid} 已结束`);
    this._clearRuntimeState();
    const previous = this.staleProcess;
    this.staleProcess = null;
    return previous;
  }

  /** Startup hook invoked by the plugin host when the setting is enabled. */
  async handleStaleOnStartup() {
    if (!this.config.settings.cleanupStaleProcessOnStart) {
      await this._inspectStaleProcess({ cleanup: false });
      return;
    }
    await this._inspectStaleProcess({ cleanup: true });
  }

  /**
   * List candidate GGUF files in a directory so the settings page can offer
   * "add model" without the user typing a full Windows path. Read-only.
   * @param {string} dir
   * @param {{recursive?: boolean, limit?: number}} [options]
   */
  async scanModelDirectory(dir, { recursive = true, limit = 500 } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new RequestError('必须提供要扫描的目录路径（dir）。', {
        status: 400,
        code: 'MISSING_DIR',
      });
    }
    const root = path.resolve(dir.trim());
    let stat;
    try {
      stat = fs.statSync(root);
    } catch {
      throw new RequestError(`目录不存在或无法访问：${root}`, { status: 400, code: 'DIR_NOT_FOUND' });
    }
    if (!stat.isDirectory()) {
      throw new RequestError(`不是目录：${root}`, { status: 400, code: 'NOT_A_DIRECTORY' });
    }

    const found = [];
    const skip = new Set(['$recycle.bin', 'system volume information', 'node_modules']);
    const walk = (current, depth) => {
      if (found.length >= limit || depth > 6) return;
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= limit) return;
        if (entry.name.startsWith('.') || skip.has(entry.name.toLowerCase())) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive) walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.gguf$/i.test(entry.name)) continue;
        if (/^mmproj[-_.]/i.test(entry.name)) continue; // multimodal projectors are not chat models
        let size = null;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = null;
        }
        found.push({
          path: full,
          fileName: entry.name,
          sizeBytes: size,
          suggestedId: suggestModelId(entry.name),
        });
      }
    };
    walk(root, 0);
    return { dir: root, found, truncated: found.length >= limit };
  }
}

/** Turn a GGUF file name into a short, URL-safe model id the user can override. */
export function suggestModelId(fileName) {
  const base = String(fileName).replace(/\.gguf$/i, '');
  const cleaned = base
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._@:+-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (cleaned || 'model').slice(0, 128).toLowerCase();
}

function nextErrorModelId(target, previous) {
  return previous?.id ?? target.id;
}

function escapeForIncludes(value) {
  // /v1/models echoes the path with escaped backslashes; compare on the basename
  // to stay robust across llm builds that redact or normalize the path.
  const text = String(value ?? '');
  const base = text.split(/[\\/]/).pop() ?? text;
  return base;
}

/**
 * Decode output from a Windows console program.
 *
 * `taskkill` and `tasklist` write in the console OEM code page (GBK/936 on this
 * machine), not UTF-8, so Node's default utf8 decoding renders their Chinese
 * messages as replacement characters -- which would surface as mojibake in the
 * settings page. Try UTF-8 first and, only if that produced replacement
 * characters, retry with the OEM code page. Falls back to the utf8 result when
 * no decoder is available.
 *
 * @param {string|Buffer|null|undefined} value
 * @returns {string}
 */
export function decodeConsoleOutput(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const encoding of ['gbk', 'gb18030']) {
    try {
      const decoded = new TextDecoder(encoding).decode(buffer);
      if (!decoded.includes('\uFFFD')) return decoded;
    } catch {
      /* decoder not available in this Node build */
    }
  }
  return utf8;
}
