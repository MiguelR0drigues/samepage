import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyUpdate, dueForUpdate, UPDATE_EVERY_MS } from '../../integrations/claude-code/update.mjs';

const HOOK = fileURLToPath(new URL('../../integrations/claude-code/hook.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = 1_000_000_000_000;
let root: string, home: string, settingsFile: string;
const CONFIG = JSON.stringify({ url: 'http://x', token: 't', folders: ['/c'], claudeToken: 'k' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-update-'));
  home = path.join(root, 'home');
  settingsFile = path.join(root, 'claude', 'settings.json');
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(settingsFile));
  fs.writeFileSync(path.join(home, 'config.json'), CONFIG);
  fs.writeFileSync(path.join(home, 'hook.mjs'), 'old');
  fs.writeFileSync(path.join(home, 'version'), '1');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const listing = () => fs.readdirSync(root, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).sort();
const serve = (body: unknown, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const apply = (fetchFn: typeof fetch | (() => Promise<Response>)) =>
  applyUpdate({ home, settingsFile, nodePath: 'node-bin', fetchFn: fetchFn as typeof fetch, now: NOW });
const log = () => fs.readFileSync(path.join(home, 'capture.log'), 'utf8').trim().split('\n');

it('a newer version is written, hooks are re-applied and config.json is untouched', async () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }));
  const urls: string[] = [];
  const fetchFn = async (u: string) => { urls.push(u); return new Response(JSON.stringify({ version: '2', files: { 'hook.mjs': 'new', 'lib/a.mjs': 'a' } })); };
  expect(await apply(fetchFn as any)).toBe('updated');
  expect(urls).toEqual(['http://x/client.json']);
  expect(fs.readFileSync(path.join(home, 'hook.mjs'), 'utf8')).toBe('new');
  expect(fs.readFileSync(path.join(home, 'lib', 'a.mjs'), 'utf8')).toBe('a');
  expect(fs.readFileSync(path.join(home, 'version'), 'utf8')).toBe('2');
  expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).toBe(CONFIG);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  expect(settings.theme).toBe('dark');
  expect(settings.hooks.SessionStart[0].hooks[0]).toMatchObject({ command: 'node-bin', args: [path.join(home, 'hook.mjs'), 'session-start'] });
  expect(listing().filter((f) => f.endsWith('.tmp'))).toEqual([]);
});

it('the same version changes nothing', async () => {
  const before = listing();
  expect(await apply(serve({ version: '1', files: { 'hook.mjs': 'new' } }))).toBe('current');
  expect(fs.readFileSync(path.join(home, 'hook.mjs'), 'utf8')).toBe('old');
  expect(listing()).toEqual(before);
});

describe('a failure leaves the install as it was and logs one line', () => {
  const cases: Record<string, () => Promise<Response>> = {
    'fetch throws': async () => { throw new Error('offline'); },
    'HTTP 500': serve('boom', 500),
    'invalid JSON': serve('not json'),
    'no version': serve({ files: {} }),
    'non-string content': serve({ version: '2', files: { 'hook.mjs': 5 } }),
  };
  it.each(Object.keys(cases))('%s', async (name) => {
    const before = listing();
    expect(await apply(cases[name])).toBe('failed');
    expect(fs.readFileSync(path.join(home, 'hook.mjs'), 'utf8')).toBe('old');
    expect(listing()).toEqual([...before, 'home/capture.log'].sort());
    expect(log()).toHaveLength(1);
    expect(log()[0]).toContain('update failed');
  });
});

it.each(['../x', '/etc/x', 'C:\\x', 'a/../../x'])('refuses the path %s and writes nothing', async (bad) => {
  const before = listing();
  expect(await apply(serve({ version: '2', files: { 'ok.mjs': '1', [bad]: 'x' } }))).toBe('failed');
  expect(listing()).toEqual([...before, 'home/capture.log'].sort());
  expect(fs.readFileSync(path.join(home, 'version'), 'utf8')).toBe('1');
});

it('an invalid settings.json fails the update before any file is replaced', async () => {
  fs.writeFileSync(settingsFile, '{ nope');
  expect(await apply(serve({ version: '2', files: { 'hook.mjs': 'new' } }))).toBe('failed');
  expect(fs.readFileSync(path.join(home, 'hook.mjs'), 'utf8')).toBe('old');
  expect(fs.readFileSync(path.join(home, 'version'), 'utf8')).toBe('1');
  expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ nope');
  expect(listing().filter((f) => f.endsWith('.tmp'))).toEqual([]);
});

it('dueForUpdate: no file, 1 h ago, 25 h ago', () => {
  expect(dueForUpdate(home, NOW)).toBe(true);
  fs.writeFileSync(path.join(home, 'update-check.json'), JSON.stringify({ checkedAt: NOW - 3_600_000 }));
  expect(dueForUpdate(home, NOW)).toBe(false);
  fs.writeFileSync(path.join(home, 'update-check.json'), JSON.stringify({ checkedAt: NOW - 25 * 3_600_000 }));
  expect(dueForUpdate(home, NOW)).toBe(true);
  expect(UPDATE_EVERY_MS).toBe(86_400_000);
});

it('session-start in any folder spawns the updater, which records the check and the failure', async () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 't', folders: [] }));
  fs.cpSync(path.dirname(HOOK), home, { recursive: true });
  const input = JSON.stringify({ session_id: 's1', cwd: root });
  const r = spawnSync(process.execPath, [path.join(home, 'hook.mjs'), 'session-start'], { input, encoding: 'utf8', env: { ...process.env, SAMEPAGE_HOME: home, CLAUDE_CONFIG_DIR: path.dirname(settingsFile), SAMEPAGE_EXTRACTOR: '' } });
  expect(r.status).toBe(0);
  const logFile = path.join(home, 'capture.log');
  for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 100));
  expect(JSON.parse(fs.readFileSync(path.join(home, 'update-check.json'), 'utf8')).checkedAt).toBeGreaterThan(0);
  expect(fs.readFileSync(logFile, 'utf8')).toContain('update failed');
});

it('build writes client.json whose version matches the tarball and is stable for an unchanged tree', () => {
  const build = () => {
    const r = spawnSync(process.execPath, ['scripts/build-setup.mjs'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'client.json'), 'utf8'));
  };
  const first = build();
  const tar = spawnSync('tar', ['-xzOf', 'public/samepage-setup.tgz', 'package/package.json'], { cwd: ROOT, encoding: 'utf8' });
  expect(JSON.parse(tar.stdout).version).toBe(first.version);
  expect(first.version).toMatch(/^\d+\.\d+\.\d+-[0-9a-f]{8}$/);
  expect(JSON.parse(first.files['package.json']).version).toBe(first.version);
  expect(Object.keys(first.files)).toEqual(expect.arrayContaining(['hook.mjs', 'update.mjs', 'lib/settings.mjs']));
  expect(build().version).toBe(first.version);
}, 120_000);
