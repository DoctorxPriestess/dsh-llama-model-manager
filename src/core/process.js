/**
 * llama-server child process wrapper.
 *
 * Only processes created here are ever touched (task spec: the plugin must
 * never scan for or kill llama-server processes it does not own).
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINE_LENGTH = 8192;

/** Absolute path of the CTRL+C helper shipped next to this module. */
const CTRL_C_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'send-ctrlc.ps1');

/** Exit code Windows reports when a process dies from `abort()` / __fastfail. */
export const EXIT_CODE_ABORT = 0xc0000409;

/** Resolved PowerShell host, cached so we probe at most once per process. */
let resolvedShell;
/** Shells that failed to spawn with ENOENT; never tried again this run. */
const badShells = new Set();

/**
 * Find a usable PowerShell host.
 *
 * Windows PowerShell (`powershell.exe`) ships with every supported Windows
 * release, so it is the safe default; `pwsh` is preferred when present because
 * it starts faster. Returns null when none is usable, in which case the caller
 * silently falls back to a forced kill.
 *
 * A host that fails to spawn with ENOENT is blacklisted so a model switch never
 * pays for a doomed spawn attempt more than once.
 *
 * @returns {string|null}
 */
function resolveShell() {
  if (resolvedShell !== undefined) return resolvedShell;
  if (process.platform !== 'win32') {
    resolvedShell = null;
    return null;
  }
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh.exe',
    'powershell.exe',
  ];
  for (const candidate of candidates) {
    if (badShells.has(candidate)) continue;
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    resolvedShell = candidate;
    return candidate;
  }
  resolvedShell = null;
  return null;
}

/**
 * Retire a shell that turned out not to exist, and let the next candidate be
 * picked on the following attempt.
 * @param {string} shell
 */
function markShellBad(shell) {
  if (!shell) return;
  badShells.add(shell);
  if (resolvedShell === shell) resolvedShell = undefined;
}

/**
 * Minimal child-process facade so the model manager can be unit-tested with a
 * stub spawner without touching Windows APIs.
 */
