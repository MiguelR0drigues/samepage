#!/usr/bin/env node
// samepage-setup <token>: connects Claude Code to SamePage and turns on session capture.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeDir, samepageHome } from './lib/paths.mjs';
import { mergeHooks, removeHooks } from './lib/settings.mjs';
import { readConfig, writeConfig } from './lib/state.mjs';

const DEFAULT_URL = 'https://samepage.scooli.workers.dev';
const USAGE = 'Usage: samepage-setup <token> [--url <url>] [--folders "<a>;<b>"] [--claude-token <t>] [--uninstall]';

class Fail extends Error {}

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, uninstall: boolean, token: string | null, url: string, folders: string | null, claudeToken: string | null }}
 */
export function parseArgs(argv) {
  const out = { help: false, uninstall: false, token: /** @type {string | null} */ (null), url: DEFAULT_URL, folders: /** @type {string | null} */ (null), claudeToken: /** @type {string | null} */ (null) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--url' || a === '--folders' || a === '--claude-token') {
      const v = argv[++i];
      if (v === undefined) throw new Fail(`${a} needs a value.\n${USAGE}`);
      if (a === '--url') out.url = v.replace(/\/+$/, '');
      else if (a === '--folders') out.folders = v;
      else out.claudeToken = v;
    } else if (a.startsWith('-') || out.token) throw new Fail(`Unexpected argument: ${a}\n${USAGE}`);
    else out.token = a;
  }
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

/** @returns {string | null} */
function findClaude() {
  const lines = which('claude');
  return (win && lines.find((l) => /\.(exe|cmd|bat)$/i.test(l))) || lines[0] || null;
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

// A .cmd/.bat binary needs a shell, which joins the args as text: quote them. Errors never carry the command line (it holds tokens).
function runClaude(/** @type {string} */ claude, /** @type {string[]} */ args, /** @type {import('node:child_process').ExecFileSyncOptions} */ opts = {}) {
  const shell = /\.(cmd|bat)$/i.test(claude);
  execFileSync(shell ? `"${claude}"` : claude, shell ? args.map((a) => `"${a}"`) : args, { stdio: 'ignore', windowsHide: true, ...opts, shell });
}

/** @param {string} prompt */
async function askHidden(prompt) {
  process.stdout.write(`${prompt} `);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin });
    const answer = await rl.question('');
    rl.close();
    return answer.trim();
  }
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); };
    const onData = (/** @type {string} */ chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); return resolve(value.trim()); }
        if (ch === '\u0003') { finish(); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** @param {string} prompt */
async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

/** @param {ReturnType<typeof parseArgs>} args */
async function install(args) {
  const { url } = args;
  const token = /** @type {string} */ (args.token);
  const home = samepageHome();
  const settingsFile = path.join(claudeDir(), 'settings.json');

  if (Number(process.versions.node.split('.')[0]) < 22) throw new Fail(`Node 22 or newer is required (this is ${process.versions.node}).`);
  const claude = findClaude();
  if (!claude) throw new Fail('Install Claude Code first: https://code.claude.com/docs');

  let status;
  try { status = (await fetch(`${url}/summary`, { headers: { authorization: `Bearer ${token}` } })).status; } catch { throw new Fail(`Could not reach ${url}.`); }
  if (status !== 200) throw new Fail(`This token was rejected by ${url}.`);

  let answer = args.folders;
  while (answer === null) {
    const a = await ask('Which folders hold company work? Capture runs only there (separate several with ;): ');
    if (a || !process.stdin.isTTY) answer = a;
  }
  const folders = parseFolders(answer);

  const settings = readJsonObject(settingsFile); // before anything is written
  let claudeToken = args.claudeToken ?? readConfig(home)?.claudeToken ?? null;
  if (!claudeToken) {
    console.log('Capture uses your own Claude subscription. Claude will now create a long-lived token for it (setup-token):');
    try { runClaude(claude, ['setup-token'], { stdio: 'inherit' }); } catch { /* it printed its own error; an empty answer below keeps capture off */ }
    claudeToken = await askHidden('Paste the token it printed (starts with sk-ant-):') || null;
    if (!claudeToken) console.warn('Capture stays off until you run setup again.');
  }

  const src = path.dirname(fileURLToPath(import.meta.url));
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['hook.mjs', 'extract.mjs']) fs.copyFileSync(path.join(src, f), path.join(home, f));
  fs.cpSync(path.join(src, 'lib'), path.join(home, 'lib'), { recursive: true });
  writeConfig(home, { url, token, folders, claudePath: claude, claudeToken });

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
    if (!args.token) throw new Fail(USAGE);
    await install(args);
  } catch (e) {
    console.error(e instanceof Fail ? e.message : `Setup failed: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}

// realpath: npx runs this through a symlink on POSIX
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
