# Known issues / review backlog

Findings from a full read-only review of this plugin (three independent passes:
lifecycle core, gateway/config/API, and settings page + packaging + docs), minus
everything already fixed. Each item was verified by reading the code; where a
claim was measured, the method is noted.

Severity is about consequence, not effort:

- **HIGH** — crashes the host, wedges the gateway, leaks the GPU, or loses data.
- **MED** — wrong behaviour in a realistic situation; workaround exists.
- **LOW** — papercut, misleading message, or hardening.

Fixed items are in [`ROBUSTNESS.md`](ROBUSTNESS.md) and `CHANGELOG.md`.

---

## HIGH

_(none outstanding — the four HIGH findings are fixed and regression-tested.)_

---

## MEDIUM

### M1. A new llama-server can be started after shutdown has returned
`src/core/manager.js` — `shutdown()` does not take the exclusive gate ticket, and
`shuttingDown` is only checked in `acquireForRequest()` and the crash-recovery
branch. `load` / `restart` / `unload` / `_switchTo` / `_startModel` / the rollback
path never check it.

If a load or switch is in flight when shutdown runs, the retry loop can spawn a
**brand new** llama-server after `shutdown()` has already reported
"shutdown complete": the VRAM just released is taken again, and `runtime.json`
is rewritten after having been deleted. On a plugin reload (host stays alive)
the new child is unmanaged.

*Fix:* check `this.shuttingDown` at the top of `_startModel` and inside the
`_switchTo` retry loop, and early-throw from `load`/`restart`/`unload`.

### M2. The second `taskkill` in leftover cleanup reuses a 15-second-old pid
`src/core/manager.js` `_waitForProcessGone` → second `taskkill /PID <stale.pid> /F`.
Attribution (pid + image name + served model) happened ~15 s earlier. Windows
recycles pids quickly, so by then the pid can belong to an unrelated process —
and every safety claim in this project rests on "we only ever kill a process we
could positively identify".

*Fix:* re-query the image name immediately before the second kill and give up
(reporting `STALE_CLEANUP_FAILED`) if it no longer matches.

### M3. `runtime.json` is written non-atomically
`src/core/manager.js` `_writeRuntimeState()` uses a plain `writeFileSync`. A hard
kill or power loss mid-write truncates the JSON; `_readRuntimeState()` then
returns `null` and the orphaned llama-server (holding ~12 GB) becomes
untraceable — the startup safety net can never find it.

*Fix:* copy the pattern already used by `saveConfig()` in `config.js`: write to
`runtime.json.<pid>.tmp`, `fsync`, then `rename`.

### M4. A failed `tasklist` query is indistinguishable from "process is dead"
`src/core/manager.js` — `_queryImageName()` collapses five different outcomes
(pid gone, spawn failure, `maxBuffer` overflow, non-zero exit, unparseable
output) into `null`. `_inspectStaleProcess()` reads that as `alive = false` and
**deletes** the runtime record of a process that may still be running, which
defeats the safety net exactly as in M3.

*Fix:* return a tri-state (`alive` / `dead` / `unknown`); only `dead` may clear
the record, and `unknown` should warn and keep it.

