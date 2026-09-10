#!/usr/bin/env node
/**
 * Portable `npm test` entry point.
 *
 * WHY NOT `node --test "test/*.test.js"`
 * --------------------------------------
 * Node only started expanding glob patterns in `--test` positional arguments in
 * v21. On Node 20 the pattern is taken as a literal path and the runner exits 1
 * with:
 *
 *   Could not find 'D:\a\...\test\*.test.js'
 *
 * which is exactly how CI failed on the Node 20 leg while 22 and 24 passed.
 * Node's default file discovery is not a substitute either: it matches
 * `**\/test/**\/*.js`, which would sweep up `test/fixtures/` -- helper scripts
 * that a test spawns as a child, not tests.
 *
 * So the file list is resolved here and handed to `node --test` as explicit
 * paths. That is the one form every supported version agrees on, it is
 * independent of the working directory, and new `*.test.js` files are picked up
 * automatically.
 */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = new URL('../test/', import.meta.url);

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error(`run-tests: no *.test.js files found in ${fileURLToPath(testDir)}`);
  process.exit(1);
}

const args = ['--test', ...files.map((name) => fileURLToPath(new URL(name, testDir)))];

console.log(`run-tests: node --test (${files.length} files)`);

const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });

child.on('error', (error) => {
  console.error(`run-tests: failed to start the test runner: ${error.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  // Mirror the child's outcome so CI sees a real failure, not exit 0.
  process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
});
