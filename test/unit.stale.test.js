/**
 * Fast, isolated test of the leftover-process attribution logic.
 *
 * The real e2e (scripts/e2e-orphan-recovery.mjs) needs ~90 s to load a 27B
 * model, so the attribution rules are pinned down here with a stand-in process
 * instead. Everything that matters is still real:
 *   - `tasklist` is queried for the recorded pid
 *   - the image name must match the recorded exePath
 *   - the process must actually serve the recorded model on the recorded port
 *   - the kill goes through taskkill /T /F
 *
 * The stand-in is a SEPARATE node process (never this test runner), so killing
 * it can never take the test suite down with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { LlamaModelManager, decodeConsoleOutput } from '../src/core/manager.js';import { Logger } from '../src/core/logger.js';
import { normalizeConfig } from '../src/core/config.js';

const PROJECT = path.resolve(import.meta.dirname, '..');
const silent = new Logger({ level: 'error' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Liveness check for a pid, matching how the manager itself decides.
 *
 * Must NOT match on the English "INFO:" prefix: on a non-English Windows the
 * "no tasks match" message is localized (this machine reports
 * "信息: 没有运行的任务匹配指定标准。"), so prefix matching would silently
 * report every dead pid as alive. The CSV image-name regex is locale-proof.
 */
const isAlive = (pid) => {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = String(r.stdout || '').trim();
  const match = /^"([^"]+)"/.exec(out);
  return !!match && match[1] !== 'INFO:';
};

/**
 * Start a stand-in "llama-server": a node process that reports `modelPath`
 * from /v1/models, exactly like llama-server does ({"models":[...]}).
 * @returns {Promise<{pid: number, port: number, stop: () => void}>}
 */
async function startStandIn(modelPath, port) {
  const serverSrc = `
const http = require('node:http');
const modelPath = process.argv[2];
const port = Number(process.argv[3]);
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [{ name: 'stand-in', path: modelPath }] }));
    return;
  }
  if (req.url.startsWith('/health')) { res.end(JSON.stringify({ status: 'ok' })); return; }
  res.statusCode = 404; res.end('{}');
});
srv.listen(port, '127.0.0.1', () => process.stdout.write('ready\\n'));
setInterval(() => {}, 1000);
`;
  const scriptPath = path.join(os.tmpdir(), `llama-standin-${process.pid}-${port}.cjs`);
  fs.writeFileSync(scriptPath, serverSrc, 'utf8');

  const child = spawn(process.execPath, [scriptPath, modelPath, String(port)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stand-in did not start')), 10000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', reject);
  });
  return { pid: child.pid, port, scriptPath, child };
}

function makeManager(configPath, settings) {
  const config = normalizeConfig({ version: 1, settings, models: {} }).config;
  return new LlamaModelManager({ config, configPath, logger: silent });
}

