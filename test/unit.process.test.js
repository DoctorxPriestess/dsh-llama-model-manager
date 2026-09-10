/**
 * Stop-escalation tests for LlamaServerProcess.
 *
 * These lock in the Windows stop semantics measured on the target machine
 * (docs/ENVIRONMENT.md §4): CTRL+C first, `taskkill /T /F` second, and never
 * claim "graceful" when the process was actually killed or had crashed.
 *
 * The CTRL+C transport is injected so no real PowerShell is ever spawned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LlamaServerProcess, EXIT_CODE_ABORT } from '../src/core/process.js';

/**
 * Fake child process that records taskkill invocations and can be made to exit
 * on demand.
 */
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
    this.killed = [];
  }

  /** Simulate the process exiting after `delayMs`. */
  exitAfter(delayMs, code = 0, signal = null) {
    this._timer = setTimeout(() => {
      this.emit('exit', code, signal);
    }, delayMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }
}

/**
 * Build a process wrapper whose spawner and taskkill are fully faked.
 * @param {{ctrlC?: {ok: boolean, error?: string}, exitOnCtrlC?: number|null, exitOnForced?: number|null, taskkillOutput?: string}} opts
 */
function makeProc(opts = {}) {
  const child = new FakeChild(4242);
  const taskkillCalls = [];
  let ctrlCSent = 0;

  const proc = new LlamaServerProcess({
    exePath: 'C:\\fake\\llama-server.exe',
    argv: ['-m', 'model.gguf'],
    spawnImpl: () => child,
    ctrlCSender: async () => {
      ctrlCSent += 1;
      if (opts.ctrlC?.ok && opts.exitOnCtrlC !== null && opts.exitOnCtrlC !== undefined) {
        child.exitAfter(opts.exitOnCtrlC, 0);
      }
      return opts.ctrlC ?? { ok: true };
    },
  });
  proc.start();

  // Replace the taskkill helper with a recording stub. By default a forced
  // kill makes the fake child exit, so tests never reach the last-resort
  // `process.kill(pid)` path -- which would target a REAL pid on this machine.
  const forcedExitDelay = opts.exitOnForced === undefined ? 10 : opts.exitOnForced;
  proc._taskkill = async (force) => {
    taskkillCalls.push(force);
    if (force && forcedExitDelay !== null) {
      child.exitAfter(forcedExitDelay, 1);
    }
    return { ok: true, code: 0, output: opts.taskkillOutput ?? '' };
  };

  return { proc, child, taskkillCalls, ctrlCSent: () => ctrlCSent };
}

test('CTRL+C stops the process and is reported as graceful', async () => {
  const { proc, taskkillCalls, ctrlCSent } = makeProc({ ctrlC: { ok: true }, exitOnCtrlC: 20 });
  const result = await proc.stop({ graceMs: 3000, method: 'auto' });

  assert.equal(ctrlCSent(), 1, 'CTRL+C must be attempted first');
  assert.equal(result.method, 'ctrl-c');
  assert.equal(result.forced, false);
  assert.equal(proc.exited, true);
  assert.equal(proc.exitCode, 0);
  assert.deepEqual(taskkillCalls, [], 'no forced kill must happen after a clean CTRL+C exit');
});

test('a CTRL+C that is ignored escalates to a forced kill', async () => {
  const { proc, taskkillCalls } = makeProc({ ctrlC: { ok: true }, exitOnCtrlC: null, exitOnForced: 10 });
  const result = await proc.stop({ graceMs: 150, method: 'auto' });

  assert.equal(result.method, 'taskkill');
  assert.equal(result.forced, true);
  assert.deepEqual(taskkillCalls, [true], 'exactly one forced taskkill');
});

test('an undeliverable CTRL+C goes straight to the forced kill', async () => {
  const { proc, taskkillCalls, ctrlCSent } = makeProc({
    ctrlC: { ok: false, error: 'AttachConsole failed' },
    exitOnForced: 10,
  });
  const result = await proc.stop({ graceMs: 5000, method: 'auto' });

  assert.equal(ctrlCSent(), 1, 'we still try once');
  assert.equal(result.method, 'taskkill');
  assert.equal(result.forced, true);
  assert.deepEqual(taskkillCalls, [true]);
});

test("method 'taskkill' never attempts CTRL+C", async () => {
  const { proc, taskkillCalls, ctrlCSent } = makeProc({ ctrlC: { ok: true }, exitOnForced: 10 });
  const result = await proc.stop({ graceMs: 3000, method: 'taskkill' });

  assert.equal(ctrlCSent(), 0, 'CTRL+C must be skipped entirely');
  assert.equal(result.method, 'taskkill');
  assert.deepEqual(taskkillCalls, [true]);
});

