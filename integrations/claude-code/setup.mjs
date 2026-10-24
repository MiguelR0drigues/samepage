#!/usr/bin/env node
// samepage-setup <token>: connects Claude Code to SamePage and turns on session capture.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeDir, samepageHome } from './lib/paths.mjs';
import { ask, askYesNo } from './lib/prompt.mjs';
import { mergeHooks, removeHooks } from './lib/settings.mjs';
import { readConfig, writeConfig } from './lib/state.mjs';
import { runLogin } from './login.mjs';

const DEFAULT_URL = 'https://samepage.scooli.workers.dev';
const USAGE = 'Usage: samepage-setup <token> | --join <code> [--name "<name>"] [--same-person] [--url <url>] [--folders "<a>;<b>"] [--claude-token <t>] [--uninstall] | --login';
const TAKEN = (/** @type {string} */ name) => `A member named ${name} already exists. If that is you (another computer), run again with --same-person. If not, run again with a different --name, e.g. "${name} (Marketing)".`;

class Fail extends Error {}

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, uninstall: boolean, token: string | null, url: string, folders: string | null, claudeToken: string | null, join: string | null, name: string | null, samePerson: boolean, login: boolean }}
 */
export function parseArgs(argv) {
  const out = {
    help: false, uninstall: false, token: /** @type {string | null} */ (null), url: DEFAULT_URL, folders: /** @type {string | null} */ (null), claudeToken: /** @type {string | null} */ (null),
    join: /** @type {string | null} */ (null), name: /** @type {string | null} */ (null), samePerson: false, login: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--same-person') out.samePerson = true;
    else if (a === '--login') out.login = true;
    else if (a === '--url' || a === '--folders' || a === '--claude-token' || a === '--join' || a === '--name') {
      const v = argv[++i];
      if (v === undefined) throw new Fail(`${a} needs a value.\n${USAGE}`);
      if (a === '--url') out.url = v.replace(/\/+$/, '');
      else if (a === '--folders') out.folders = v;
      else if (a === '--join') out.join = v;
      else if (a === '--name') out.name = v;
      else out.claudeToken = v;
    } else if (a.startsWith('-') || out.token) throw new Fail(`Unexpected argument: ${a}\n${USAGE}`);
    else out.token = a;
  }
  if (out.token && out.join) throw new Fail('Use either a token or --join, not both.');
  return out;
}

const win = process.platform === 'win32';
export const readJsonObject = (/** @type {string} */ file) => {
  if (!fs.existsSync(file)) return {};
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // editors on Windows may add a BOM
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* falls through */ }
  throw new Fail(`${file} is not valid JSON. Fix it and run setup again.`);
};

