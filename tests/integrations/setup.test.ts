import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, parseFolders, findClaude, findNode, joinTeam, readJsonObject, loginWindowCommand, defaultFolders, loginWindowEnv, newerInstaller } from '../../integrations/claude-code/setup.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-setup-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const refused = (p: string) => `Refusing ${p}: choose the folder that holds company work, not the whole home or drive.`;

it('parseFolders resolves existing folders separated by ;', () => {
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  expect(parseFolders(` ${path.join(dir, 'a')} ; ${path.join(dir, 'b')};`, path.join(dir, 'home'))).toEqual([path.join(dir, 'a'), path.join(dir, 'b')]);
});

it('parseFolders refuses no folders, the home folder, a drive root and missing folders', () => {
  expect(() => parseFolders('', dir)).toThrow(/^No folders given\.$/);
  expect(() => parseFolders(' ; ', dir)).toThrow(/^No folders given\.$/);
  expect(() => parseFolders(dir + path.sep, dir)).toThrow(refused(dir));
  const root = path.parse(dir).root;
  expect(() => parseFolders(root, dir)).toThrow(refused(root));
  expect(() => parseFolders(path.join(dir, 'nope'), path.join(dir, 'home'))).toThrow(`Folder not found: ${path.join(dir, 'nope')}`);
});

it('findNode takes the node on PATH (preferring .exe on Windows), else this process', () => {
  const plain = path.join(dir, 'node');
  const exe = path.join(dir, 'node.exe');
  fs.writeFileSync(plain, '');
  fs.writeFileSync(exe, '');
  expect(findNode(() => [plain, exe], 'win32')).toBe(exe);
  expect(findNode(() => [plain, exe], 'linux')).toBe(plain);
  expect(findNode(() => [path.join(dir, 'missing')], 'linux')).toBe(process.execPath);
  expect(findNode(() => [dir], 'linux')).toBe(process.execPath);
  expect(findNode(() => [], 'linux')).toBe(process.execPath);
});

it('readJsonObject strips a leading BOM', () => {
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '\uFEFF{"model":"opus"}');
  expect(readJsonObject(f)).toEqual({ model: 'opus' });
});

it('parseArgs reads --join, --name, --same-person and --login; a token with --join is refused', () => {
  expect(parseArgs([])).toMatchObject({ join: null, name: null, samePerson: false, login: false });
  expect(parseArgs(['--join', 'dev', '--name', 'Ana Silva', '--same-person', '--login'])).toMatchObject({ token: null, join: 'dev', name: 'Ana Silva', samePerson: true, login: true });
  expect(() => parseArgs(['tok', '--join', 'dev'])).toThrow('Use either a token or --join, not both.');
  expect(() => parseArgs(['--join', 'dev', 'tok'])).toThrow('Use either a token or --join, not both.');
  expect(() => parseArgs(['--name'])).toThrow(/--name needs a value/);
});

it('findClaude prefers an existing claude* CLAUDE_CODE_EXECPATH, else the PATH lookup', () => {
  const app = path.join(dir, 'Claude.exe');
  const other = path.join(dir, 'node.exe');
  fs.writeFileSync(app, '');
  fs.writeFileSync(other, '');
  const onPath = () => ['C:\bin\claude.cmd'];
  expect(findClaude({ CLAUDE_CODE_EXECPATH: app }, onPath, 'win32')).toBe(app);
  expect(findClaude({ CLAUDE_CODE_EXECPATH: path.join(dir, 'claude-missing') }, onPath, 'win32')).toBe('C:\bin\claude.cmd');
  expect(findClaude({ CLAUDE_CODE_EXECPATH: other }, onPath, 'win32')).toBe('C:\bin\claude.cmd');
  expect(findClaude({}, () => [], 'linux')).toBeNull();
});

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

it('joinTeam returns the token on 201/200 and sends the code, name and existing flag', async () => {
  let sent: any;
  const f = (async (u: string, init: RequestInit) => { sent = { u, body: JSON.parse(String(init.body)) }; return new Response(JSON.stringify({ id: 'ana-silva', name: 'Ana Silva', token: 'tok', created: true }), { status: 201 }); }) as unknown as typeof fetch;
  expect(await joinTeam('http://x', 'dev', 'Ana Silva', true, f)).toEqual({ token: 'tok', name: 'Ana Silva' });
  expect(sent).toEqual({ u: 'http://x/join', body: { code: 'dev', name: 'Ana Silva', existing: true } });
  expect(await joinTeam('http://x', 'dev', 'Ana Silva', true, reply(200, { name: 'Ana Silva', token: 't2', created: false }))).toEqual({ token: 't2', name: 'Ana Silva' });
});