test('a recorded process that serves the recorded model is attributed and killed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-stale-ok-'));
  const configPath = path.join(tmp, 'config.json');
  const runtimePath = path.join(tmp, 'runtime.json');
  const dataDir = path.join(tmp, 'models');
  fs.mkdirSync(dataDir, { recursive: true });
  const modelPath = path.join(dataDir, 'standin.gguf');
  fs.writeFileSync(modelPath, 'x');

  const stand = await startStandIn(modelPath, 18095);
  try {
    assert.equal(isAlive(stand.pid), true, 'stand-in must be running');

    fs.writeFileSync(runtimePath, JSON.stringify({
      pid: stand.pid,
      modelId: 'standin',
      modelPath,
      port: stand.port,
      // tasklist will report node.exe for this stand-in, so that is what we
      // record as the expected image.
      exePath: 'node.exe',
      startedAt: Date.now(),
      managerPid: process.pid,
    }, null, 2), 'utf8');

    const manager = makeManager(configPath, { llamaServerPath: '', gatewayPort: 18702, internalPort: 18095 });
    const stale = await manager._inspectStaleProcess({ cleanup: true });

    assert.ok(stale, 'the runtime record must be read back');
    assert.equal(stale.attributable, true, 'pid + image + served model all match');
    assert.equal(stale.cleaned, true);

    await sleep(800);
    assert.equal(isAlive(stand.pid), false, 'the attributed process must be gone');
    assert.equal(fs.existsSync(runtimePath), false, 'the record must be cleared after cleanup');
  } finally {
    try { spawnSync('taskkill', ['/PID', String(stand.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(stand.scriptPath, { force: true }); } catch { /* ignore */ }
  }
});

test('a live process that does NOT serve the recorded model is never touched', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-stale-bad-'));
  const configPath = path.join(tmp, 'config.json');
  const runtimePath = path.join(tmp, 'runtime.json');
  const modelPath = path.join(tmp, 'standin.gguf');
  fs.writeFileSync(modelPath, 'x');

  const stand = await startStandIn(modelPath, 18096);
  try {
    fs.writeFileSync(runtimePath, JSON.stringify({
      pid: stand.pid,
      modelId: 'standin',
      // Deliberately wrong: this is what pid reuse by an unrelated server looks like.
      modelPath: path.join(tmp, 'a-totally-different-model.gguf'),
      port: stand.port,
      exePath: 'node.exe',
      startedAt: Date.now(),
      managerPid: process.pid,
    }, null, 2), 'utf8');

    const manager = makeManager(configPath, { llamaServerPath: '', gatewayPort: 18703, internalPort: 18096 });
    const stale = await manager._inspectStaleProcess({ cleanup: true });

    assert.ok(stale);
    assert.equal(stale.attributable, false, 'model mismatch must defeat attribution');
    assert.equal(stale.cleaned, false);
    assert.equal(isAlive(stand.pid), true, 'SAFETY: an unattributable process must survive');
  } finally {
    try { spawnSync('taskkill', ['/PID', String(stand.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(stand.scriptPath, { force: true }); } catch { /* ignore */ }
  }
});

test('a stale record whose pid no longer exists is simply cleared', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-stale-gone-'));
  const configPath = path.join(tmp, 'config.json');
  const runtimePath = path.join(tmp, 'runtime.json');
  try {
    fs.writeFileSync(runtimePath, JSON.stringify({
      pid: 999999,
      modelId: 'gone',
      modelPath: path.join(tmp, 'gone.gguf'),
      port: 18097,
      exePath: 'llama-server.exe',
    }, null, 2), 'utf8');

    const manager = makeManager(configPath, { llamaServerPath: '', gatewayPort: 18704, internalPort: 18097 });
    const stale = await manager._inspectStaleProcess({ cleanup: true });

    assert.equal(stale, null, 'a dead pid yields no stale process');
    assert.equal(fs.existsSync(runtimePath), false, 'the dead record must be cleared');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('PROJECT path is used only to keep the test self-contained', () => {
  assert.equal(fs.existsSync(path.join(PROJECT, 'package.json')), true);
});

test('console output is decoded from the OEM code page, not just utf8', () => {
  // "成功" in GBK/936. Decoded as utf8 this becomes replacement characters,
  // which is exactly what taskkill's Chinese messages looked like before.
  const gbkBytes = Buffer.from([0xb3, 0xc9, 0xb9, 0xa6]);

  const asUtf8 = gbkBytes.toString('utf8');
  assert.ok(asUtf8.includes('\uFFFD'), 'precondition: raw utf8 decoding is lossy here');

  assert.equal(decodeConsoleOutput(gbkBytes), '成功');
  assert.equal(decodeConsoleOutput(Buffer.from('SUCCESS: ok', 'utf8')), 'SUCCESS: ok');
  assert.equal(decodeConsoleOutput('already a string'), 'already a string');
  assert.equal(decodeConsoleOutput(null), '');
  assert.equal(decodeConsoleOutput(undefined), '');
});
