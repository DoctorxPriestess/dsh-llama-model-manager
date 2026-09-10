/**
 * Command-line text -> argv tokenizer, and llama-server argv builder.
 *
 * Design rules (see README / task spec):
 *  - The user's argument text is treated as an OPAQUE argv tail: we never
 *    reorder, rewrite, optimize or drop user tokens.
 *  - We only ADD the three base arguments `-m`, `--host`, `--port` when the
 *    user did not supply them, and we never add anything else.
 *  - Known path-bearing flags (`-m/--model`, `--mmproj`) are pre-flight checked
 *    for existence; unknown flags are passed through untouched so that future
 *    llama.cpp options never require a plugin change.
 *
 * Quoting follows the Windows CRT rules (CommandLineToArgvW), which is what a
 * Windows child process actually receives, plus a pragmatic extension:
 * single-quoted sections are supported as well.
 */

/** Characters treated as argv separators. */
const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/**
 * Tokenize a full command line text into argv tokens.
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeCommandLine(input) {
  if (input === null || input === undefined) return [];
  const text = String(input);
  const tokens = [];
  let current = '';
  let started = false;
  let i = 0;
  const n = text.length;

  const push = () => {
    if (started) {
      tokens.push(current);
      current = '';
      started = false;
    }
  };

  while (i < n) {
    const ch = text[i];

    if (SPACE.has(ch)) {
      push();
      i += 1;
      continue;
    }

    if (ch === '"') {
      // Double-quoted section (CRT rules).
      started = true;
      i += 1;
      let closed = false;
      while (i < n) {
        if (text[i] === '\\') {
          let backslashes = 0;
          while (i < n && text[i] === '\\') {
            backslashes += 1;
            i += 1;
          }
          if (i < n && text[i] === '"') {
            current += '\\'.repeat(backslashes >> 1);
            if (backslashes % 2 === 1) {
              current += '"';
              i += 1;
            } else {
              i += 1; // closing quote consumed here
              closed = true;
              break;
            }
          } else {
            current += '\\'.repeat(backslashes);
          }
          continue;
        }
        if (text[i] === '"') {
          // `""` inside a quoted section is one literal quote (CRT rule).
          if (i + 1 < n && text[i + 1] === '"') {
            current += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        current += text[i];
        i += 1;
      }
      if (!closed) {
        // Unterminated quote: keep what we parsed (lenient, never throw).
        // The caller may warn; llama.cpp will produce a clear error itself.
      }
      continue;
    }

    if (ch === "'") {
      // Single-quoted section (extension): no backslash escapes, `''` = one quote.
      started = true;
      i += 1;
      while (i < n) {
        if (text[i] === "'") {
          if (i + 1 < n && text[i + 1] === "'") {
            current += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        current += text[i];
        i += 1;
      }
      continue;
    }

    if (ch === '\\' && i + 1 < n && text[i + 1] === '"') {
      // Escaped quote outside quotes.
      current += '"';
      started = true;
      i += 2;
      continue;
    }

    current += ch;
    started = true;
    i += 1;
  }

  push();
  return tokens;
}

/** Flags that take a value and are recognized for conflict detection / pre-flight. */
const MODEL_FLAGS = new Set(['-m', '--model']);
const HOST_FLAGS = new Set(['--host']);
const PORT_FLAGS = new Set(['--port']);
/** Flags whose value is a file path we can pre-flight check. */
const PATH_FLAGS = new Set(['-m', '--model', '--mmproj', '-mm', '--model-draft', '-md']);

/**
 * Find the value of `flag` in an existing argv tail.
 * Supports both `--flag value` and `--flag=value` forms.
 * @returns {{value: string, index: number}|null}
 */
function findFlagValue(argv, flags) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (flags.has(token)) {
      const next = argv[i + 1];
      if (next === undefined) return { value: '', index: i };
      return { value: next, index: i };
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      const name = token.slice(0, eq);
      if (flags.has(name)) return { value: token.slice(eq + 1), index: i };
    }
  }
  return null;
}

/** Collect path-bearing flag values present in the argv tail (for pre-flight checks). */
export function collectPathArguments(argv) {
  const found = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    let name = null;
    let value = null;
    if (PATH_FLAGS.has(token)) {
      name = token;
      value = argv[i + 1] ?? '';
      i += 1;
    } else {
      const eq = token.indexOf('=');
      if (eq > 0 && PATH_FLAGS.has(token.slice(0, eq))) {
        name = token.slice(0, eq);
        value = token.slice(eq + 1);
      }
    }
    if (name !== null) found.push({ flag: name, value });
  }
  return found;
}

/** Raised for user-fixable configuration problems (never a crash). */
export class LaunchConfigError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LaunchConfigError';
    this.detail = detail;
  }
}

