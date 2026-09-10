/**
 * Stop-outcome contract between LlamaModelManager and LlamaServerProcess.
 *
 * Regression cover for a HIGH-severity bug: `_stopCurrent` ignored
 * `result.exited`. With `stopMethod: 'ctrl-c'` (a documented, settings-page
 * selectable option) `stop()` deliberately NEVER forces, so it can return
 * `{exited: false}` while llama-server is still running. The manager treated
 * that as a successful stop anyway: it nulled `current`, deleted
 * `runtime.json`, and reported STOPPED. That left a ~12 GB process running
 * while destroying the only record the startup cleanup could have used --
 * and it also blinded the exit handler in index.js, which reaches the child
 * through `manager.current`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LlamaModelManager, STATE } from '../src/core/manager.js';
import { Logger } from '../src/core/logger.js';
import { normalizeConfig } from '../src/core/config.js';

const silent = new Logger({ level: 'error' });

function makeManager(configPath, settings = {}) {
  const config = normalizeConfig({
    version: 1,
    settings: { stopMethod: 'ctrl-c', ...settings },
    models: { m1: { id: 'm1', modelPath: 'C:\\models\\m1.gguf' } },
  }).config;
  return new LlamaModelManager({ config, configPath, logger: silent });
}

/**
 * Stand-in process wrapper. `exits: false` reproduces exactly what
 * `stopMethod: 'ctrl-c'` returns when CTRL+C is delivered but ignored.
 */
function fakeProc({ exits }) {
  const proc = {
    pid: 4242,
    exited: false,
    exitCode: null,
    async stop() {
      if (exits) {
        proc.exited = true;
        proc.exitCode = 0;
        return { forced: false, method: 'ctrl-c', exited: true, code: 0 };
      }
      return {
        forced: false,
        method: 'ctrl-c',
        delivered: true,
        exited: false,
        error: 'CTRL+C delivered but the process did not exit in time',
      };
    },
    async killNow() {
      proc.exited = true;
      proc.exitCode = 1;
      return { forced: true, method: 'taskkill', exited: true };
    },
  };
  return proc;
}

function setup(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-stop-'));
  const configPath = path.join(dir, 'config.json');
  const runtimePath = path.join(dir, 'runtime.json');
  const manager = makeManager(configPath, settings);
  const proc = fakeProc(settings._exits ?? { exits: true });
  manager.current = {
    model: { id: 'm1', modelPath: 'C:\\models\\m1.gguf' },
    port: 18080,
    startedAt: Date.now(),
    proc,
  };
  manager._writeRuntimeState();
  return { dir, configPath, runtimePath, manager, proc };
}

test('a stop that did not end the process must NOT be reported as stopped', async () => {
  const { dir, runtimePath, manager, proc } = setup({ _exits: { exits: false } });
  try {
    assert.equal(fs.existsSync(runtimePath), true, 'precondition: the runtime record exists');

    await assert.rejects(
      () => manager._stopCurrent({ reason: 'unload' }),
      (error) => {
        assert.equal(error.code, 'STOP_FAILED');
        assert.match(error.message, /无法结束 llama-server/);
        return true;
      },
      'claiming success here is what orphaned the process',
    );

    // The three things that make the process recoverable must all survive.
    assert.equal(proc.exited, false);
    assert.notEqual(manager.current, null, 'current must stay set so index.js can still reach the child handle');
    assert.equal(manager.current.proc, proc);
    assert.equal(fs.existsSync(runtimePath), true, 'runtime.json must survive so the next startup can find the process');
    assert.equal(manager.state, STATE.ERROR, 'the state must not claim STOPPED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stop that really ended the process clears everything as before', async () => {
  const { dir, runtimePath, manager } = setup({ _exits: { exits: true } });
  try {
    const result = await manager._stopCurrent({ reason: 'unload' });

    assert.equal(result.stopped, true);
    assert.equal(manager.current, null);
    assert.equal(fs.existsSync(runtimePath), false, 'a confirmed stop removes the record');
    assert.equal(manager.state, STATE.STOPPED);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no current model is still a no-op', async () => {
  const { dir, manager } = setup({ _exits: { exits: true } });
  try {
    manager.current = null;
    const result = await manager._stopCurrent({ reason: 'unload' });
    assert.equal(result.stopped, false);
    assert.equal(manager.state, STATE.STOPPED);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown escalates to a forced kill, but never claims success while it is alive', async () => {
  const { dir, runtimePath, manager, proc } = setup({ _exits: { exits: false } });
  try {
    await manager.shutdown({ reason: 'test' });

    // We are leaving, so an orphan is worse than a forced kill: it escalates.
    assert.equal(proc.exited, true, 'shutdown must force the process down');
    assert.equal(manager.current, null);
    assert.equal(fs.existsSync(runtimePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown keeps the record when even the forced kill fails', async () => {
  const { dir, runtimePath, manager, proc } = setup({ _exits: { exits: false } });
  try {
    proc.killNow = async () => ({ forced: true, exited: false });

    await manager.shutdown({ reason: 'test' });

    assert.equal(proc.exited, false);
    assert.notEqual(manager.current, null, 'keep the entry so the exit handler can still reach it');
    assert.equal(fs.existsSync(runtimePath), true, 'keep the record so the next startup can clean up');
    assert.equal(manager.state, STATE.ERROR);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
