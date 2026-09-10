/**
 * Unit tests for command-line parsing and argv building — spec §4, §5, §27
 * (Tests 14 and 15 in the task list are asserted here at argv level and again
 * end-to-end against the real llama-server by scripts/e2e-ctrlc.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLaunchArgs,
  collectPathArguments,
  connectHostFor,
  formatArgvForLog,
  LaunchConfigError,
  tokenizeCommandLine,
} from '../src/core/args.js';

const GGUF = 'C:\\models\\Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf';
const MMPROJ = 'C:\\models\\mmproj-Qwen3.8-27B-BF16.gguf';

test('tokenizer: plain tokens', () => {
  assert.deepEqual(tokenizeCommandLine('--ctx-size 131072 -fa on'), ['--ctx-size', '131072', '-fa', 'on']);
});

test('tokenizer: double quotes with spaces and Windows paths', () => {
  assert.deepEqual(
    tokenizeCommandLine('-m "C:\\models\\Qwen Model\\a b.gguf" --host 127.0.0.1'),
    ['-m', 'C:\\models\\Qwen Model\\a b.gguf', '--host', '127.0.0.1'],
  );
});

test('tokenizer: Chinese paths and parentheses', () => {
  assert.deepEqual(
    tokenizeCommandLine('-m "D:\\模型 库\\Qwen（测试）\\模型.gguf"'),
    ['-m', 'D:\\模型 库\\Qwen（测试）\\模型.gguf'],
  );
});

test('tokenizer: newlines and tabs (YAML folded block) act as separators', () => {
  const text = '--mmproj "D:\\a b\\mm.gguf"\n--no-mmproj-offload\n\t--ctx-size 131072';
  assert.deepEqual(tokenizeCommandLine(text), [
    '--mmproj',
    'D:\\a b\\mm.gguf',
    '--no-mmproj-offload',
    '--ctx-size',
    '131072',
  ]);
});

test('tokenizer: single quotes are supported as an extension', () => {
  assert.deepEqual(tokenizeCommandLine("--chat-template-kwargs '{\"a\": 1}'"), [
    '--chat-template-kwargs',
    '{"a": 1}',
  ]);
});

test('tokenizer: escaped quote inside a quoted value', () => {
  assert.deepEqual(tokenizeCommandLine('--template "say \\"hi\\" now"'), ['--template', 'say "hi" now']);
});

test('tokenizer: doubled quotes inside a quoted value become one quote', () => {
  assert.deepEqual(tokenizeCommandLine('--template "say ""hi"" now"'), ['--template', 'say "hi" now']);
});

test('tokenizer: empty input', () => {
  assert.deepEqual(tokenizeCommandLine(''), []);
  assert.deepEqual(tokenizeCommandLine('   \n  '), []);
  assert.deepEqual(tokenizeCommandLine(null), []);
});

test('Test 15: only --ctx-size given -> -m/--host/--port are auto-filled and nothing else', () => {
  const launch = buildLaunchArgs({
    modelPath: GGUF,
    argumentsText: '--ctx-size 131072',
    internalPort: 18080,
    gatewayPort: 8080,
  });
  assert.deepEqual(launch.argv, ['-m', GGUF, '--host', '127.0.0.1', '--port', '18080', '--ctx-size', '131072']);
  assert.deepEqual(launch.autoFilled, ['-m', '--host', '--port']);
  assert.equal(launch.effectivePort, 18080);
  assert.equal(launch.effectiveHost, '127.0.0.1');
  // No reasoning / batch / ctx / kv / mmproj / gpu-layers injected by the plugin.
  for (const forbidden of ['-b', '-ub', '-fa', '-ctk', '-ctv', '-np', '-ngl', '--jinja', '--mmproj', '--reasoning']) {
    assert.ok(!launch.argv.includes(forbidden), `plugin must not inject ${forbidden}`);
  }
});

test('Test 15: empty arguments -> only the three base arguments', () => {
  const launch = buildLaunchArgs({ modelPath: GGUF, argumentsText: '', internalPort: 18080, gatewayPort: 8080 });
  assert.deepEqual(launch.argv, ['-m', GGUF, '--host', '127.0.0.1', '--port', '18080']);
});

test('Test 14: user-provided -m/--host/--port are respected and never duplicated', () => {
  const user = `-m "${GGUF}" --host 0.0.0.0 --port 18099 --ctx-size 4096`;
  const launch = buildLaunchArgs({
    modelPath: GGUF,
    argumentsText: user,
    internalPort: 18080,
    gatewayPort: 8080,
  });
  assert.deepEqual(launch.argv, ['-m', GGUF, '--host', '0.0.0.0', '--port', '18099', '--ctx-size', '4096']);
  assert.equal(launch.argv.filter((t) => t === '-m').length, 1);
  assert.equal(launch.argv.filter((t) => t === '--host').length, 1);
  assert.equal(launch.argv.filter((t) => t === '--port').length, 1);
  assert.deepEqual(launch.autoFilled, []);
  assert.equal(launch.effectivePort, 18099);
  assert.equal(launch.connectHost, '127.0.0.1'); // 0.0.0.0 -> probe loopback
});

test('Test 14: --flag=value form is detected too', () => {
  const launch = buildLaunchArgs({
    modelPath: GGUF,
    argumentsText: `--model=${GGUF} --host=127.0.0.1 --port=18099`,
    internalPort: 18080,
    gatewayPort: 8080,
  });
  assert.deepEqual(launch.autoFilled, []);
  assert.equal(launch.effectivePort, 18099);
});

test('Test 14: user -m pointing elsewhere wins but is reported as a note', () => {
  const other = 'C:\\models\\other.gguf';
  const launch = buildLaunchArgs({
    modelPath: GGUF,
    argumentsText: `-m "${other}"`,
    internalPort: 18080,
    gatewayPort: 8080,
  });
  assert.equal(launch.modelPathArg, other);
  assert.equal(launch.argv.filter((t) => t === '-m').length, 1);
  assert.equal(launch.notes.length, 1);
  assert.match(launch.notes[0], /不一致/);
});

test('user --port colliding with the gateway port is a hard error (never silently overridden)', () => {
  assert.throws(
    () =>
      buildLaunchArgs({
        modelPath: GGUF,
        argumentsText: '--port 8080',
        internalPort: 18080,
        gatewayPort: 8080,
      }),
    (error) => error instanceof LaunchConfigError && /冲突/.test(error.message),
  );
});

test('configured internal port equal to the gateway port is a hard error', () => {
  assert.throws(
    () => buildLaunchArgs({ modelPath: GGUF, argumentsText: '', internalPort: 8080, gatewayPort: 8080 }),
    (error) => error instanceof LaunchConfigError,
  );
});

test('invalid --port value is a hard error', () => {
  assert.throws(
    () => buildLaunchArgs({ modelPath: GGUF, argumentsText: '--port abc', internalPort: 18080, gatewayPort: 8080 }),
    (error) => error instanceof LaunchConfigError && /非法/.test(error.message),
  );
});

test('-m without a value is a hard error', () => {
  assert.throws(
    () => buildLaunchArgs({ modelPath: GGUF, argumentsText: '-m', internalPort: 18080, gatewayPort: 8080 }),
    (error) => error instanceof LaunchConfigError,
  );
});

test('user --port different from the configured internal port is respected and noted', () => {
  const launch = buildLaunchArgs({
    modelPath: GGUF,
    argumentsText: '--port 19191',
    internalPort: 18080,
    gatewayPort: 8080,
  });
  assert.equal(launch.effectivePort, 19191);
  assert.match(launch.notes.join(' '), /19191/);
});

test('unknown/future llama.cpp flags are passed through untouched', () => {
  const future = '--some-future-flag 7 --another=value -zz';
  const launch = buildLaunchArgs({ modelPath: GGUF, argumentsText: future, internalPort: 18080, gatewayPort: 8080 });
  assert.deepEqual(launch.argv.slice(-4), ['--some-future-flag', '7', '--another=value', '-zz']);
});

test('argument order inside the user text is preserved exactly', () => {
  const user = '--jinja -fa on -ctk q4_0 -ctv q4_0 -b 256 -ub 256 -np 1 --ctx-size 131072';
  const launch = buildLaunchArgs({ modelPath: GGUF, argumentsText: user, internalPort: 18080, gatewayPort: 8080 });
  assert.deepEqual(launch.argv.slice(6), user.split(' '));
});

test('the real-world Qwen3.8 example from the task description parses into the expected argv', () => {
  const user =
    '-m "C:\\models\\Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf" --host 127.0.0.1 --port 8080 ' +
    '--mmproj "C:\\models\\mmproj-Qwen3.8-27B-BF16.gguf" --no-mmproj-offload --ctx-size 131072 ' +
    '-fa on -ctk q4_0 -ctv q4_0 -b 256 -ub 256 -np 1 --jinja';
  const tokens = tokenizeCommandLine(user);
  assert.deepEqual(tokens, [
    '-m', GGUF,
    '--host', '127.0.0.1',
    '--port', '8080',
    '--mmproj', MMPROJ,
    '--no-mmproj-offload',
    '--ctx-size', '131072',
    '-fa', 'on',
    '-ctk', 'q4_0',
    '-ctv', 'q4_0',
    '-b', '256',
    '-ub', '256',
    '-np', '1',
    '--jinja',
  ]);
  assert.ok(tokens.includes('--no-mmproj-offload'));
  assert.deepEqual(collectPathArguments(tokens).map((entry) => entry.flag), ['-m', '--mmproj']);
});

test('connectHostFor maps wildcard binds to loopback', () => {
  assert.equal(connectHostFor('0.0.0.0'), '127.0.0.1');
  assert.equal(connectHostFor('::'), '127.0.0.1');
  assert.equal(connectHostFor('127.0.0.1'), '127.0.0.1');
  assert.equal(connectHostFor('192.168.1.5'), '192.168.1.5');
  assert.equal(connectHostFor('::1'), '[::1]');
});

test('formatArgvForLog quotes only when needed and never leaks anything else', () => {
  assert.equal(
    formatArgvForLog('C:\\bin\\llama-server.exe', ['-m', 'D:\\a b\\c.gguf', '--port', '18080']),
    'C:\\bin\\llama-server.exe -m "D:\\a b\\c.gguf" --port 18080',
  );
});
