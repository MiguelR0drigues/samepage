#!/usr/bin/env node
// node hook.mjs <session-start|prompt|stop|session-end>, hook JSON on stdin. Always exits 0.
import { spawn } from 'node:child_process';
import { samepageHome } from './lib/paths.mjs';
import { handleHook } from './lib/handle-hook.mjs';

const readStdin = () => new Promise((resolve) => {
  let data = '';
  const done = () => { clearTimeout(timer); resolve(data); };
  const timer = setTimeout(done, 5000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', done);
  process.stdin.on('error', done);
});

try {
  const input = JSON.parse(/** @type {string} */ (await readStdin()));
  const { stdout, spawn: argv } = handleHook(process.argv[2] ?? '', input, { home: samepageHome(), env: process.env, now: Date.now() });
  if (stdout) await new Promise((r) => process.stdout.write(stdout, r)); // flush before exit
  if (argv) spawn(process.execPath, argv, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
} catch { /* a hook never breaks the session */ }
process.exit(0);
