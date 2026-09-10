/**
 * Child process for test/unit.eventloop.test.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * A timer that is `unref()`d stops keeping the event loop alive. If that timer
 * is the ONLY thing that can settle a promise somebody is awaiting, the loop
 * drains first and the wait is silently lost: top-level await never returns and
 * the process exits with code 13 ("unsettled top-level await"). Under
 * `node --test` the very same defect is reported as
 *
 *   Promise resolution is still pending but the event loop has already resolved
 *   failureType: 'cancelledByParent'
 *
 * which is what made CI fail on Node 20 and 22 while passing on Node 24 (the
 * newer runner happens to keep the loop alive long enough to hide it).
 *
 * So this script deliberately does NOTHING else: no servers, no sockets, no
 * in-flight requests, no `process.exit()`. Every await below can only be
 * settled by the deadline under test, which is exactly the condition the test
 * runner was accidentally masking. It must reach "MARK done" and exit 0.
 */
import { EventEmitter } from 'node:events';
import { ModelGate } from '../../src/core/gate.js';
import { LlamaServerProcess } from '../../src/core/process.js';

const mark = (name) => process.stdout.write(`MARK ${name}\n`);

/** Minimal stand-in for a spawned llama-server that never exits on its own. */
class SilentChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 987654; // never a real pid: nothing may actually be signalled
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
  }

  kill() {
    /* deliberately inert */
  }
}

// ---------------------------------------------------------------------------
// Case 1 -- ModelGate drain deadline (test/unit.gate.test.js "forced drain").
// An exclusive waiter is queued behind a reader that never releases. The only
// thing that can grant it is the drain deadline started in gate._drain().
// ---------------------------------------------------------------------------
{
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 10 });
  const releaseStuck = await gate.acquireInference();
  let notified = 0;
  const releaseExclusive = await gate.acquireExclusive({
    drainTimeoutMs: 30,
    onDrainTimeout: () => {
      notified += 1;
    },
  });
  if (notified !== 1) throw new Error(`drain hook fired ${notified} times, expected 1`);
  mark('gate-drain-deadline');
  releaseExclusive();
  releaseStuck();
}

// ---------------------------------------------------------------------------
// Case 2 -- LlamaServerProcess._raceExit deadline. The child never exits, so
// the timeout arm of the race is the only settler.
// ---------------------------------------------------------------------------
{
  const proc = new LlamaServerProcess({
    exePath: 'C:\\fake\\llama-server.exe',
    argv: ['-m', 'model.gguf'],
    spawnImpl: () => new SilentChild(),
    ctrlCSender: async () => ({ ok: true }),
  });
  proc.start();
  const exited = await proc._raceExit(30);
  if (exited !== false) throw new Error(`_raceExit returned ${exited}, expected false`);
  mark('race-exit-timeout-fired');
}

mark('done');
// No process.exit(): let the loop drain naturally so a lost deadline still
// shows up as exit code 13 instead of being masked.
