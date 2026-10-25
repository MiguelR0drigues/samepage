import fs from 'node:fs';
import path from 'node:path';
import { MID_SESSION_EVERY, MIN_USER_MESSAGES, MIN_CHARS, SWEEP_IDLE_MS, SWEEP_MAX_AGE_MS } from './limits.mjs';
import { loadSession, saveSession, listSessions, takeLock, usageToday, addUsage, log } from './state.mjs';
import { readTranscript, branchHint, buildExcerpt } from './transcript.mjs';
import { SYSTEM_PROMPT, OUTPUT_SCHEMA, buildPrompt } from './policy.mjs';
import { sanitizeEnv, claudeCommand } from './claude.mjs';

/**
 * @typedef {{ home: string, config: import('./state.mjs').Config, env: Record<string, string | undefined>, fetch: typeof fetch, runClaude: (o: any) => Promise<unknown>, now: number }} PassDeps
 * @typedef {'skipped' | 'done' | 'failed'} PassResult
 */

// bounds a pass well under LOCK_STALE_MS when the network hangs (claude has its own timeout)
const FETCH_TIMEOUT_MS = 30_000;

// the apply schema rejects null for optional fields
const compact = (/** @type {any} */ o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/**
 * One extraction pass over the session's new messages. Only items and the update leave the machine.
 * @param {string} id
 * @param {'mid' | 'final'} mode
 * @param {PassDeps} deps
 * @returns {Promise<PassResult>}
 */
export async function runPass(id, mode, { home, config, env, fetch, runClaude, now }) {
  const release = takeLock(home, id);
  if (!release) return 'skipped';
  const tag = `${id.slice(0, 8)} ${mode}`;
  // reload before saving: hooks may have updated the session while the pass ran
  const save = (/** @type {object} */ patch) => saveSession(home, id, { ...loadSession(home, id), ...patch });
  try {
    const s = loadSession(home, id);
    if (s.private || !s.transcriptPath) return 'skipped';
    const start = Math.max(s.processedLine, s.skipUntilLine);
    const t = readTranscript(s.transcriptPath, start);
    // a final pass after earlier passes still goes to the model, for the session update
    const owesUpdate = mode === 'final' && s.notes.length > 0;
    if (!t.messages.length && !owesUpdate) return 'skipped';
    if (mode === 'mid' && t.userCount < MID_SESSION_EVERY) return 'skipped';
    if ((t.userCount < MIN_USER_MESSAGES || t.chars < MIN_CHARS) && !owesUpdate) {
      if (mode !== 'final') return 'skipped';
      save({ processedLine: t.endLine, processedAt: now });
      return 'done';
    }
    if (!config.claudeToken) { log(home, `${tag}: no Claude token (run setup again)`); return 'skipped'; }
    if (usageToday(home, now) >= config.dailyLimit) { log(home, `${tag}: daily limit reached`); return 'skipped'; }
    addUsage(home, now);

    const url = config.url.replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
    const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let context;
    try {
      const res = await fetch(`${url}/extractor/context`, { headers, signal: signal() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      context = await res.json();
    } catch (e) { log(home, `${tag}: context failed: ${/** @type {Error} */ (e).message}`); return 'failed'; }

    const hint = branchHint(t.cwd ?? s.cwd, t.paths, t.gitBranch);
    const work = path.join(home, 'work');
    const systemPromptFile = path.join(work, 'policy.md');
    /** @type {any} */ let out;
    try {
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(systemPromptFile, SYSTEM_PROMPT);
      out = await runClaude({
        command: claudeCommand(env, config),
        prompt: buildPrompt({ context, excerpt: buildExcerpt(t.messages), branchHint: hint, notes: s.notes, wantUpdate: mode === 'final' }),
        systemPromptFile, schema: OUTPUT_SCHEMA, cwd: work, env: sanitizeEnv(env, config.claudeToken),
      });
      if (!Array.isArray(out?.items)) throw new Error('output has no items array');
    } catch (e) { log(home, `${tag}: claude failed: ${/** @type {Error} */ (e).message}`); return 'failed'; }

    const items = out.items.map(compact);
    const body = {
      ...compact({ session_ref: `claude_code:${id}`, branch_hint: hint }), items,
      update: mode === 'final' && out.update ? compact(out.update) : null,
    };
    const latest = loadSession(home, id);
    if (latest.private || latest.skipUntilLine > start) { log(home, `${tag}: dropped (privacy command during pass)`); return 'skipped'; }
    /** @type {{ recorded: string[], proposals: string[], pending: { id: string, question: string }[], update: string | null }} */ let r;
    try {
      const res = await fetch(`${url}/extractor/apply`, { method: 'POST', headers, body: JSON.stringify(body), signal: signal() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      r = await res.json();
    } catch (e) { log(home, `${tag}: apply failed: ${/** @type {Error} */ (e).message}`); return 'failed'; }

    // the final update has summarized the notes: a later final with nothing new sends no second update
    const notes = mode === 'final' ? [] : typeof out.progress === 'string' && out.progress ? [...s.notes, out.progress].slice(-10) : s.notes;
    /** @type {Record<string, unknown>} */ const patch = { processedLine: t.endLine, processedAt: now, notes };
    if (mode === 'mid' && r.pending?.length) {
      const asks = r.pending.map((p) => `[${p.id}] ${p.question}`).join('; ');
      patch.notice = `SamePage has a question for you (answer with the SamePage tool answer_pending): ${asks}`
        + ' If answer_pending is not among your SamePage tools (this session connected before SamePage was updated), tell the user the question will come back at the start of their next session.';
    }
    save(patch);
    log(home, `${tag}: recorded ${r.recorded?.length ?? 0}, proposals ${r.proposals?.length ?? 0}, pending ${r.pending?.length ?? 0}, update ${r.update ? 'yes' : 'no'}`);
    return 'done';
  } finally {
    release();
  }
}

/**
 * /off-record: asks the server to remove what this session already added. Until it succeeds the
 * session stays offRecordPending and the next sweep tries again.
 * @param {string} id
 * @param {PassDeps} deps
 * @returns {Promise<PassResult>}
 */
export async function forgetSession(id, { home, config, fetch }) {
  // a pass holding the lock may be past its privacy check and still applying: retry after it
  const release = takeLock(home, id);
  if (!release) return 'skipped';
  const tag = `${id.slice(0, 8)} off-record`;
  try {
    const res = await fetch(`${config.url.replace(/\/+$/, '')}/extractor/forget-session`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_ref: `claude_code:${id}` }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    saveSession(home, id, { ...loadSession(home, id), offRecordPending: false });
    log(home, `${tag}: removed ${r.removed ?? 0}, kept ${r.kept ?? 0}, pending ${r.pending ?? 0}`);
    return 'done';
  } catch (e) { log(home, `${tag}: failed: ${/** @type {Error} */ (e).message}`); return 'failed'; } finally {
    release();
  }
}

/**
 * Final passes for other sessions that went idle without SessionEnd, one at a time.
 * @param {string} currentId
 * @param {PassDeps} deps
 * @param {(id: string, mode: 'final', deps: PassDeps) => Promise<PassResult>} [pass]
 */
export async function sweep(currentId, deps, pass = runPass, forget = forgetSession) {
  const { home, now } = deps;
  for (const id of listSessions(home)) {
    if (id === currentId) continue;
    const s = loadSession(home, id);
    if (s.offRecordPending) { await forget(id, deps); continue; }
    const idle = now - s.lastActivity;
    if (s.lastActivity <= s.processedAt || idle < SWEEP_IDLE_MS || idle > SWEEP_MAX_AGE_MS) continue;
    try { await pass(id, 'final', deps); } catch (e) { log(home, `${id.slice(0, 8)} sweep: ${/** @type {Error} */ (e).message}`); }
  }
}
