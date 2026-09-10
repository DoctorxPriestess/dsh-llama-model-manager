# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
