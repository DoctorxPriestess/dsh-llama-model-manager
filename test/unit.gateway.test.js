/**
 * Gateway proxy tests.
 *
 * The gateway had no automated coverage at all, and two of the reviewed defects
 * are "permanent until the plugin restarts" class, so they get real HTTP tests
 * here rather than mocks-of-mocks:
 *
 *   1. A client that disconnects while its request is queued must not leak its
 *      shared inference ticket. With the default maxConcurrentRequests: 1 a
 *      leaked ticket means no request can EVER be granted again.
 *   2. `fetch` decodes gzip/deflate/br transparently but keeps
 *      `content-encoding` and the original `content-length` in the response
 *      headers. Forwarding those verbatim hands the client a body described as
 *      "40 bytes, gzip" while it is actually 5000 plaintext bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { Gateway } from '../src/core/gateway.js';
import { Logger } from '../src/core/logger.js';
import { normalizeConfig } from '../src/core/config.js';

const silent = new Logger({ level: 'error' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal manager stand-in: only what the proxy path touches. */
function makeManager(overrides = {}) {
  const settings = normalizeConfig({ version: 1, models: {} }).config.settings;
  return {
    config: { settings },
    current: null,
    stats: { requests: 0, lastRequestAt: 0 },
    status: () => ({ currentModel: 'm1' }),
    trackInflight: () => () => {},
    acquireForRequest: async () => ({ model: { id: 'm1' }, release: () => {} }),
    fetchImpl: globalThis.fetch,
    ...overrides,
  };
}

async function startGateway(manager) {
  const gateway = new Gateway({ manager, logger: silent, host: '127.0.0.1', port: 0 });
  await gateway.listen();
  const port = gateway.server.address().port;
  return { gateway, port, url: `http://127.0.0.1:${port}` };
}

test('a compressed upstream response is forwarded intact and correctly labelled', async () => {
  // A realistic payload: big enough that a truncated body is unmistakable.
  const payload = JSON.stringify({ text: 'x'.repeat(5000) });
  const gzipped = zlib.gzipSync(payload);
  let upstreamAcceptEncoding = null;

  const upstream = http.createServer((req, res) => {
    upstreamAcceptEncoding = req.headers['accept-encoding'] ?? null;
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(gzipped.length),
    });
    res.end(gzipped);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const manager = makeManager({ current: { connectHost: '127.0.0.1', port: upstreamPort } });
  const { gateway, url } = await startGateway(manager);

  try {
    const response = await fetch(`${url}/echo`);
    assert.equal(response.status, 200);

    // The body must survive byte-for-byte.
    const text = await response.text();
    assert.equal(text, payload, 'the proxied body must be the decoded payload, not the gzip bytes');
    assert.deepEqual(JSON.parse(text), JSON.parse(payload));

    // ... and must not be described as compressed, or the client tries to
    // gunzip plaintext (verified to fail with Z_DATA_ERROR).
    assert.equal(response.headers.get('content-encoding'), null, 'content-encoding must not be forwarded');
    const length = response.headers.get('content-length');
    if (length !== null) {
      assert.equal(Number(length), Buffer.byteLength(payload), 'content-length must match what we actually send');
    }

    // We ask for an uncompressed response so we never have to reconcile
    // "decoded body + compressed headers" in the first place.
    assert.equal(upstreamAcceptEncoding, 'identity', 'the upstream request must ask for identity encoding');
  } finally {
    await gateway.close();
    await new Promise((r) => upstream.close(r));
  }
});

test('a client that disconnects while queued does not leak its gate ticket', async () => {
  // Reproduce the exact race: the ticket is granted AFTER the client is already
  // gone. A never-ending upstream body is what makes the old code hang forever
  // (piping into a destroyed response never emits 'close' or 'finish' again), so
  // the `finally { release() }` never ran and the ticket leaked for good.
  let releaseCalled = 0;
  const release = () => {
    releaseCalled += 1;
  };
  const neverEnding = new ReadableStream({
    start() {
      /* never enqueues, never closes */
    },
  });

  const manager = makeManager({
    current: { connectHost: '127.0.0.1', port: 1 },
    fetchImpl: async () => new Response(neverEnding, { status: 200 }),
    acquireForRequest: async () => {
      // Simulates waiting behind a 40-50 s model load, then winning the ticket
      // only after the caller has already hung up.
      await sleep(150);
      return { model: { id: 'm1' }, release };
    },
  });

  const { gateway, port } = await startGateway(manager);

  try {
    await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/echo', method: 'GET' },
        () => resolve(),
      );
      req.on('error', () => resolve()); // ECONNRESET after we destroy it
      req.end();
      // Hang up while the acquire is still pending.
      setTimeout(() => req.destroy(), 30);
    });

    // Give the acquire() time to resolve with the client already gone.
    await sleep(400);

    assert.equal(releaseCalled, 1, 'the ticket must be handed back exactly once, not leaked');
  } finally {
    await gateway.close();
  }
});
