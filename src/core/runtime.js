/**
 * Runtime wiring shared by the DSH plugin and the standalone entry point:
 * config -> logger -> manager -> gateway.
 */
import { emptyConfig, loadConfig, normalizeConfig, resolveConfigPath, saveConfig } from './config.js';
import { Logger } from './logger.js';
import { LlamaModelManager } from './manager.js';
import { Gateway } from './gateway.js';

/**
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {object|null} [options.seed]        config used when the file does not exist yet
 * @param {string} [options.logLevel]
 * @param {(level: string, line: string) => void|null} [options.sink]
 * @param {Logger} [options.logger]
 */
export async function createRuntime({
  configPath = resolveConfigPath(),
  seed = null,
  logLevel = 'info',
  sink = null,
  logger = null,
} = {}) {
  const log = logger ?? new Logger({ level: logLevel, sink });

  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (error) {
    // A broken config file must not take DSH down: fall back to a seed/default
    // config in memory, keep the broken file untouched, and report loudly.
    log.error(`[manager] 读取配置失败：${error.message}`);
    const fallback = seed ? normalizeConfig(seed).config : emptyConfig();
    loaded = {
      config: fallback,
      warnings: [`配置文件读取失败，已使用内存中的默认配置（原文件未修改）：${configPath}`],
      filePath: configPath,
      existed: true,
      broken: true,
    };
  }

  let config = loaded.config;
  const warnings = [...loaded.warnings];

  if (!loaded.existed) {
    if (seed) {
      const seeded = normalizeConfig(seed);
      config = seeded.config;
      warnings.push(...seeded.warnings);
      log.info(`[manager] 未找到配置，已按内置种子创建：${configPath}`);
    } else {
      log.info(`[manager] 未找到配置，已写入默认配置：${configPath}`);
    }
    try {
      saveConfig(config, configPath);
    } catch (error) {
      log.warn(`[manager] 无法写入配置文件（将以内存配置运行）：${error.message}`);
    }
  }

  const manager = new LlamaModelManager({ config, configPath, logger: log });
  manager.warnings = warnings;
  for (const warning of warnings) log.warn(`[manager] ${warning}`);

  const gateway = new Gateway({
    manager,
    logger: log,
    host: manager.config.settings.gatewayHost,
    port: manager.config.settings.gatewayPort,
  });

  let started = false;

  return {
    logger: log,
    manager,
    gateway,
    configPath,
    warnings,
    get config() {
      return manager.config;
    },
    /** Bind the gateway, then start the (optional) startup preload. */
    async start({ listen = true, preload = true } = {}) {
      if (started) return { address: gateway.address };
      started = true;
      let listenError = null;
      if (listen) {
        try {
          await gateway.listen();
        } catch (error) {
          listenError = error;
          log.error(`[manager] ${error.message}`);
          manager._recordError(error);
          manager.setState('error', { reason: 'gateway-listen-failed' });
        }
      }
      if (preload && !listenError) {
        await manager.initialize();
      }
      return { address: gateway.address, listenError };
    },
    async stop({ reason = 'runtime stop' } = {}) {
      await manager.shutdown({ reason });
      await gateway.close();
    },
  };
}