/**
 * Build the final argv for a model spawn.
 *
 * @param {object} input
 * @param {string} input.modelPath            mapped GGUF path of the model
 * @param {string} [input.argumentsText]      user's raw argument text (opaque)
 * @param {number|string} input.internalPort  configured internal llama-server port
 * @param {string} [input.host]               configured host to auto-fill
 * @param {number|string} input.gatewayPort   gateway port (must not collide)
 * @returns {{
 *   argv: string[],
 *   effectivePort: number,
 *   effectiveHost: string,
 *   connectHost: string,
 *   modelPathArg: string,
 *   autoFilled: string[],
 *   notes: string[],
 * }}
 */
export function buildLaunchArgs({
  modelPath,
  argumentsText = '',
  internalPort,
  host = '127.0.0.1',
  gatewayPort,
}) {
  const tokens = tokenizeCommandLine(argumentsText);

  const modelFlag = findFlagValue(tokens, MODEL_FLAGS);
  const hostFlag = findFlagValue(tokens, HOST_FLAGS);
  const portFlag = findFlagValue(tokens, PORT_FLAGS);

  const autoFilled = [];
  const notes = [];
  const prefix = [];

  const modelPathArg = modelFlag && modelFlag.value ? modelFlag.value : modelPath;
  if (!modelFlag) {
    prefix.push('-m', String(modelPath));
    autoFilled.push('-m');
  } else if (!modelFlag.value) {
    throw new LaunchConfigError(
      '启动参数中存在 -m/--model 但没有取值；请补上模型路径，或删除该参数让插件自动补全。',
      { arguments: argumentsText },
    );
  } else if (normalizePathForCompare(modelFlag.value) !== normalizePathForCompare(modelPath)) {
    notes.push(
      `启动参数中的 -m/--model (${modelFlag.value}) 与模型配置的 GGUF 路径 (${modelPath}) 不一致，已按用户参数生效。`,
    );
  }

  const effectiveHost = hostFlag && hostFlag.value ? hostFlag.value : host;
  if (!hostFlag) {
    prefix.push('--host', String(host));
    autoFilled.push('--host');
  }

  let effectivePort;
  if (portFlag) {
    if (!portFlag.value) {
      throw new LaunchConfigError(
        '启动参数中存在 --port 但没有取值；请补上端口号，或删除该参数让插件自动补全。',
        { arguments: argumentsText },
      );
    }
    effectivePort = Number.parseInt(String(portFlag.value), 10);
    if (!Number.isInteger(effectivePort) || effectivePort <= 0 || effectivePort > 65535) {
      throw new LaunchConfigError(
        `启动参数中的 --port 取值非法：${portFlag.value}（应为 1-65535 的整数）。`,
        { arguments: argumentsText },
      );
    }
    if (gatewayPort !== undefined && Number(gatewayPort) === effectivePort) {
      throw new LaunchConfigError(
        `启动参数中的 --port（${effectivePort}）与插件 Gateway 监听端口冲突，` +
          '会导致 Gateway 无法监听。请改用其它端口或删除该参数（插件会自动补内部端口）。',
        { arguments: argumentsText, gatewayPort, port: effectivePort },
      );
    }
    if (
      internalPort !== undefined &&
      Number.parseInt(String(internalPort), 10) !== effectivePort
    ) {
      notes.push(
        `启动参数指定了 --port ${effectivePort}（与配置的内部端口 ${internalPort} 不同），` +
          '已尊重用户参数，健康检查与转发将使用该端口。',
      );
    }
  } else {
    effectivePort = Number.parseInt(String(internalPort), 10);
    if (!Number.isInteger(effectivePort) || effectivePort <= 0 || effectivePort > 65535) {
      throw new LaunchConfigError(`插件配置的内部端口非法：${internalPort}`);
    }
    if (gatewayPort !== undefined && Number(gatewayPort) === effectivePort) {
      throw new LaunchConfigError(
        `插件配置的内部端口 ${effectivePort} 与 Gateway 监听端口相同，无法同时监听。请修改其中一个。`,
        { gatewayPort, internalPort: effectivePort },
      );
    }
    prefix.push('--port', String(effectivePort));
    autoFilled.push('--port');
  }

  const argv = [...prefix, ...tokens];

  return {
    argv,
    effectivePort,
    effectiveHost: String(effectiveHost),
    connectHost: connectHostFor(effectiveHost),
    modelPathArg,
    autoFilled,
    notes,
    tokenCount: tokens.length,
  };
}

/**
 * Turn a bind address into an address we can actually connect to for health checks.
 * `0.0.0.0` / `::` / empty mean "all interfaces" -> connect via loopback.
 */
export function connectHostFor(host) {
  const value = String(host ?? '').trim();
  if (value === '' || value === '0.0.0.0' || value === '::' || value === '*' || value === '[::]') {
    return '127.0.0.1';
  }
  if (value.startsWith('[') && value.endsWith(']')) return value;
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

function normalizePathForCompare(value) {
  return String(value ?? '')
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** Human readable, non-secret command line for logs (never contains headers). */
export function formatArgvForLog(exePath, argv) {
  return [exePath, ...argv].map(quoteForDisplay).join(' ');
}

function quoteForDisplay(value) {
  const text = String(value);
  if (text === '' || /[\s"]/.test(text)) return `"${text.replace(/"/g, '\\"')}"`;
  return text;
}
