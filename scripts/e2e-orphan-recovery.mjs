/**
 * End-to-end check of the leftover-process safety net.
 *
 * Why this matters: on Windows a dying parent does NOT take its children with
 * it. If DSH dies while a model is loaded, llama-server survives as an orphan
 * holding ~12 GB of VRAM and the port, so the next start fails. The manager
 * keeps a runtime.json record and cleans that up -- but only after positively
 * attributing the process to itself.
 *
 * This script verifies BOTH halves:
 *   1. SAFETY   -- a live llama-server whose served model does NOT match the
 *                  record (i.e. what pid reuse would look like) is left alone.
 *   2. CLEANUP  -- once attribution succeeds, the orphan is really killed.
 *
 * Run: npm run e2e:orphan
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { LlamaModelManager } from '../src/core/manager.js';
import { Logger } from '../src/core/logger.js';
import { normalizeConfig } from '../src/core/config.js';
import { requireE2ePaths } from './_e2e-paths.mjs';

const paths = requireE2ePaths();
const EXE = paths.exePath;
const MODEL = paths.modelPath;
const PORT = Number(process.env.LLAMA_TEST_PORT || 18093);
const EXTRA_ARGS = (process.env.LLAMA_TEST_ARGS || '-ngl 99 -c 4096 -fa on --no-webui').split(/\s+/).filter(Boolean);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-orphan-'));
const configPath = path.join(tmpDir, 'config.json');
const runtimePath = path.join(tmpDir, 'runtime.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Liveness check mirroring the manager's own rule.
 *
 * Do NOT match the English "INFO:" prefix: this machine's Windows is Chinese,
 * so the "no tasks match" line is localized and prefix matching would report
 * every dead pid as alive. The CSV image-name regex is locale-proof.
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

const vram = () => {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0 ? Number(String(r.stdout).trim()) : null;
};

const silent = new Logger({ level: 'error' });
const seen = [];
const capture = new Logger({
  level: 'debug',
  sink: (level, line) => {
    seen.push(`${level} ${line}`);
  },
});

const config = normalizeConfig({
  version: 1,
  settings: {
    llamaServerPath: EXE,
    gatewayHost: '127.0.0.1',
    gatewayPort: 18701,
    internalPort: PORT,
    startupTimeoutMs: 180000,
    shutdownTimeoutMs: 30000,
    healthCheckIntervalMs: 500,
  },
  models: {
    'orphan-test': {
      modelPath: MODEL,
      arguments: EXTRA_ARGS.join(' '),
    },
  },
}).config;

console.log('=== orphan recovery e2e ===');
console.log('config   :', configPath);
console.log('runtime  :', runtimePath);
console.log('port     :', PORT);

// ── 1. Start a model, exactly like a running DSH would ────────────────────
const managerA = new LlamaModelManager({ config, configPath, logger: silent });
await managerA.load('orphan-test', { reason: 'orphan e2e' });
const childPid = managerA.current?.proc?.pid;
console.log('\n[1] loaded, pid =', childPid, 'state =', managerA.state);
console.log('    runtime.json exists :', fs.existsSync(runtimePath));
console.log('    recorded            :', fs.readFileSync(runtimePath, 'utf8').replace(/\s+/g, ' '));
const vramLoaded = vram();
console.log('    VRAM                :', vramLoaded, 'MiB');

if (!childPid || !isAlive(childPid)) {
  console.log('FATAL: child did not start');
  await managerA.shutdown({ reason: 'fatal' });
  process.exit(1);
}

// ── 2. SAFETY: simulate pid reuse by an UNRELATED llama-server ────────────
// Same pid, same image, same port -- but it is not serving our recorded model.
const real = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
const bogus = { ...real, modelPath: 'D:\\somewhere\\else\\not-our-model.gguf' };
fs.writeFileSync(runtimePath, JSON.stringify(bogus, null, 2), 'utf8');

const managerB = new LlamaModelManager({ config, configPath, logger: capture });
const staleB = await managerB._inspectStaleProcess({ cleanup: true });

console.log('\n[2] SAFETY -- record points at a model this process does NOT serve');
console.log('    recorded pid alive  :', isAlive(childPid));
console.log('    attributable        :', staleB?.attributable);
console.log('    cleaned             :', staleB?.cleaned ?? false);
const survivedBogusRecord = isAlive(childPid);
console.log('    process still alive :', survivedBogusRecord);
console.log('    reason logged       :', seen.filter((l) => /无法确认|不会对它/.test(l)).slice(-1)[0] || '(none)');

// ── 3. CLEANUP: restore the truthful record, it must now be killed ────────
fs.writeFileSync(runtimePath, JSON.stringify(real, null, 2), 'utf8');
const managerC = new LlamaModelManager({ config, configPath, logger: capture });
const staleC = await managerC._inspectStaleProcess({ cleanup: true });

await sleep(2500);
const aliveAfterCleanup = isAlive(childPid);
const vramAfter = vram();

console.log('\n[3] CLEANUP -- truthful record');
console.log('    attributable        :', staleC?.attributable);
console.log('    cleaned             :', staleC?.cleaned ?? false);
console.log('    cleanup note        :', staleC?.cleanupNote ?? '(none)');
console.log('    process alive after :', aliveAfterCleanup);
console.log('    VRAM after          :', vramAfter, 'MiB');
if (aliveAfterCleanup) {
  // Second look: distinguishes "never died" from "died but not yet reaped".
  await sleep(2000);
  console.log('    alive after +2s     :', isAlive(childPid));
}

// ── verdict ───────────────────────────────────────────────────────────────
const safetyOk = staleB?.attributable === false && survivedBogusRecord;
const cleanupOk = staleC?.attributable === true && !aliveAfterCleanup;
const vramOk = vramLoaded !== null && vramAfter !== null && vramAfter < vramLoaded - 500;

console.log('\n================ VERDICT ================');
console.log('refused to kill an unattributable pid :', safetyOk);
console.log('killed the attributable orphan        :', cleanupOk);
console.log('VRAM released                         :', vramOk);

// tidy up: if anything survived, stop it through the normal path
try {
  await managerA.shutdown({ reason: 'e2e cleanup' });
} catch {
  /* ignore */
}
if (isAlive(childPid)) {
  spawnSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true });
}
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(safetyOk && cleanupOk && vramOk ? 0 : 1);
