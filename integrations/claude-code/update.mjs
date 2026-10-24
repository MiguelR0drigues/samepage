#!/usr/bin/env node
// Applies the client published at <url>/client.json to this folder. Run by the session-start hook at most once a day.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeDir, samepageHome } from './lib/paths.mjs';
import { mergeHooks } from './lib/settings.mjs';
import { log, readConfig } from './lib/state.mjs';
import { readJsonObject } from './setup.mjs';

export const UPDATE_EVERY_MS = 86_400_000;

/** @param {string} home @param {number} now */
export function dueForUpdate(home, now) {
  try {
    const { checkedAt } = JSON.parse(fs.readFileSync(path.join(home, 'update-check.json'), 'utf8'));
    return !(Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt < UPDATE_EVERY_MS);
  } catch { return true; }
}

// what the build emits: package.json, top-level scripts, lib/**; so never config.json, sessions/, a stream (:) or a path outside home
const safePath = (/** @type {string} */ p) => /^(package\.json|[\w.-]+\.mjs|lib\/[\w./-]+)$/.test(p) && !p.split('/').some((seg) => !seg || seg === '.' || seg === '..');

/**
 * @param {{ home: string, settingsFile: string, nodePath: string, fetchFn?: typeof fetch, now: number }} o
 * @returns {Promise<'updated' | 'current' | 'failed'>}
 */
export async function applyUpdate({ home, settingsFile, nodePath, fetchFn = fetch }) {
  /** @type {string[]} */ const temps = [];
  /** @type {{ file: string, bak: string | null }[]} */ const done = [];
  try {
    const config = readConfig(home);
    if (!config) throw new Error('no config.json');
    const res = await fetchFn(`${config.url}/client.json`);
    if (!res.ok) throw new Error(`client.json answered ${res.status}`);
    const { version, files } = /** @type {any} */ (await res.json());
    if (typeof version !== 'string' || !version || !files || typeof files !== 'object' || Array.isArray(files)) throw new Error('client.json is malformed');
    for (const [p, content] of Object.entries(files)) if (!safePath(p) || typeof content !== 'string') throw new Error(`client.json has a bad entry: ${p}`);

    const versionFile = path.join(home, 'version');
    if (fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf8').trim() === version) return 'current';

    // read before anything is replaced: an invalid settings.json must fail the update, not half-apply it
    const hooks = JSON.stringify(mergeHooks(readJsonObject(settingsFile), nodePath, path.join(home, 'hook.mjs')), null, 2);
    /** @type {[string, string][]} */
    const writes = Object.entries(files).map(([p, content]) => [path.join(home, ...p.split('/')), content]);
    writes.push([settingsFile, hooks]);
    for (const [file, content] of writes) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      temps.push(tmp);
      fs.writeFileSync(tmp, content);
    }
    for (const [file] of writes) {
      // a copy, so the old file stays in place until the rename replaces it
      const bak = fs.existsSync(file) ? `${file}.${process.pid}.bak` : null;
      if (bak) { temps.push(bak); fs.copyFileSync(file, bak); }
      done.push({ file, bak });
      fs.renameSync(`${file}.${process.pid}.tmp`, file);
    }
    fs.writeFileSync(versionFile, version); // last: a failed update is retried
    for (const { bak } of done) if (bak) fs.rmSync(bak, { force: true });
    return 'updated';
  } catch (e) {
    // all or nothing: a new hook.mjs next to an old lib/ could fail to load and end every later update
    for (const { file, bak } of done.reverse()) {
      try { if (bak) fs.renameSync(bak, file); else fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    for (const t of temps) fs.rmSync(t, { force: true });
    try { log(home, `update failed: ${/** @type {Error} */ (e).message}`); } catch { /* nowhere to log */ }
    return 'failed';
  }
}

// realpath: matches setup.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const home = samepageHome();
  try {
    fs.writeFileSync(path.join(home, 'update-check.json'), JSON.stringify({ checkedAt: Date.now() }));
    await applyUpdate({ home, settingsFile: path.join(claudeDir(), 'settings.json'), nodePath: process.execPath, now: Date.now() });
  } catch { /* background job: nobody to tell */ }
}
