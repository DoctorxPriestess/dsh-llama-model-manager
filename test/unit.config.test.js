/**
 * Unit tests for config normalization, validation and persistence (spec §8, §30).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ConfigError,
  DEFAULT_SETTINGS,
  emptyConfig,
  findModel,
  loadConfig,
  normalizeConfig,
  normalizeModel,
  resolveConfigPath,
  saveConfig,
} from '../src/core/config.js';

/**
 * Temp config paths. Every directory is tracked so it can be removed on exit --
 * previously these accumulated in %TEMP% (45 leftovers were found).
 */
const tmpDirs = [];

function tmpFile(name = 'config.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-mm-config-'));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test('empty config carries every documented default', () => {
  const config = emptyConfig();
  assert.equal(config.settings.gatewayPort, 8080);
  assert.equal(config.settings.internalPort, 18080);
  assert.equal(config.settings.startupTimeoutMs, 180000);
  assert.equal(config.settings.healthCheckIntervalMs, 500);
  assert.equal(config.settings.maxQueuedRequests, 10);
  assert.equal(config.settings.maxConcurrentRequests, 1);
  assert.equal(config.settings.maxRetries, 1);
  assert.equal(config.settings.startupModel, null);
  assert.deepEqual(config.models, {});
  assert.equal(DEFAULT_SETTINGS.forceShutdownAfterTimeoutMs, 300000);
  assert.equal(config.settings.stopMethod, 'auto', 'graceful CTRL+C is the default stop method');
  assert.equal(config.settings.cleanupStaleProcessOnStart, false);
});

test('stopMethod only accepts the documented values', () => {
  for (const value of ['auto', 'ctrl-c', 'taskkill']) {
    assert.equal(normalizeConfig({ settings: { stopMethod: value } }).config.settings.stopMethod, value);
  }
  assert.throws(() => normalizeConfig({ settings: { stopMethod: 'kill -9' } }), /stopMethod/);
});

test('models are normalized with modelPath and arguments kept separate', () => {
  const { config } = normalizeConfig({
    models: {
      'qwen38-iq3s': {
        displayName: 'Qwen3.8-27B IQ3_S',
        modelPath: 'C:\\models\\Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf',
        arguments: '  --ctx-size 131072 -fa on  \n',
      },
    },
  });
  const model = config.models['qwen38-iq3s'];
  assert.equal(model.displayName, 'Qwen3.8-27B IQ3_S');
  assert.equal(model.modelPath, 'C:\\models\\Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf');
  assert.equal(model.arguments, '--ctx-size 131072 -fa on');
  assert.equal(model.enabled, true);
});

test('model arguments are preserved verbatim (only outer whitespace trimmed)', () => {
  const raw = '--mmproj "D:\\a b\\mm.gguf" --no-mmproj-offload -ctk q4_0 -ctv q4_0 --jinja';
  const model = normalizeModel('x', { modelPath: 'D:\\m.gguf', arguments: raw });
  assert.equal(model.arguments, raw);
});

test('a missing GGUF path is rejected', () => {
  assert.throws(() => normalizeModel('x', { displayName: 'x' }), ConfigError);
});

test('an illegal model id is rejected', () => {
  assert.throws(() => normalizeModel('bad id!', { modelPath: 'D:\\m.gguf' }), ConfigError);
});

test('gateway and internal port collision is rejected', () => {
  assert.throws(
    () => normalizeConfig({ settings: { gatewayPort: 18080, internalPort: 18080 } }),
    (error) => error instanceof ConfigError && /不能相同/.test(error.message),
  );
});

test('out-of-range numeric settings are rejected with the field name', () => {
  assert.throws(
    () => normalizeConfig({ settings: { gatewayPort: 99999 } }),
    (error) => error instanceof ConfigError && /gatewayPort/.test(error.message),
  );
  assert.throws(() => normalizeConfig({ settings: { maxConcurrentRequests: 0 } }), ConfigError);
});

test('startupModel pointing at an unknown model only warns', () => {
  const { config, warnings } = normalizeConfig({ settings: { startupModel: 'nope' }, models: {} });
  assert.equal(config.settings.startupModel, 'nope');
  assert.equal(warnings.length, 1);
});

test('startupModel "none"/""/null means no preload', () => {
  for (const value of ['none', '', null]) {
    const { config } = normalizeConfig({ settings: { startupModel: value } });
    assert.equal(config.settings.startupModel, null);
  }
});

test('unknown top-level and per-model keys survive a round trip (forward compatibility)', () => {
  const { config } = normalizeConfig({
    futureSection: { a: 1 },
    models: { x: { modelPath: 'D:\\m.gguf', futureField: 'keep-me' } },
  });
  assert.deepEqual(config.futureSection, { a: 1 });
  assert.equal(config.models.x.futureField, 'keep-me');
  const again = normalizeConfig(JSON.parse(JSON.stringify(config))).config;
  assert.deepEqual(again.futureSection, { a: 1 });
  assert.equal(again.models.x.futureField, 'keep-me');
});

test('save + load round trip is atomic and creates a .bak on rewrite', () => {
  const file = tmpFile();
  const { config } = normalizeConfig({
    settings: { llamaServerPath: 'C:\\bin\\llama-server.exe' },
    models: { a: { modelPath: 'D:\\a.gguf', arguments: '--ctx-size 4096' } },
  });
  saveConfig(config, file);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp')), false, 'no temp files left behind');

  const first = loadConfig(file);
  assert.equal(first.config.settings.llamaServerPath, 'C:\\bin\\llama-server.exe');
  assert.equal(first.config.models.a.arguments, '--ctx-size 4096');

  saveConfig({ ...config, settings: { ...config.settings, internalPort: 19000 } }, file);
  assert.ok(fs.existsSync(`${file}.bak`), 'backup of the previous revision exists');
  assert.equal(loadConfig(file).config.settings.internalPort, 19000);
});

test('a missing config file is reported and defaults are used', () => {
  const file = tmpFile('absent.json');
  const result = loadConfig(file);
  assert.equal(result.existed, false);
  assert.equal(result.config.settings.gatewayPort, 8080);
});

test('a broken JSON config file raises a clear ConfigError, naming the file', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(
    () => loadConfig(file),
    (error) => error instanceof ConfigError && error.message.includes(file),
  );
});

test('findModel matches by id (case-insensitive), by full path and by file name', () => {
  const { config } = normalizeConfig({
    models: {
      'qwen38-iq3s': { modelPath: 'C:\\models\\Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf' },
    },
  });
  const models = config.models;
  assert.ok(findModel(models, 'qwen38-iq3s'));
  assert.ok(findModel(models, 'QWEN38-IQ3S'));
  assert.ok(findModel(models, 'C:\\models\\Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'));
  assert.ok(findModel(models, 'qwen3.8-27b-gsq-rco-iq3_s.gguf'));
  assert.equal(findModel(models, 'nope'), null);
  assert.equal(findModel(models, ''), null);
});

test('config path honours DSH_LLAMA_MANAGER_CONFIG and falls back to the DSH home', () => {
  assert.equal(
    resolveConfigPath({ DSH_LLAMA_MANAGER_CONFIG: 'D:\\x\\y.json' }),
    path.resolve('D:\\x\\y.json'),
  );
  const fallback = resolveConfigPath({ DSH_HOME: 'D:\\home' });
  assert.equal(fallback, path.join('D:\\home', 'llama-model-manager', 'config.json'));
});
