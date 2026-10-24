#!/usr/bin/env node
// node hook.mjs <session-start|prompt|stop|session-end>, hook JSON on stdin. Always exits 0.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { samepageHome } from './lib/paths.mjs';
import { handleHook } from './lib/handle-hook.mjs';
import { readConfig } from './lib/state.mjs';

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
  const home = samepageHome();
  const { stdout, spawn: argv } = handleHook(process.argv[2] ?? '', input, { home, env: process.env, now: Date.now() });
  if (stdout) await new Promise((r) => process.stdout.write(stdout, r)); // flush before exit
  if (argv) spawn(process.execPath, argv, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  if (process.argv[2] === 'session-start' && !process.env.SAMEPAGE_EXTRACTOR && readConfig(home)) {
    const { dueForUpdate } = await import('./update.mjs'); // loaded late: a broken update.mjs must not break this hook
    if (dueForUpdate(home, Date.now())) spawn(process.execPath, [fileURLToPath(new URL('./update.mjs', import.meta.url))], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  }
} catch { /* a hook never breaks the session */ }
process.exit(0);
