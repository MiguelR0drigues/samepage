// Packs integrations/claude-code into public/samepage-setup.tgz and lists the same files in public/client.json
// (both served by the Worker's static assets). The version is <base>-<hash of the files>, so nobody bumps it by hand.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = 'integrations/claude-code';
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'samepage-build-'));
try {
  const pkg = JSON.parse(fs.readFileSync(`${SRC}/package.json`, 'utf8'));
  const base = pkg.version;
  delete pkg.version;
  const paths = [...fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs')),
    ...fs.readdirSync(`${SRC}/lib`, { recursive: true }).map((f) => `lib/${String(f).split(path.sep).join('/')}`).filter((f) => fs.statSync(`${SRC}/${f}`).isFile())];
  /** @type {Record<string, string>} */
  const files = { 'package.json': JSON.stringify(pkg), ...Object.fromEntries(paths.map((p) => [p, fs.readFileSync(`${SRC}/${p}`, 'utf8')])) };
  const hash = crypto.createHash('sha256');
  for (const p of Object.keys(files).sort()) hash.update(`${p}\0${files[p]}`);
  const version = `${base}-${hash.digest('hex').slice(0, 8)}`;
  files['package.json'] = JSON.stringify({ ...pkg, version });

  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(stage, p)), { recursive: true });
    fs.writeFileSync(path.join(stage, p), content);
  }
  const win = process.platform === 'win32';
  const out = execFileSync(win ? 'npm.cmd' : 'npm', ['pack', '--silent'], { cwd: stage, encoding: 'utf8', shell: win });
  const name = out.trim().split(/\r?\n/).pop();
  if (!name) throw new Error('npm pack printed no file name');
  fs.mkdirSync('public', { recursive: true });
  fs.copyFileSync(path.join(stage, name), 'public/samepage-setup.tgz');
  fs.writeFileSync('public/client.json', JSON.stringify({ version, files }));
  console.log(`public/samepage-setup.tgz, public/client.json (${version})`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
