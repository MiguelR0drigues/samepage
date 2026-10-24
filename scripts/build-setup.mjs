// Packs integrations/claude-code into public/samepage-setup.tgz (served by the Worker's static assets).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

fs.mkdirSync('public', { recursive: true });
const win = process.platform === 'win32';
const out = execFileSync(win ? 'npm.cmd' : 'npm', ['pack', './integrations/claude-code', '--pack-destination', 'public', '--silent'], { encoding: 'utf8', shell: win });
const name = out.trim().split(/\r?\n/).pop();
if (!name) throw new Error('npm pack printed no file name');
fs.renameSync(`public/${name}`, 'public/samepage-setup.tgz');
console.log('public/samepage-setup.tgz');
