/**
 * Unit tests for the serialization gate — spec §12 (switches are serialized),
 * §13 (never stop a server mid-inference) and §20 (request queue cap -> 429).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GateAbortedError, ModelGate, QueueFullError } from '../src/core/gate.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('inference tickets respect maxConcurrentRequests', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 10 });
  const release = await gate.acquireInference();
  assert.equal(gate.inflightCount, 1);

  let secondGranted = false;
  const pending = gate.acquireInference().then((r) => {
    secondGranted = true;
    return r;
  });
  await delay(5);
  assert.equal(secondGranted, false, 'second request must wait while the first is in flight');
  assert.equal(gate.queueLength, 1);

  release();
  const release2 = await pending;
  assert.equal(secondGranted, true);
  release2();
  assert.equal(gate.inflightCount, 0);
});

test('maxConcurrentRequests > 1 allows parallel readers', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 2, maxQueuedRequests: 10 });
  const a = await gate.acquireInference();
  const b = await gate.acquireInference();
  assert.equal(gate.inflightCount, 2);
  let thirdGranted = false;
  const pending = gate.acquireInference().then((r) => { thirdGranted = true; return r; });
  await delay(5);
  assert.equal(thirdGranted, false);
  a(); b();
  const c = await pending;
  c();
});

test('an exclusive ticket waits for in-flight inference to drain', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 10 });
  const release = await gate.acquireInference();

  let exclusiveGranted = false;
  const pending = gate.acquireExclusive().then((r) => { exclusiveGranted = true; return r; });
  await delay(5);
  assert.equal(exclusiveGranted, false, 'switch must not start while a request is in flight');
  assert.equal(gate.queueLength, 1);

  // New readers are blocked behind the pending switch (writer preference):
  let readerGranted = false;
  const readerPending = gate.acquireInference().then((r) => { readerGranted = true; return r; });
  await delay(5);
  assert.equal(readerGranted, false);

  release();
  const releaseExclusive = await pending;
  assert.equal(exclusiveGranted, true);
  assert.equal(gate.exclusiveHeld, true);
  await delay(5);
  assert.equal(readerGranted, false, 'readers stay blocked while the switch runs');

  releaseExclusive();
  const releaseReader = await readerPending;
  assert.equal(readerGranted, true);
  releaseReader();
});

test('forced drain: the exclusive ticket proceeds after the deadline and notifies the caller', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 10 });
  const releaseStuck = await gate.acquireInference();
  let forcedNotified = 0;
  const pending = gate.acquireExclusive({
    drainTimeoutMs: 30,
    onDrainTimeout: () => { forcedNotified += 1; },
  });
  const releaseExclusive = await pending;
  assert.equal(forcedNotified, 1);
  assert.equal(gate.exclusiveHeld, true);

  // Releasing the forced (straggler) reader must NOT release the exclusive ticket.
  releaseStuck();
  assert.equal(gate.exclusiveHeld, true, 'straggler release must not free the switch');
  releaseExclusive();
  assert.equal(gate.exclusiveHeld, false);
});

test('queue overflow rejects with QueueFullError (HTTP 429)', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 2 });
  const release = await gate.acquireInference();
  const w1 = gate.acquireInference();
  const w2 = gate.acquireInference();
  await assert.rejects(() => gate.acquireInference(), (error) => {
    assert.ok(error instanceof QueueFullError);
    assert.equal(error.limit, 2);
    return true;
  });
  release();
  (await w1)();
  (await w2)();
  assert.equal(gate.queueLength, 0);
});

test('queued waiters can be aborted by the client (disconnect while queued)', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 10 });
  const release = await gate.acquireInference();
  const controller = new AbortController();
  const pending = gate.acquireInference({ signal: controller.signal });
  await delay(5);
  assert.equal(gate.queueLength, 1);
  controller.abort();
  await assert.rejects(() => pending, (error) => error instanceof GateAbortedError);
  assert.equal(gate.queueLength, 0);
  release();
});

test('abortAll rejects every waiter and refuse further work', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 10 });
  const release = await gate.acquireInference();
  const pending = gate.acquireInference();
  gate.abortAll('shutdown');
  await assert.rejects(() => pending, (error) => error instanceof GateAbortedError);
  release();
  await assert.rejects(() => gate.acquireInference(), (error) => error instanceof GateAbortedError);
});

test('many alternating switches and requests stay consistent (no ticket leak)', async () => {
  const gate = new ModelGate({ maxConcurrentRequests: 1, maxQueuedRequests: 100 });
  const order = [];
  const tasks = [];
  for (let i = 0; i < 20; i += 1) {
    tasks.push(
      (i % 3 === 1
        ? gate.acquireExclusive().then((release) => {
            order.push(`switch-${i}`);
            return delay(1).then(release);
          })
        : gate.acquireInference().then((release) => {
            order.push(`req-${i}`);
            return delay(1).then(release);
          })),
    );
  }
  await Promise.all(tasks);
  assert.equal(gate.inflightCount, 0);
  assert.equal(gate.exclusiveHeld, false);
  assert.equal(gate.queueLength, 0);
  assert.equal(order.length, 20);
});
