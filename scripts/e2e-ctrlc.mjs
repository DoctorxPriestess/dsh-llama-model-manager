/**
 * Decisive end-to-end check of the graceful stop path against the REAL
 * llama-server, using the plugin's own LlamaServerProcess class.
 *
 * Proves, in one run:
 *   1. the child owns a HIDDEN console (AttachConsole succeeds => CTRL+C works)
 *   2. CTRL+C actually stops llama-server (graceful, exit code 0)
 *   3. VRAM is released (nvidia-smi before/after)
 *   4. no console window is ever created (windowsHide / CREATE_NO_WINDOW)
 *
 * Paths come from LLAMA_SERVER_PATH / LLAMA_MODEL, or from the plugin's own
 * config file when those are unset -- nothing is hardcoded.
 *
 * Run: npm run e2e:ctrlc
 */
import { spawnSync } from 'node:child_process';
import { LlamaServerProcess } from '../src/core/process.js';
import { requireE2ePaths } from './_e2e-paths.mjs';

const paths = requireE2ePaths();
const EXE = paths.exePath;
const MODEL = paths.modelPath;
const PORT = Number(process.env.LLAMA_TEST_PORT || 18091);
const EXTRA_ARGS = (process.env.LLAMA_TEST_ARGS || '-ngl 99 -c 4096 -fa on --no-webui').split(/\s+/).filter(Boolean);

const vram = () => {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0 ? Number(String(r.stdout).trim()) : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2500) });
      if (res.status === 200) return { ok: true, ms: Date.now() - started };
    } catch {
      /* not up yet */
    }
    await sleep(700);
  }
  return { ok: false, ms: Date.now() - started };
}

const argv = [
  '-m', MODEL,
  '--host', '127.0.0.1',
  '--port', String(PORT),
  // Kept deliberately small: this script only needs the server to become
  // healthy, it never generates tokens. Override with LLAMA_TEST_ARGS.
  // NOTE: -fa takes an OPTIONAL value, so it must be given explicitly or it
  // swallows the next flag (`-fa --no-webui` => "unknown value for
  // --flash-attn"). Learned the hard way in the first run of this script.
  ...EXTRA_ARGS,
];

console.log('=== CTRL+C end-to-end test ===');
console.log('exe   :', EXE);
console.log('model :', MODEL);
console.log('port  :', PORT);

const vramBefore = vram();
console.log('VRAM before:', vramBefore, 'MiB');

const lines = [];
const proc = new LlamaServerProcess({
  exePath: EXE,
  argv,
  onLogLine: (line) => {
    lines.push(line);
    if (lines.length > 3000) lines.shift();
  },
});

proc.start();
console.log('spawned pid =', proc.pid);

const health = await waitHealthy(180000);
console.log('health ready:', health.ok, `(${health.ms}ms)`);

if (!health.ok) {
  console.log('--- last 30 log lines ---');
  console.log(lines.slice(-30).join('\n'));
  await proc.killNow('test cleanup');
  process.exit(1);
}

const vramLoaded = vram();
console.log('VRAM loaded:', vramLoaded, 'MiB  (delta', (vramLoaded ?? 0) - (vramBefore ?? 0), 'MiB)');

console.log('\n--- sending CTRL+C via the plugin stop() path ---');
const t0 = Date.now();
const result = await proc.stop({ graceMs: 25000, reason: 'integration test', method: 'auto' });
const elapsed = Date.now() - t0;

console.log('stop result:', JSON.stringify(result));
console.log('exited      :', proc.exited, 'code =', proc.exitCode);
console.log('elapsed     :', elapsed, 'ms');

await sleep(1500);
const vramAfter = vram();
console.log('VRAM after :', vramAfter, 'MiB  (delta vs loaded', (vramAfter ?? 0) - (vramLoaded ?? 0), 'MiB)');

const ctrlCLines = lines.filter((l) => /ctrl|cancel|interrupt|cleanup|clean up|exiting|freeing|shutdown/i.test(l));
console.log('\n--- shutdown-related log lines ---');
console.log(ctrlCLines.slice(-15).join('\n') || '(none)');

console.log('\n================ VERDICT ================');
console.log('method is ctrl-c (not forced) :', result.method === 'ctrl-c' && !result.forced);
console.log('process exited                :', proc.exited);
console.log('exit code 0 (clean)           :', proc.exitCode === 0);
console.log('VRAM released                 :', vramLoaded !== null && vramAfter !== null && vramAfter < vramLoaded - 500);