test("method 'ctrl-c' does not silently fall back when it cannot be delivered", async () => {
  const { proc, taskkillCalls, ctrlCSent } = makeProc({
    ctrlC: { ok: false, error: 'no console' },
    exitOnForced: 10,
  });
  const result = await proc.stop({ graceMs: 3000, method: 'ctrl-c' });

  assert.equal(ctrlCSent(), 1);
  assert.deepEqual(taskkillCalls, [], "'ctrl-c' must not force-kill");
  assert.equal(proc.exited, false, 'process is still running, caller must decide');
  assert.equal(result.method, 'ctrl-c');
  assert.equal(result.forced, false);
  assert.equal(result.delivered, false, 'delivery failure must be reported');
  assert.equal(result.error, 'no console');
});

test("method 'ctrl-c' reports a non-exit even when delivery succeeded", async () => {
  const { proc, taskkillCalls } = makeProc({ ctrlC: { ok: true }, exitOnCtrlC: null });
  const result = await proc.stop({ graceMs: 120, method: 'ctrl-c' });

  assert.deepEqual(taskkillCalls, [], "'ctrl-c' must never escalate on its own");
  assert.equal(result.forced, false);
  assert.equal(result.delivered, true);
  assert.match(result.error, /did not exit/);
  assert.equal(result.exited, false);
});

test('a crashed exit (0xC0000409) is surfaced as crashed, not graceful', async () => {
  const { proc, child } = makeProc({ ctrlC: { ok: true }, exitOnCtrlC: null });
  // Simulate the abort() crash observed on this machine.
  setTimeout(() => child.emit('exit', EXIT_CODE_ABORT, null), 20);

  const result = await proc.stop({ graceMs: 2000, method: 'auto' });
  assert.equal(result.crashed, true, 'abort exit code must be flagged');
  assert.equal(proc.exitCode, EXIT_CODE_ABORT);
});

test('stop on an already-exited process is a no-op', async () => {
  const { proc, child, taskkillCalls } = makeProc({});
  child.emit('exit', 0, null);
  await new Promise((r) => setTimeout(r, 5));

  const result = await proc.stop({ graceMs: 500, method: 'auto' });
  assert.equal(result.alreadyExited, true);
  assert.deepEqual(taskkillCalls, []);
});

test('killNow skips CTRL+C and forces immediately', async () => {
  const { proc, taskkillCalls, ctrlCSent } = makeProc({ ctrlC: { ok: true }, exitOnForced: 10 });
  await proc.killNow('test');
  assert.equal(ctrlCSent(), 0);
  assert.deepEqual(taskkillCalls, [true]);
});

test('concurrent stop() calls are serialized into a single operation', async () => {
  const { proc, taskkillCalls, ctrlCSent } = makeProc({ ctrlC: { ok: true }, exitOnCtrlC: 40 });

  // Two callers race, exactly like shutdown() + a model switch would.
  const [a, b] = await Promise.all([
    proc.stop({ graceMs: 3000, method: 'auto' }),
    proc.stop({ graceMs: 3000, method: 'auto' }),
  ]);

  assert.equal(ctrlCSent(), 1, 'CTRL+C must be sent exactly once');
  assert.deepEqual(taskkillCalls, [], 'no forced kill after a clean exit');
  assert.equal(a.method, 'ctrl-c');
  assert.equal(b.method, 'ctrl-c');
  assert.equal(proc.exited, true);
});

test('stop() can be called again after it completed', async () => {
  const { proc } = makeProc({ ctrlC: { ok: true }, exitOnCtrlC: 10 });
  const first = await proc.stop({ graceMs: 1000, method: 'auto' });
  assert.equal(first.method, 'ctrl-c');
  const second = await proc.stop({ graceMs: 1000, method: 'auto' });
  assert.equal(second.alreadyExited, true, 'second call is a no-op, not a second kill');
});

test('the last-resort kill uses the child handle, never a bare pid', async () => {
  // A forced kill that does not actually terminate anything forces the code
  // down its final fallback path. If that path used process.kill(pid) it would
  // target a REAL process on this machine, so we assert on the handle instead.
  const { proc, child, taskkillCalls } = makeProc({
    ctrlC: { ok: false, error: 'no console' },
    exitOnForced: null, // taskkill never works
  });
  const handleKills = [];
  child.kill = (signal) => {
    handleKills.push(signal);
    child.emit('exit', null, signal);
    return true;
  };
  let barePidKillAttempted = false;
  const originalKill = process.kill;
  process.kill = (...args) => {
    barePidKillAttempted = true;
    return originalKill.apply(process, args);
  };
  try {
    await proc.stop({ graceMs: 20, forcedWaitMs: 30, method: 'auto' });
  } finally {
    process.kill = originalKill;
  }

  assert.deepEqual(taskkillCalls, [true], 'taskkill was still attempted first');
  assert.deepEqual(handleKills, ['SIGKILL'], 'fallback must go through the child handle');
  assert.equal(barePidKillAttempted, false, 'must never call process.kill(pid) -- pid recycling hazard');
});
