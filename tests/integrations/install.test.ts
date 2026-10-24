import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SETUP = fileURLToPath(new URL('../../integrations/claude-code/setup.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CLAUDE_TOKEN = 'sk-ant-test-claude-token';
let root: string, server: http.Server, url: string, calls: string[];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-'));
  calls = [];
  server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.url === '/join') res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'tok-from-join', name: 'Ana Silva', created: true }));
    else res.writeHead(req.headers.authorization === 'Bearer tok-from-join' ? 200 : 401).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

// a `claude` the installer can run: a .cmd on Windows (it needs a shell there), a script elsewhere
function fakeClaude() {
  const win = process.platform === 'win32';
  const file = path.join(root, win ? 'claude.cmd' : 'claude');
  fs.writeFileSync(file, win ? `@"${process.execPath}" "${FAKE}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return file;
}

const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null, out: string, err: string }>((resolve) => {
  const p = spawn(process.execPath, [SETUP, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); // stdin is not a terminal
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out, err }));
});

it('installs end to end with flags and no terminal, and a re-run reuses the token', async () => {
  const folder = path.join(root, 'work');
  const home = path.join(root, 'home');
  const claudeDir = path.join(root, 'claude-config');
  fs.mkdirSync(folder);
  const log = path.join(root, 'claude.log');
  const env = { SAMEPAGE_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_EXECPATH: fakeClaude(), FAKE_CLAUDE_LOG: log };
  const args = ['--join', 'code', '--name', 'Ana Silva', '--folders', folder, '--claude-token', CLAUDE_TOKEN, '--url', url];

  const r = await run(args, env);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(r.out.trim().split(os.EOL).pop()).toContain(`SamePage is set up. Capture runs in: ${folder}.`);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  expect(config).toMatchObject({ url, token: 'tok-from-join', claudeToken: CLAUDE_TOKEN, folders: [folder] });
  expect(JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).hooks.SessionStart).toHaveLength(1);
  expect(fs.readFileSync(log, 'utf8')).toContain('"add"');
  for (const secret of ['tok-from-join', CLAUDE_TOKEN]) expect(r.out + r.err).not.toContain(secret);

  const again = await run(args, env);
  expect(again.code).toBe(0);
  expect(calls.filter((c) => c === 'POST /join')).toHaveLength(1);
}, 30_000);