/** @param {string} name @returns {string[]} */
function which(name) {
  try {
    return (win ? execFileSync('where', [name], { encoding: 'utf8' }) : execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }))
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * The claude binary: the one running this session (CLAUDE_CODE_EXECPATH, e.g. the desktop app's), else claude on PATH.
 * @param {NodeJS.ProcessEnv} [env] @param {(name: string) => string[]} [lookup] @param {string} [platform]
 * @returns {string | null}
 */
export function findClaude(env = process.env, lookup = which, platform = process.platform) {
  const own = env.CLAUDE_CODE_EXECPATH;
  if (own && /^claude/i.test(path.basename(own)) && fs.statSync(own, { throwIfNoEntry: false })?.isFile()) return own;
  const lines = lookup('claude');
  return (platform === 'win32' && lines.find((l) => /\.(exe|cmd|bat)$/i.test(l))) || lines[0] || null;
}

/**
 * The node on PATH, so the hooks survive a Node upgrade that moves the binary; else this process's node.
 * @param {(name: string) => string[]} [lookup] @param {string} [platform]
 */
export function findNode(lookup = which, platform = process.platform) {
  const lines = lookup('node');
  const p = (platform === 'win32' && lines.find((l) => /\.exe$/i.test(l))) || lines[0];
  return p && fs.statSync(p, { throwIfNoEntry: false })?.isFile() ? p : process.execPath;
}

/**
 * Company folders from a `;`-separated answer. Never the whole home folder or a drive root.
 * @param {string} answer @param {string} [home]
 * @returns {string[]}
 */
export function parseFolders(answer, home = os.homedir()) {
  const folders = answer.split(';').map((f) => f.trim()).filter(Boolean).map((f) => path.resolve(f));
  if (!folders.length) throw new Fail('No folders given.');
  for (const f of folders) {
    if (path.parse(f).root === f || path.relative(home, f) === '') throw new Fail(`Refusing ${f}: choose the folder that holds company work, not the whole home or drive.`);
    if (!fs.existsSync(f)) throw new Fail(`Folder not found: ${f}`);
  }
  return folders;
}

/**
 * The company folders offered as the default answer: the stored ones on a re-run, else the current folder.
 * @param {string[]} stored @param {string} cwd
 */
export const defaultFolders = (stored, cwd) => (stored.length ? stored.join('; ') : cwd);

/**
 * The command that opens a terminal window running the login helper, or null where there is no way to.
 * @param {string} platform @param {string} nodePath @param {string} loginPath
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function loginWindowCommand(platform, nodePath, loginPath) {
  if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/c', 'start', '"SamePage login"', `"${nodePath}"`, `"${loginPath}"`] };
  if (platform === 'darwin') {
    const sh = [nodePath, loginPath].map((p) => `'${p.replace(/'/g, String.raw`'\''`)}'`).join(' ');
    return { cmd: 'osascript', args: ['-e', `tell application "Terminal" to do script "${sh.replace(/[\\"]/g, '\\$&')}"`] };
  }
  if (platform === 'linux') return { cmd: 'x-terminal-emulator', args: ['-e', nodePath, loginPath] };
  return null;
}

/**
 * Joins the team and returns the new token, or the existing member's name when it is taken.
 * @param {string} url @param {string} code @param {string} name @param {boolean} existing @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ token: string, name: string } | { taken: string }>}
 */
export async function joinTeam(url, code, name, existing, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(`${url}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, existing }) });
  } catch { throw new Fail(`Could not reach ${url}.`); }
  const body = /** @type {any} */ (await res.json().catch(() => ({})));
  if (res.status === 409) return { taken: body.name ?? name };
  if (res.status !== 200 && res.status !== 201) throw new Fail(body.error ?? `Joining failed (${res.status}).`);
  if (typeof body.token !== 'string') throw new Fail('The server did not return a token.');
  return { token: body.token, name: body.name };
}

/** @param {string} url @param {string} token @param {typeof fetch} [fetchFn] */
export async function tokenAccepted(url, token, fetchFn = fetch) {
  try { return (await fetchFn(`${url}/summary`, { headers: { authorization: `Bearer ${token}` } })).status === 200; } catch { throw new Fail(`Could not reach ${url}.`); }
}

// A .cmd/.bat binary needs a shell, which joins the args as text: quote them. Errors never carry the command line (it holds tokens).
export function runClaude(/** @type {string} */ claude, /** @type {string[]} */ args, /** @type {import('node:child_process').ExecFileSyncOptions} */ opts = {}) {
  const shell = /\.(cmd|bat)$/i.test(claude);
  execFileSync(shell ? `"${claude}"` : claude, shell ? args.map((a) => `"${a}"`) : args, { stdio: 'ignore', windowsHide: true, ...opts, shell });
}

/** @param {ReturnType<typeof parseArgs>} args @returns {Promise<string>} */
async function joinToken(args) {
  const tty = !!process.stdin.isTTY;
  let name = args.name ?? (tty ? await ask('Your name: ') : null);
  if (!name) throw new Fail('--name is required when there is no terminal.');
  let existing = args.samePerson;
  for (;;) {
    const r = await joinTeam(args.url, /** @type {string} */ (args.join), name, existing);
    if ('token' in r) return r.token;
    if (!tty) throw new Fail(TAKEN(r.taken));
    if (await askYesNo(`A member named ${r.taken} already exists. Is that you? (y/n) `)) existing = true;
    else for (name = ''; !name;) name = await ask('Your name: ');
  }
}

// every top-level script: login.mjs runs from the home folder and imports setup.mjs
function copyClient(/** @type {string} */ home) {
  const src = path.dirname(fileURLToPath(import.meta.url));
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.mjs'))) fs.copyFileSync(path.join(src, f), path.join(home, f));
  fs.cpSync(path.join(src, 'lib'), path.join(home, 'lib'), { recursive: true });
}

/** Approves the Claude login: inline in a terminal, else in a new window the installer does not wait for. */
async function login(/** @type {string} */ home, /** @type {string} */ claude, /** @type {string} */ url) {
  if (process.stdin.isTTY) { await runLogin(home, claude); return; }
  const w = loginWindowCommand(process.platform, findNode(), path.join(home, 'login.mjs'));
  const opened = w && await new Promise((resolve) => {
    const child = spawn(w.cmd, w.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
  console.log(opened
    ? 'A window opened to approve your Claude login; capture turns on as soon as you approve.'
    : `To turn on capture, run in a terminal: npx -y ${url}/samepage-setup.tgz --login`);
}

/** @param {ReturnType<typeof parseArgs>} args */
async function install(args) {
  const { url } = args;
  const home = samepageHome();
  const settingsFile = path.join(claudeDir(), 'settings.json');

  if (Number(process.versions.node.split('.')[0]) < 22) throw new Fail(`Node 22 or newer is required (this is ${process.versions.node}).`);
  const claude = findClaude();
  if (!claude) throw new Fail('Install Claude Code first: https://code.claude.com/docs');

  const previous = readConfig(home);
  const fallback = defaultFolders(previous?.folders ?? [], process.cwd());
  const folders = parseFolders(args.folders ?? (process.stdin.isTTY ? (await ask(`Which folders hold company work? Capture runs only there (separate several with ;) [${fallback}]: `)) || fallback : fallback));

  const settings = readJsonObject(settingsFile); // before anything is written
  let token = args.token;
  if (token) {
    if (!(await tokenAccepted(url, token))) throw new Fail(`This token was rejected by ${url}.`);
  } else if (previous && await tokenAccepted(url, previous.token)) token = previous.token;
  else if (args.join) token = await joinToken(args);
  else throw new Fail(USAGE);

  // written before the steps that can fail, so a retry reuses this token instead of joining again
  fs.mkdirSync(home, { recursive: true });
  const claudeToken = args.claudeToken ?? previous?.claudeToken ?? null;
  writeConfig(home, { url, token, folders, claudePath: claude, claudeToken });
  copyClient(home);
  if (!claudeToken) await login(home, claude, url);

  const backup = `${settingsFile}.samepage-backup`;
  if (fs.existsSync(settingsFile) && !fs.existsSync(backup)) fs.copyFileSync(settingsFile, backup);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(mergeHooks(settings, findNode(), path.join(home, 'hook.mjs')), null, 2));

  try { runClaude(claude, ['mcp', 'remove', 'samepage', '-s', 'user']); } catch { /* not registered yet */ }
  try {
    runClaude(claude, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'samepage', `${url}/mcp`, '--header', `Authorization: Bearer ${token}`]);
  } catch { throw new Fail('Could not register SamePage with Claude Code ("claude mcp add" failed).'); }

  console.log(`SamePage is set up. Capture runs in: ${folders.join('; ')}. Type /private in a session to skip it, /forget to drop what was not captured yet. Undo: npx -y ${url}/samepage-setup.tgz --uninstall`);
}

async function loginOnly() {
  const home = samepageHome();
  const config = readConfig(home);
  const claude = config?.claudePath ?? findClaude();
  if (!config || !claude) throw new Fail('Run setup first.');
  copyClient(home); // an older install may lack login.mjs
  await login(home, claude, config.url);
}

async function uninstall() {
  const home = samepageHome();
  const settingsFile = path.join(claudeDir(), 'settings.json');
  if (fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify(removeHooks(readJsonObject(settingsFile), path.join(home, 'hook.mjs')), null, 2));
  const claude = findClaude();
  if (claude) try { runClaude(claude, ['mcp', 'remove', 'samepage', '-s', 'user']); } catch { /* not registered */ }
  fs.rmSync(home, { recursive: true, force: true });
  console.log('SamePage removed: hooks, MCP connection and local data.');
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return console.log(USAGE);
    if (args.uninstall) return await uninstall();
    if (args.login && !args.token && !args.join) await loginOnly();
    else await install(args);
  } catch (e) {
    console.error(e instanceof Fail ? e.message : `Setup failed: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}

// realpath: npx runs this through a symlink on POSIX
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
