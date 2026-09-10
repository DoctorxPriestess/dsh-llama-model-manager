# Contributing

Thanks for taking a look. This is a Windows-only DSH plugin, and its behaviour is
tightly coupled to Win32 process/console semantics — so the most valuable
contributions are usually *corrections backed by a measurement*, not refactors.

## Getting set up

```bash
git clone https://github.com/DoctorxPriestess/dsh-llama-model-manager.git
cd dsh-llama-model-manager
npm test          # no dependencies, no build step, ~4 s
```

To run it inside DSH, see the *Install* section of the [README](README.md).

## Before you open a PR

```bash
npm test          # must be green
npm run preflight # if you touched package.json / cordis.patch.yml
```

If your change touches the process stop path, please also run the end-to-end
scripts against a real model and paste the output:

```powershell
$env:LLAMA_SERVER_PATH = 'C:\path\to\llama-server.exe'
$env:LLAMA_MODEL       = 'C:\models\your-model.gguf'
npm run e2e:ctrlc
npm run e2e:orphan
```

## Guidelines

**Never guess about Windows behaviour — measure it.** This codebase has several
comments that exist because the obvious approach silently does nothing:

- `child.kill('SIGINT')` is compiled to `TerminateProcess()` by libuv and
  delivers no signal at all.
- `taskkill` without `/F` cannot stop a console process.
- `detached: true` gives the child *no* console (`DETACHED_PROCESS`), which makes
  `Ctrl+C` delivery impossible — `windowsHide: true` (`CREATE_NO_WINDOW`) is what
  makes it possible.
- On non-English Windows, `tasklist`'s "no such process" line is localized, so
  matching an English `INFO:` prefix reports every dead pid as alive.

If you find that one of these is wrong, a failing test plus the command output
that demonstrates it is the ideal PR.

**Keep the plugin a good citizen of the host:**

- Never read or write DSH's `settings.yaml`, or any other plugin's state.
- Never add a `process.on('uncaughtException')` / `unhandledRejection` listener in
  the host plugin (`src/index.js`) — it changes failure semantics for the whole
  harness.
- Never scan for or kill a `llama-server` process that this plugin did not start
  itself, unless it passes the full three-way attribution check.
- Never kill by bare pid where a child handle is available.
- Spawn every helper process with `windowsHide: true`; a console window must never
  flash.

**No new runtime dependencies.** The plugin deliberately ships with none.

## Code style

- ES modules, 2-space indent, single quotes, semicolons.
- Comments explain *why*, especially when the code contradicts the obvious
  approach. Cite the verification if the behaviour was measured.
- Tests live in `test/*.test.js` and must not require a model, network, or more
  than a few seconds.

## Reporting bugs

Please include:

- Windows version and locale (non-English locales genuinely change behaviour here),
- `llama-server` version/build,
- the relevant lines from the DSH startup log,
- and, if it is a stop/cleanup issue, the output of `npm run e2e:ctrlc` or
  `npm run e2e:orphan`.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
