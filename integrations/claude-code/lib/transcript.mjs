import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MAX_EXCERPT_CHARS, MAX_MESSAGE_CHARS } from './limits.mjs';

/** @typedef {{ role: 'user' | 'agent', text: string }} Message */

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

/** @returns {string | null} text to keep, or null */
function clean(/** @type {string} */ raw) {
  const t = raw.replace(REMINDER, '').trim();
  if (!t || t.startsWith('<command-') || t.startsWith('<local-command') || t === '/private' || t === '/forget') return null;
  return t;
}

const textOf = (/** @type {any} */ content) =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
    : '';

/**
 * Reads transcript lines >= fromLine. Never logs or sends what it reads.
 * @param {string} file
 * @param {number} fromLine
 */
export function readTranscript(file, fromLine) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let endLine = lines.length;
  /** @type {Message[]} */ const messages = [];
  /** @type {string[]} */ const paths = [];
  let userCount = 0, chars = 0;
  /** @type {string | null} */ let gitBranch = null;
  /** @type {string | null} */ let cwd = null;
  for (let i = fromLine; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch {
      if (i === lines.length - 1) endLine = i; // partial write: retry on the next pass
      continue;
    }
    if (e?.gitBranch) gitBranch = e.gitBranch;
    if (e?.cwd) cwd = e.cwd;
    if (e?.isSidechain) continue;
    const content = e?.message?.content;
    if (e?.type === 'user' && !e.isMeta) {
      const text = clean(textOf(content));
      if (text) { messages.push({ role: 'user', text }); userCount++; chars += text.length; }
    } else if (e?.type === 'assistant') {
      const text = clean(textOf(content));
      if (text) { messages.push({ role: 'agent', text }); chars += text.length; }
      if (Array.isArray(content)) for (const b of content) {
        if (b?.type !== 'tool_use') continue;
        for (const k of PATH_KEYS) if (typeof b.input?.[k] === 'string') paths.push(b.input[k]);
      }
    }
  }
  return { messages, endLine, userCount, chars, paths, gitBranch, cwd };
}

/**
 * Where the work happened, like `web-app@feature/x`. Parent folders that hold several repos have
 * gitBranch HEAD, so the repo comes from the paths the agent touched.
 * @param {string | null} cwd
 * @param {string[]} paths
 * @param {string | null} gitBranch
 * @returns {string | null}
 */
export function branchHint(cwd, paths, gitBranch) {
  if (!cwd) return null;
  /** @type {Map<string, number>} */ const count = new Map();
  for (const p of paths) {
    const rel = path.relative(cwd, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const seg = rel.split(/[\\/]/)[0];
    count.set(seg, (count.get(seg) ?? 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) {
    const dir = path.join(cwd, top);
    if (fs.existsSync(path.join(dir, '.git'))) {
      try {
        const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (branch) return `${top}@${branch}`;
      } catch { /* fall through to the cwd-based hint */ }
    }
  }
  const base = path.basename(cwd);
  return gitBranch && gitBranch !== 'HEAD' ? `${base}@${gitBranch}` : base || null;
}

/**
 * Newest messages that fit, oldest first, one `[role] text` line each.
 * @param {Message[]} messages
 */
export function buildExcerpt(messages, maxChars = MAX_EXCERPT_CHARS, maxMessage = MAX_MESSAGE_CHARS) {
  /** @type {string[]} */ const out = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const l = `[${m.role}] ${m.text.slice(0, maxMessage)}`;
    if (size + l.length + (out.length ? 1 : 0) > maxChars) break;
    out.push(l);
    size += l.length + (out.length > 1 ? 1 : 0);
  }
  return out.reverse().join('\n');
}
