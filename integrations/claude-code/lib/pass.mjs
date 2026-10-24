import fs from 'node:fs';
import path from 'node:path';
import { MID_SESSION_EVERY, MIN_USER_MESSAGES, MIN_CHARS, MAX_ITEMS, SWEEP_IDLE_MS, SWEEP_MAX_AGE_MS } from './limits.mjs';
import { loadSession, saveSession, listSessions, takeLock, usageToday, addUsage, log } from './state.mjs';
import { readTranscript, branchHint, buildExcerpt } from './transcript.mjs';
import { SYSTEM_PROMPT, OUTPUT_SCHEMA, buildPrompt } from './policy.mjs';
import { sanitizeEnv, claudeCommand } from './claude.mjs';

/**
 * @typedef {{ home: string, config: import('./state.mjs').Config, env: Record<string, string | undefined>, fetch: typeof fetch, runClaude: (o: any) => Promise<unknown>, now: number }} PassDeps
 * @typedef {'skipped' | 'done' | 'failed'} PassResult
 */

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
    const t = readTranscript(s.transcriptPath, Math.max(s.processedLine, s.skipUntilLine));
    if (!t.messages.length) return 'skipped';
    if (mode === 'mid' && t.messages.length < MID_SESSION_EVERY) return 'skipped';
    // a tiny final tail after earlier passes still goes to the model, for the session update
    if ((t.userCount < MIN_USER_MESSAGES || t.chars < MIN_CHARS) && !(mode === 'final' && s.notes.length)) {
      if (mode !== 'final') return 'skipped';
      save({ processedLine: t.endLine, processedAt: now });
      return 'done';
    }
    if (usageToday(home, now) >= config.dailyLimit) { log(home, `${tag}: daily limit reached`); return 'skipped'; }
    addUsage(home, now);

    const url = config.url.replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
    let context;
    try {
      const res = await fetch(`${url}/extractor/context`, { headers });
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
    /** @type {{ recorded: string[], proposals: string[], pending: string[], update: string | null }} */ let r;
    try {
      const res = await fetch(`${url}/extractor/apply`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      r = await res.json();
    } catch (e) { log(home, `${tag}: apply failed: ${/** @type {Error} */ (e).message}`); return 'failed'; }

    const notes = typeof out.progress === 'string' && out.progress ? [...s.notes, out.progress].slice(-10) : s.notes;
    /** @type {Record<string, unknown>} */ const patch = { processedLine: t.endLine, processedAt: now, notes };
    if (mode === 'mid' && r.pending?.length) {
      // the server turns medium items into pending questions in order, up to its cap
      const medium = items.slice(0, MAX_ITEMS).filter((i) => i.certainty === 'medium');
      const asks = r.pending.map((pid, k) => {
        const m = medium[k];
        return `[${pid}] ${m?.ask ?? `Should "${m?.title}" be recorded as a ${m?.type} for the team?`}`;
      });
      patch.notice = `SamePage has a question for you (answer with answer_pending): ${asks.join(' ')}`;
    }
    save(patch);
    log(home, `${tag}: recorded ${r.recorded?.length ?? 0}, proposals ${r.proposals?.length ?? 0}, pending ${r.pending?.length ?? 0}, update ${r.update ? 'yes' : 'no'}`);
    return 'done';
  } finally {
    release();
  }
}

/**
 * Final passes for other sessions that went idle without SessionEnd, one at a time.
 * @param {string} currentId
 * @param {PassDeps} deps
 * @param {(id: string, mode: 'final', deps: PassDeps) => Promise<PassResult>} [pass]
 */
export async function sweep(currentId, deps, pass = runPass) {
  const { home, now } = deps;
  for (const id of listSessions(home)) {
    if (id === currentId) continue;
    const s = loadSession(home, id);
    const idle = now - s.lastActivity;
    if (s.lastActivity <= s.processedAt || idle < SWEEP_IDLE_MS || idle > SWEEP_MAX_AGE_MS) continue;
    try { await pass(id, 'final', deps); } catch (e) { log(home, `${id.slice(0, 8)} sweep: ${/** @type {Error} */ (e).message}`); }
  }
}
