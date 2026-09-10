# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Lost deadlines under `unref()`.** A timer whose firing is the only way an
  awaited promise can settle must not be `unref()`d: with nothing else holding
  the event loop, Node drains the loop first, the deadline never fires, and the
  wait is dropped (exit code 13 / `unsettled top-level await`; under
  `node --test`, `Promise resolution is still pending but the event loop has
  already resolved` / `cancelledByParent`). This is what made CI fail on Node 20
  and 22 while passing on 24 — the newer runner happened to hold the loop open
  and mask it. Affected deadlines: the gate's drain timer, `_raceExit`,
  `_sendCtrlC`'s helper timeout, the gateway proxy timeout, the port probe (which
  was also missing its `clearTimeout`), and the `FakeChild` test helper.
  Regression-tested in a **child process** so the runner cannot mask it again
  (`test/unit.eventloop.test.js`).
- `test/unit.stale.test.js` used `import.meta.dirname`, which requires Node
  20.11+, while the package declares a `>=20.10` floor. Replaced with
  `fileURLToPath(new URL('..', import.meta.url))`.

## [1.0.0] — 2026-09-11

Initial release.

### Added

- **Model lifecycle management** for `llama-server.exe` on Windows: load, unload,
  switch, restart, with a bounded retry and a crash lock that prevents endless
  restart loops.
- **OpenAI-compatible gateway** on a fixed port that DSH talks to, so the model
  behind it can change without touching DSH's provider config. `llama-server`'s
  non-OpenAI `/v1/models` response is synthesized into a proper one rather than
  passed through.
- **Graceful shutdown via a real `Ctrl+C`** delivered over a hidden console
  (`AttachConsole` + `GenerateConsoleCtrlEvent`), so llama.cpp frees the model and
  its VRAM itself. Verified end-to-end: clean exit code `0` and ~12 GB released on
  a 27B model.
- **Serialization gate**: inference holds a shared ticket, model transitions need
  an exclusive one, so a switch can never run while a request is being served.
  Bounded queue with HTTP 429 on overflow, and a drain deadline that lets a stuck
  switch proceed instead of hanging forever.
- **Leftover-process safety net**: persists `runtime.json` and, on startup, can
  clean a process left behind by a previous run — but only when pid, image name
  and served model *all* match.
- **Settings page** (no build step) with live status, log tail, model editor,
  directory scan for `.gguf` files, argv preview and one-click actions.
- **Always-available stop button.** The stop control used to render only while a
  model was loaded, which left no way to stop `llama-server` from the UI after a
  crash or a failed load — precisely when reclaiming VRAM matters most. It is now
  always present, disabled only while another operation is in flight, and it
  reports honestly when there was nothing to stop. `POST /manager/unload` was
  already safe to call unconditionally.
- **Management HTTP API** with same-origin access from the DSH UI, host-header
  validation, and an opt-out `x-llama-manager` token for mutating calls.
- **Standalone mode** (`npm start`) for using the gateway without DSH.

### Robustness notes

Several defects were found by measurement rather than by reading; they are
documented with their trigger conditions and verification in
[`docs/ROBUSTNESS.md`](docs/ROBUSTNESS.md). The most significant:

- `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` broadcasts to *every* process on the
  console, so the helper now verifies the console is exclusively ours before
  signalling and otherwise refuses, falling back to a targeted forced kill.
- Registering `uncaughtException` / `unhandledRejection` in the DSH host plugin
  would have swallowed fatal errors for the entire harness (DSH installs no such
  handlers itself); orphan prevention does not need them, so they were removed.
- The gate's `_enqueue` armed no drain timer, so a model switch with an in-flight
  request hung forever.
- Leftover-process cleanup reported success without checking whether `taskkill`
  actually worked, and returned `null` on success.
- The final kill fallback used a bare pid; it now uses the child handle, so a
  recycled pid can never terminate an unrelated process.

[1.0.0]: https://github.com/DoctorxPriestess/dsh-llama-model-manager/releases/tag/v1.0.0