export class LlamaServerProcess extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.exePath
   * @param {string[]} options.argv
   * @param {string} [options.cwd]
   * @param {number} [options.maxLogLines]
   * @param {(line: string, stream: 'stdout'|'stderr') => void} [options.onLogLine]
   * @param {typeof spawn} [options.spawnImpl]
   * @param {() => Promise<{ok: boolean, error?: string}>} [options.ctrlCSender]
   *   Override for the CTRL+C delivery mechanism; used by tests so they never
   *   spawn a real PowerShell.
   */
  constructor({
    exePath,
    argv,
    cwd,
    maxLogLines = 400,
    onLogLine = null,
    spawnImpl = spawn,
    ctrlCSender = null,
  }) {
    super();
    this.exePath = exePath;
    this.argv = argv;
    this.cwd = cwd || null;
    this.maxLogLines = maxLogLines;
    this.onLogLine = onLogLine;
    this.spawnImpl = spawnImpl;
    this.ctrlCSender = ctrlCSender;

    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.pid = null;
    this.spawnedAt = null;
    this.exited = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.exitedAt = null;
    this.stopRequested = false;
    this.stopReason = null;
    /** In-flight stop() operation, so concurrent callers join instead of duplicating work. */
    this._stopPromise = null;
    /** @type {string[]} */
    this.stderrLines = [];
    /** @type {string[]} */
    this.stdoutLines = [];
    this._stderrRemainder = '';
    this._stdoutRemainder = '';
    this._exitPromise = null;
  }

  /** Spawn the process. Throws if the process could not be created at all. */
  start() {
    if (this.child) throw new Error('process already started');
    const child = this.spawnImpl(this.exePath, this.argv, {
      cwd: this.cwd || undefined,
      // LOAD-BEARING: windowsHide makes libuv pass CREATE_NO_WINDOW, which
      // gives the child a HIDDEN console. That is what lets stop() deliver a
      // real CTRL+C later without ever showing a window. Do not set
      // `detached: true` here -- DETACHED_PROCESS means NO console at all and
      // CTRL+C delivery becomes impossible (verified, see docs/ENVIRONMENT.md).
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this.pid = child.pid ?? null;
    this.spawnedAt = Date.now();

    this._exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exited = true;
        this.exitCode = code === null || code === undefined ? null : code;
        this.exitSignal = signal ?? null;
        this.exitedAt = Date.now();
        this._flushRemainders();
        this.emit('exit', { code: this.exitCode, signal: this.exitSignal, pid: this.pid });
        resolve({ code: this.exitCode, signal: this.exitSignal });
      });
      child.once('error', (error) => {
        this.emit('error', error);
      });
    });

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._consume('stdout', chunk));
      child.stdout.on('error', () => {});
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this._consume('stderr', chunk));
      child.stderr.on('error', () => {});
    }
    child.on('error', () => {
      // 'exit' may never fire when spawn itself failed; resolve the waiter.
      if (!this.exited) {
        this.exited = true;
        this.exitCode = this.exitCode ?? -1;
        this.exitedAt = Date.now();
        this.emit('exit', { code: this.exitCode, signal: null, pid: this.pid });
        if (this._resolveExit) this._resolveExit({ code: this.exitCode, signal: null });
      }
    });

    return child;
  }

  /** Resolves when the process exits (immediately if it already has). */
  waitForExit() {
    if (this.exited) return Promise.resolve({ code: this.exitCode, signal: this.exitSignal });
    if (this._exitPromise) return this._exitPromise;
    return new Promise((resolve) => {
      this.once('exit', ({ code, signal }) => resolve({ code, signal }));
    });
  }

  /**
   * Stop the process: ask politely first, wait, then force.
   *
   * Windows reality, measured on this machine (see docs/ENVIRONMENT.md §4):
   *
   *   * `child.kill('SIGINT')` is compiled to TerminateProcess() by libuv --
   *     it reports success but the target's SIGINT handler NEVER runs.
   *   * `taskkill /PID x /T` without `/F` cannot terminate a console process:
   *     it answers "This process can only be terminated forcefully".
   *   * The one path that works is a real console control event:
   *     AttachConsole(target) + GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0).
   *     That requires the child to OWN a console, which `windowsHide: true`
   *     provides (CREATE_NO_WINDOW: a hidden console -- no window is ever
   *     shown, so the "no console window" requirement still holds).
   *
   * Order of escalation: CTRL+C -> taskkill /T /F -> handle-based SIGKILL.
   *
   * Concurrency: `stop()` is idempotent and serialized. A second call while a
   * stop is already in flight joins that same operation instead of sending a
   * second CTRL+C / taskkill for the same process.
   *
   * @param {{graceMs?: number, reason?: string, logger?: object, method?: 'ctrl-c'|'taskkill'|'auto'}} [options]
   */
  async stop(options = {}) {
    if (this.exited || !this.pid) return { alreadyExited: true, code: this.exitCode };
    if (this._stopPromise) return this._stopPromise;
    const running = this._stopInternal(options);
    // Store before awaiting so a concurrent caller joins this exact operation.
    this._stopPromise = running;
    try {
      return await running;
    } finally {
      if (this._stopPromise === running) this._stopPromise = null;
    }
  }

  /**
   * @param {{graceMs?: number, reason?: string, logger?: object, method?: 'ctrl-c'|'taskkill'|'auto', forcedWaitMs?: number}} [options]
   */
  async _stopInternal({ graceMs = 10000, reason = 'stop', logger = null, method = 'auto', forcedWaitMs = null } = {}) {
    this.stopRequested = true;
    this.stopReason = reason;

    if (method === 'ctrl-c' || method === 'auto') {
      const ctrl = await this._sendCtrlC();
      if (ctrl.ok) {
        if (logger) logger.debug(`[manager] sent CTRL+C to llama-server pid=${this.pid}, waiting up to ${graceMs}ms`);
        if (await this._raceExit(graceMs)) {
          return {
            forced: false,
            method: 'ctrl-c',
            code: this.exitCode,
            signal: this.exitSignal,
            crashed: this.exitCode === EXIT_CODE_ABORT,
          };
        }
        if (logger) {
          logger.warn(`[manager] llama-server pid=${this.pid} ignored CTRL+C after ${graceMs}ms, forcing exit`);
        }
      } else if (logger) {
        logger.debug(`[manager] CTRL+C unavailable for pid=${this.pid} (${ctrl.error}), using forced termination`);
      }

      // 'ctrl-c' means "never force": report the failure and let the caller decide.
      if (method === 'ctrl-c') {
        return {
          forced: false,
          method: 'ctrl-c',
          delivered: ctrl.ok,
          error: ctrl.ok ? 'CTRL+C delivered but the process did not exit in time' : ctrl.error,
          code: this.exitCode,
          signal: this.exitSignal,
          exited: this.exited,
        };
      }
    }

    if (logger) logger.info(`[manager] forcing llama-server pid=${this.pid} to exit`);
    await this._taskkill(true);
    // Forced termination is TerminateProcess under the hood: fast, but give the
    // OS a generous floor anyway so a slow disk/AV driver cannot make us
    // escalate to the handle-based kill prematurely.
    const forcedWait = forcedWaitMs ?? Math.max(8000, Math.min(graceMs, 20000));
    const forcedExit = await this._raceExit(forcedWait);
    if (!forcedExit) {
      // Last resort. Use the CHILD HANDLE, not the pid: libuv resolves it to
      // the process object we created, so a recycled pid can never make us
      // terminate an unrelated process.
      try {
        this.child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await this._raceExit(5000);
    }
    return {
      forced: true,
      method: 'taskkill',
      code: this.exitCode,
      signal: this.exitSignal,
      exited: this.exited,
    };
  }

  /**
   * Deliver a real CTRL_C_EVENT to the child's (hidden) console.
   *
   * Node has no API for this, so a small PowerShell helper performs the
   * P/Invoke dance. The helper is spawned hidden and never blocks longer than
   * its own timeout.
   *
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  _sendCtrlC() {
    if (this.ctrlCSender) return this.ctrlCSender();
    return new Promise((resolve) => {
      if (!this.pid) return resolve({ ok: false, error: 'no pid' });
      if (process.platform !== 'win32') return resolve({ ok: false, error: 'not windows' });
      const shell = resolveShell();
      if (!shell) return resolve({ ok: false, error: 'powershell not found' });
      if (!fs.existsSync(CTRL_C_HELPER)) return resolve({ ok: false, error: 'helper script missing' });

      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CTRL_C_HELPER, '-TargetPid', String(this.pid)];
      let child;
      try {
        child = spawn(shell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        return resolve({ ok: false, error: error.message });
      }
      let out = '';
      const errOut = [];
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish({ ok: false, error: 'ctrl+c helper timed out' });
      }, 15000);
      if (typeof timer.unref === 'function') timer.unref();

      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { errOut.push(d.toString()); });
      child.on('error', (error) => {
        // A missing interpreter must not be retried on every future stop.
        if (error && error.code === 'ENOENT') markShellBad(shell);
        finish({ ok: false, error: error?.code ? `${error.code}: ${error.message}` : error?.message });
      });
      child.on('close', (code) => {
        if (code === 0) return finish({ ok: true });
        finish({ ok: false, error: (errOut.join('') || out || `helper exit ${code}`).trim().slice(0, 300) });
      });
    });
  }

  /** Kill immediately (used on plugin shutdown as a last resort). */
  async killNow(reason = 'kill') {
    if (this.exited || !this.pid) return { alreadyExited: true, code: this.exitCode };
    this.stopRequested = true;
    this.stopReason = reason;
    await this._taskkill(true);
    if (!(await this._raceExit(5000))) {
      // Fall back to the child handle (immune to pid recycling).
      try {
        this.child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await this._raceExit(2000);
    }
    return { forced: true, method: 'taskkill', code: this.exitCode, signal: this.exitSignal, exited: this.exited };
  }

  _taskkill(force) {
    return new Promise((resolve) => {
      if (!this.pid) return resolve({ ok: false, error: 'no pid' });
      const args = ['/PID', String(this.pid), '/T'];
      if (force) args.push('/F');
      let child;
      try {
        child = spawn('taskkill', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        return resolve({ ok: false, error: error.message });
      }
      let out = '';
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { out += d.toString(); });
      child.on('error', (error) => resolve({ ok: false, error: error.message }));
      child.on('close', (code) => resolve({ ok: code === 0, code, output: out.trim() }));
    });
  }

  async _raceExit(ms) {
    if (this.exited) return true;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const result = await Promise.race([this.waitForExit().then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  _consume(stream, chunk) {
    const key = stream === 'stderr' ? '_stderrRemainder' : '_stdoutRemainder';
    const lines = stream === 'stderr' ? this.stderrLines : this.stdoutLines;
    const text = this[key] + chunk;
    const parts = text.split(/\r?\n/);
    this[key] = parts.pop() ?? '';
    for (const part of parts) this._recordLine(stream, lines, part);
  }

  _flushRemainders() {
    if (this._stderrRemainder) {
      this._recordLine('stderr', this.stderrLines, this._stderrRemainder);
      this._stderrRemainder = '';
    }
    if (this._stdoutRemainder) {
      this._recordLine('stdout', this.stdoutLines, this._stdoutRemainder);
      this._stdoutRemainder = '';
    }
  }

  _recordLine(stream, lines, line) {
    const trimmed = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…[truncated]` : line;
    lines.push(trimmed);
    if (lines.length > this.maxLogLines) lines.splice(0, lines.length - this.maxLogLines);
    if (this.onLogLine) {
      try {
        this.onLogLine(trimmed, stream);
      } catch {
        /* logging must never break the manager */
      }
    }
  }

  /** Last `count` stderr lines (task spec: report 30-100 lines on failure). */
  tail(count = 40) {
    return this.stderrLines.slice(-count);
  }
}

/** True when a path points at an existing file (never a directory). */
export function isExistingFile(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