it('joinTeam reports a taken name, the server error on 400/403 and an unreachable server', async () => {
  expect(await joinTeam('http://x', 'dev', 'ana', false, reply(409, { id: 'ana', name: 'Ana Silva' }))).toEqual({ taken: 'Ana Silva' });
  await expect(joinTeam('http://x', 'bad', 'ana', false, reply(403, { error: 'invalid join code' }))).rejects.toThrow(/^invalid join code$/);
  await expect(joinTeam('http://x', 'dev', '!!', false, reply(400, { error: 'name needs letters or digits' }))).rejects.toThrow(/^name needs letters or digits$/);
  await expect(joinTeam('http://x', 'dev', 'a', false, (async () => { throw new Error('boom'); }) as typeof fetch)).rejects.toThrow(/^Could not reach http:\/\/x\.$/);
});

it('joinTeam names the requested name when a 409 has no name, and fails on a success without a token', async () => {
  expect(await joinTeam('http://x', 'dev', 'ana', false, reply(409, {}))).toEqual({ taken: 'ana' });
  await expect(joinTeam('http://x', 'dev', 'ana', false, reply(201, { name: 'Ana' }))).rejects.toThrow(/^The server did not return a token\.$/);
});

it('loginWindowCommand opens a terminal per platform, null elsewhere', () => {
  const node = String.raw`C:\Program Files\node.exe`, login = String.raw`C:\h\login.mjs`;
  const win = loginWindowCommand('win32', node, login)!;
  expect(win.cmd).toBe('cmd.exe');
  expect(win.args).toEqual(['/c', 'start', '"SamePage login"', `"${node}"`, `"${login}"`]);
  const mac = loginWindowCommand('darwin', '/usr/bin/node', "/Users/o'neil/.samepage/login.mjs")!;
  expect(mac.cmd).toBe('osascript');
  expect(mac.args).toEqual(['-e', String.raw`tell application "Terminal" to do script "'/usr/bin/node' '/Users/o'\\''neil/.samepage/login.mjs'"`]);
  expect(loginWindowCommand('linux', '/usr/bin/node', '/h/login.mjs')).toEqual({ cmd: 'x-terminal-emulator', args: ['-e', '/usr/bin/node', '/h/login.mjs'] });
  expect(loginWindowCommand('freebsd', 'n', 'l')).toBeNull();
});

it('loginWindowEnv drops CLAUDE* and ANTHROPIC_* but keeps CLAUDE_CONFIG_DIR, SAMEPAGE_HOME and the rest', () => {
  expect(loginWindowEnv({ CLAUDECODE: '1', CLAUDE_CODE_EXECPATH: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', SAMEPAGE_HOME: '/h', PATH: '/bin' }))
    .toEqual({ CLAUDE_CONFIG_DIR: '/c', SAMEPAGE_HOME: '/h', PATH: '/bin' });
});

it('defaultFolders offers the stored folders, else the current folder', () => {
  expect(defaultFolders(['/a', '/b'], '/cwd')).toBe('/a; /b');
  expect(defaultFolders([], '/cwd')).toBe('/cwd');
});

it('newerInstaller returns the server version only when it differs and looks like a version', async () => {
  const served = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  expect(await newerInstaller('http://x', '0.3.0-aaaa', served(200, '0.3.0-bbbb\n'))).toBe('0.3.0-bbbb');
  expect(await newerInstaller('http://x', '0.3.0-aaaa', served(200, '0.3.0-aaaa'))).toBeNull();
  expect(await newerInstaller('http://x', '0.3.0-aaaa', served(404, '0.3.0-bbbb'))).toBeNull();
  expect(await newerInstaller('http://x', '0.3.0-aaaa', served(200, '1.0 & calc'))).toBeNull();
  expect(await newerInstaller('http://x', '0.3.0-aaaa', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
});
