import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DAILY_LIMIT, LOCK_STALE_MS } from './limits.mjs';

/** @typedef {{ url: string, token: string, folders: string[], dailyLimit: number, claudePath: string | null }} Config */
/** @typedef {{ transcriptPath: string | null, cwd: string | null, lastActivity: number, processedLine: number, processedAt: number, skipUntilLine: number, private: boolean, notes: string[], notice: string | null }} SessionState */

const readJson = (/** @type {string} */ file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
// session ids come from hook input: keep them to a single safe file name
const safe = (/** @type {string} */ id) => id.replace(/[^\w.-]/g, '_');
const sessionFile = (/** @type {string} */ home, /** @type {string} */ id) => path.join(home, 'sessions', `${safe(id)}.json`);

/** @param {string} home @returns {Config | null} */
export function readConfig(home) {
  const c = readJson(path.join(home, 'config.json'));
  if (!c || typeof c.url !== 'string' || typeof c.token !== 'string') return null;
  return {
    url: c.url, token: c.token,
    folders: Array.isArray(c.folders) ? c.folders : [],
    dailyLimit: Number.isFinite(c.dailyLimit) ? c.dailyLimit : DEFAULT_DAILY_LIMIT,
    claudePath: typeof c.claudePath === 'string' ? c.claudePath : null,
  };
}

/** @returns {SessionState} */
const blankSession = () => ({
  transcriptPath: null, cwd: null, lastActivity: 0, processedLine: 0, processedAt: 0,
  skipUntilLine: 0, private: false, notes: [], notice: null,
});

/** @param {string} home @param {string} id @returns {SessionState} */
export function loadSession(home, id) {
  return { ...blankSession(), ...readJson(sessionFile(home, id)) };
}

/** @param {string} home @param {string} id @param {SessionState} s */
export function saveSession(home, id, s) {
  const file = sessionFile(home, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
}

/** @param {string} home @returns {string[]} */
export function listSessions(home) {
  try {
    return fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch { return []; }
}

/**
 * One pass per session at a time. Returns a release function, or null when the lock is held.
 * @param {string} home @param {string} id @param {number} [now]
 * @returns {(() => void) | null}
 */
export function takeLock(home, id, now = Date.now()) {
  const file = path.join(home, 'locks', safe(id));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const create = () => {
    try { fs.writeFileSync(file, String(now), { flag: 'wx' }); return true; } catch { return false; }
  };
  if (!create()) {
    const taken = Number(fs.readFileSync(file, 'utf8'));
    if (now - taken <= LOCK_STALE_MS) return null; // a lock with unreadable content (NaN) counts as stale
    try { fs.unlinkSync(file); } catch { /* another process replaced it */ }
    if (!create()) return null;
  }
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
}

const dayKey = (/** @type {number} */ now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** @param {string} home @param {number} now */
export function usageToday(home, now) {
  const u = readJson(path.join(home, 'usage.json'));
  return u?.day === dayKey(now) ? u.count : 0;
}

/** @param {string} home @param {number} now */
export function addUsage(home, now) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ day: dayKey(now), count: usageToday(home, now) + 1 }));
}

/** Never pass conversation text here. @param {string} home @param {string} line */
export function log(home, line) {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'capture.log'), `${new Date().toISOString()} ${line}\n`);
}
