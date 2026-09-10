#!/usr/bin/env node
/**
 * Standalone entry point: runs the OpenAI-compatible gateway without DSH.
 *
 * Useful for:
 *  - tests (spawn/kill the whole manager as a child process);
 *  - using the model switcher from any other OpenAI client;
 *  - diagnosing the gateway while DSH is not running.
 *
 * Usage:
 *   node src/standalone.js [--config <path>] [--log-level debug] [--no-preload]
 */
import process from 'node:process';

import { createRuntime } from './core/runtime.js';
import { resolveConfigPath } from './core/config.js';

function parseArgs(argv) {
  const options = { configPath: null, logLevel: null, preload: true, listen: true, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config' || token === '-c') options.configPath = argv[++i] ?? null;
    else if (token === '--log-level' || token === '-l') options.logLevel = argv[++i] ?? null;
    else if (token === '--no-preload') options.preload = false;
    else if (token === '--no-listen') options.listen = false;
    else if (token === '--quiet') options.quiet = true;
    else if (token === '--help' || token === '-h') options.help = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(
    'llama-model-manager standalone gateway\n\n' +
      '  --config, -c <path>     config file (default: %DSH_HOME%/llama-model-manager/config.json)\n' +
      '  --log-level, -l <level> debug | info | warn | error\n' +
      '  --no-preload            do not preload the configured startupModel\n' +
      '  --no-listen             configure the manager but do not bind the gateway\n' +
      '  --quiet                 keep llama-server output out of the console\n\n',
  );
  process.exit(0);
}

const runtime = await createRuntime({
  configPath: options.configPath ?? resolveConfigPath(),
  logLevel: options.logLevel ?? process.env.DSH_LLAMA_MANAGER_LOG_LEVEL ?? 'info',
});

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.logger.info(`[manager] received ${signal}, shutting down`);
  try {
    await runtime.stop({ reason: signal });
  } catch (error) {
    runtime.logger.error(`[manager] shutdown error: ${error.message}`);
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
// This process IS the host, so owning these is correct here -- unlike inside
// DSH, where adding them would swallow fatal errors for the whole harness.
// Exit non-zero so a supervisor can tell a crash apart from a clean stop.
process.on('uncaughtException', (error) => {
  runtime.logger.error(`[manager] uncaught exception: ${error?.stack ?? error}`);
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  runtime.logger.error(`[manager] unhandled rejection: ${reason?.stack ?? reason}`);
  void shutdown('unhandledRejection', 1);
});
process.on('exit', () => {
  // Best-effort: no async work is possible here, but the child gets its own
  // stop on the signal paths above. This covers hard exits of the parent.
  // Uses the child handle, not the pid, so a recycled pid cannot make us
  // terminate an unrelated process.
  const proc = runtime.manager.current?.proc;
  if (!proc || proc.exited) return;
  proc.stopRequested = true;
  try {
    proc.child?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});

const started = await runtime.start({ listen: options.listen, preload: options.preload });
runtime.logger.info('[manager] manager is running; press Ctrl+C to stop');
if (started.listenError) {
  runtime.logger.error(`[manager] gateway failed to start: ${started.listenError.message}`);
  process.exitCode = 2;
}