### M5. `POST /manager/scan` blocks the DSH event loop
`src/core/manager.js` `scanModelDirectory()` recurses with **synchronous**
`readdirSync`/`statSync`. Only the *hit* count and depth are bounded, so scanning
a drive root (`C:\`, `D:\`) issues tens of thousands of synchronous syscalls on
the thread DSH itself runs on — the whole harness becomes unresponsive, including
in-flight SSE streams.

*Fix:* `fs.promises.readdir` with an `await` per directory (yielding between
them), plus a visited-entry budget and a time budget.

### M6. `managerPid` is written but never read
`src/core/manager.js` writes `managerPid` into `runtime.json`; nothing consumes
it. Running a second manager (e.g. `npm start` with a different `gatewayPort`,
which skips the early-return in `runtime.js`) makes it treat the **live**,
DSH-managed llama-server as a leftover and `taskkill /T /F` it mid-inference.

*Fix:* in `_inspectStaleProcess()`, when `recorded.managerPid` is alive and is
not us, mark `attributable: false` and refuse to touch anything.

### M7. Prototype keys leak into the model dictionary
`src/core/config.js` — `models` is a plain object, and both the duplicate check
(`if (models[model.id])`) and `findModel` (`if (models[needle])`) use inherited
properties. Verified against the real module: `findModel(models, 'constructor')`
returns the `Object` **function**, so `{"model":"constructor"}` passes model
resolution and reaches the switch path with `model.id === undefined`, ending in
a bogus "GGUF file does not exist: undefined". Conversely, a legitimate model
actually named `constructor` / `toString` / `__proto__` is rejected with a false
"duplicate model id" error.

*Fix:* build the map with `Object.create(null)` (or a `Map`) and use
`Object.hasOwn(models, id)`.

### M8. A 413 (body too large) never reaches the client
`src/core/gateway.js` `readBodyBuffer()` rejects with `RequestError(413)` **and**
calls `req.destroy()`, which tears down the socket first. Verified end-to-end:
the server logs the 413, the client receives zero bytes and a connection reset
instead of the documented JSON error.

*Fix:* write and end the 413 response first, then destroy on `res` `finish`; or
`req.pause()` and let a socket timeout reap it.

### M9. Validation failures are reported as HTTP 500
`src/core/gateway.js:174` and `src/index.js:111` use `error?.status ?? 500`, but
`ConfigError` and `LaunchConfigError` carry no `status`. So `POST /manager/models`
with an empty id, or a bad `gatewayPort`, answers 500 Internal Server Error
instead of 400.

*Fix:* give both error classes `status = 400`, or map them at the two catch sites.

### M10. `PUT /manager/config` replaces the whole config
`src/core/api.js` → `normalizeConfig` reads `source.models ?? {}`. A client that
sends only `{"settings":{...}}` silently deletes **every** model (the previous
file survives only in `.bak`).

*Fix:* merge when `body.models` is absent, or require an explicit
`replaceAll: true`.

### M11. `requireManagerToken: false` exposes mutations to cross-site requests
The `x-llama-manager: 1` header is the only CSRF defence and nothing checks
`Origin` / `Sec-Fetch-Site`. With the documented opt-out off, a page in the
user's browser can fire **simple**, unpreflighted requests (`POST` with
`content-type: text/plain`, which `readJsonBody` parses regardless of type) at
`/manager/load`, `/unload`, `/restart`, `/models`, `/scan`. The side effect
happens even though the response cannot be read.

*Fix:* reject mutating requests whose `Origin` is cross-site, require
`content-type: application/json` on mutations, and consider dropping the opt-out.

### M12. Body is buffered before any gate or auth check
`src/core/gateway.js` — `maxRequestBodyBytes` defaults to 128 MiB, a body can be
buffered before `/manager/*`'s token check, and nothing bounds concurrent
connections or body inactivity.

*Fix:* a few MiB default, read the body after the ticket/token check, set
`server.maxConnections`, and add a body-inactivity timeout.

### M13. Model-id rename duplicates instead of renaming
`lib/client.js` + `src/core/api.js` — saving an edit whose id changed PUTs to the
old id with a new-id body, which upserts the **new** key and leaves the old one.
Two records then point at the same GGUF and `findModel`'s path match hits
whichever comes first.

*Fix:* treat an id change as a rename server-side (or delete the old key after a
successful PUT).

---

## LOW

| # | Where | Issue |
|---|---|---|
| L1 | `src/core/process.js` `_consume` | `_stdoutRemainder` / `_stderrRemainder` are unbounded: `MAX_LINE_LENGTH` only applies to newline-terminated lines, so output using bare `\r` progress updates grows without limit. |
| L2 | `src/core/process.js` `_taskkill` | No timeout; a wedged `taskkill` stalls `stop()` before it reaches the forced-wait and handle-`SIGKILL` fallbacks. |
| L3 | `src/core/manager.js` crash recovery | The `setTimeout(..., 500)` auto-recovery is neither stored nor cleared, so it fires after `shutdown()` (harmlessly rejected by `gate.abortAll`, but the log line is confusing). |
| L4 | `src/core/process.js` `_taskkill` | Output decoded with `d.toString()` (utf8) instead of the existing `decodeConsoleOutput`, so a failed forced kill reports mojibake on a 936-code-page console. |
| L5 | `src/core/process.js` `resolveShell` | The comment says `pwsh` is preferred, but the absolute `powershell.exe` path is tried first and always exists — so the `pwsh` branch is unreachable and every stop pays Windows PowerShell's startup cost. |
| L6 | `src/core/manager.js` `scanModelDirectory` | `truncated` only reflects the hit cap; an early stop from the depth limit reports `truncated: false`. |
| L7 | `src/core/gateway.js` `_hostAllowed` | `hostHeader === ''` returns `true` (reachable only via HTTP/1.0), which is weaker than the README implies. Gate it on HTTP/1.0. |
| L8 | `src/core/gateway.js` `_handle` | `new URL(req.url, 'http://' + req.headers.host)` sits outside the `try`; `Host: [::1` or an empty `Host` produces a 500 plus a stack trace instead of 400/403. |
| L9 | `src/core/gateway.js` `_handle` | `decodeURIComponent` on a raw path throws `URIError` → 500 (`GET /v1/models/%`). |
| L10 | `src/core/gateway.js` `listen()` | `onError` leaves `this.server` set, so a later `listen()` resolves without listening. |
| L11 | `src/core/runtime.js` `stop()` | `manager.shutdown()` is awaited before `gateway.close()`; if shutdown throws, the listener is never closed. Use `try/finally`. |
| L12 | `src/core/gate.js` `reset()` | Clears only `_aborted`, leaving `_exclusiveHeld` / `_activeReaders` — calling it after `abortAll()` with a ticket outstanding deadlocks the gate. Currently dead code. |
| L13 | `src/core/manager.js` | A relative GGUF path is pre-flight-checked against the DSH process cwd but spawned with `cwd: dirname(llamaServerPath)`. |
| L14 | `src/core/api.js` | `GET /manager/logs?limit=N` never reads the query string (GETs pass no body), so `limit` is always the 200 default — as documented in the README. |
| L15 | `src/core/health.js` `describePortOwner` | Depends on the English token `LISTENING` and a fixed `netstat` column; on a localized Windows this degrades silently to nulls. |
| L16 | `lib/client.js` `copy()` | The "copied" feedback `setTimeout` is not cleared on unmount, and with no `navigator.clipboard` the click gives no feedback at all. |
| L17 | `lib/client.js` poll | No `document.hidden` check: a background tab still pulls `/status` (including 120 log lines) every 2 s. |
| L18 | `lib/client.js` model save | The save body carries only 4 fields, so a hand-edited `enabled: false` (or any custom per-model key) is silently dropped on save. |
| L19 | `lib/client.js` "参数预览" | Previews the **persisted** config, so it ignores unsaved edits and 404s for a model that does not exist yet — while the button is enabled as soon as the id field is non-empty. |
| L20 | `lib/client.js` buttons | `ModelTable` never receives `busy` and `ModelEditor.save()` does not use `withBusy`, so Load/Restart/Delete/Create can be double-submitted. |
| L21 | `lib/client.js` | Server-computed `warnings` (e.g. "`startupModel` is not in the model list, preload will be skipped") are returned by the API but never rendered. |
| L22 | `README*.md` | "last ~40 stderr lines" — the API detail is `slice(-100)`; only the console preview prints 40. The directory tree also omits `errors.js`, `logger.js`, `runtime.js`, `test/`, `scripts/`. |
| L23 | `src/standalone.js` | `--port` / `--host` are documented in the README but do not exist, and unknown flags are silently ignored (`npm start -- --port 9000` keeps using 8080). |
| L24 | `src/standalone.js` | On a listen failure it sets `process.exitCode = 2`, but a later Ctrl+C calls `process.exit(0)` and discards it. |
| L25 | `.github/workflows/pr.yml` | Only triggers on `workflow_dispatch`, so the workflow named "PR preview" never runs on a PR. |
| L26 | `.github/workflows/ci.yml` | "Patch file parses" is two substring regexes — invalid YAML containing them passes. Actions are on floating major tags rather than pinned SHAs. The `'20'` matrix entry resolves to the latest 20.x, so the declared `>=20.10` floor is never actually tested. The machine-path check only matches three hardcoded patterns (misses `C:/Users/...`, other drive letters, and unlisted extensions). |
| L27 | `src/core/config.js`, `src/core/health.js` | `healthFallbackPath: ''` is accepted; after a 404 on `/health` the readiness loop then probes nothing for the whole `startupTimeoutMs` and fails with a misleading timeout. |
| L28 | `src/core/config.js` | `loadConfig`'s doc comment says it creates the file when missing; it only reports `existed: false` (`runtime.js` does the creating). |

---

## How this list was produced

Three read-only review passes over the whole repository (no file modified during
review), each required to verify claims against the source, mark anything it
could not verify, and report what it checked and found *clean*. Every HIGH finding
was then re-verified by hand and, where behaviour depended on runtime semantics,
measured — see `ROBUSTNESS.md` for the measurements (Windows signal semantics,
`unref()` on an awaited deadline, `fetch` decompression, pid recycling).
