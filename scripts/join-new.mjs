import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Sets a fresh JOIN_CODE secret (the old link stops working) and prints the new link.
const code = randomBytes(24).toString('hex');
const r = spawnSync('npx', ['wrangler', 'secret', 'put', 'JOIN_CODE'], { input: code, stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status ?? 1);
const url = process.env.SAMEPAGE_URL ?? 'https://samepage.scooli.workers.dev';
console.log(`Team join link (share it with the team; running this again replaces it): ${url}/join/${code}`);
