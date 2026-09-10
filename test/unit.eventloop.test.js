/**
 * Event-loop liveness regression test.
 *
 * A timer whose firing is the ONLY way an awaited promise can settle must not
 * be `unref()`d. `unref()` means "do not let this timer keep the process
 * alive", which is right for optional background housekeeping but wrong for a
 * real deadline: the loop drains first, the deadline is dropped, and the
 * awaiting code hangs or the process exits with code 13 (unsettled top-level
 * await). Under `node --test` the same defect surfaces as
 *
 *   Promise resolution is still pending but the event loop has already resolved
 *   failureType: 'cancelledByParent'
 *
 * which is how it reached CI: it failed on Node 20 and 22, while Node 24's
 * runner happened to hold the loop open long enough to hide it.
 *
 * The check runs in a CHILD process on purpose. In-process it cannot be tested:
 * the test runner and the rest of the suite keep the loop alive, which is
 * exactly the accident that masks the bug. The child does nothing but await the
 * two deadlines, so nothing else can rescue them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/eventloop-child.mjs', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * `unref()` calls in src/ that are known to be optional housekeeping rather
 * than deadlines an awaited promise depends on. Add here (with a reason) only
 * after confirming that nothing awaits the timer's firing.
 */
const ALLOWED_UNREF = [];

/** Run the fixture and collect its exit code and output. */
function runChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('deadlines that settle an awaited promise still fire when nothing else keeps the loop alive', async () => {
  const { code, signal, stdout, stderr } = await runChild();
  const detail = `exit=${code} signal=${signal}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;

  // Exit 13 is Node's "unsettled top-level await": the deadline never fired.
  assert.equal(code, 0, `child did not finish cleanly (13 = lost deadline)\n${detail}`);
  assert.match(stdout, /^MARK gate-drain-deadline$/m, `gate drain deadline never fired\n${detail}`);
  assert.match(stdout, /^MARK race-exit-timeout-fired$/m, `_raceExit deadline never fired\n${detail}`);
  assert.match(stdout, /^MARK done$/m, `child did not reach the end\n${detail}`);
});

test('src/ contains no unref() outside the reviewed allowlist', () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}${entry.name}`;
      if (entry.isDirectory()) {
        walk(`${full}/`);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      readFileSync(full, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (/\.unref\(\)/.test(line)) found.push(`${entry.name}:${index + 1}`);
        });
    }
  };
  walk(SRC_DIR);

  const unexpected = found.filter((site) => !ALLOWED_UNREF.includes(site));
  assert.deepEqual(
    unexpected,
    [],
    'unref() is only safe for timers that nothing awaits; if this one is genuinely ' +
      `optional housekeeping, add it to ALLOWED_UNREF with a reason:\n${unexpected.join('\n')}`,
  );
});
