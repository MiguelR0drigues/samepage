import { fileURLToPath } from 'node:url';
import { readConfig, loadSession, saveSession } from './state.mjs';
import { isCompanyFolder } from './folders.mjs';
import { readTranscript } from './transcript.mjs';
import { MID_SESSION_EVERY } from './limits.mjs';

const EXTRACT = fileURLToPath(new URL('../extract.mjs', import.meta.url));
const block = (/** @type {string} */ reason) => JSON.stringify({ decision: 'block', reason });

/**
 * Decides what a hook does. Pure but for the session state; the caller prints `stdout` and runs `spawn`
 * (argv after the node binary, starting with extract.mjs).
 * @param {'session-start' | 'prompt' | 'stop' | 'session-end' | string} event
 * @param {any} input hook stdin JSON
 * @param {{ home: string, env: Record<string, string | undefined>, now: number }} deps
 * @returns {{ stdout?: string, spawn?: string[] }}
 */
export function handleHook(event, input, { home, env, now }) {
  const config = env.SAMEPAGE_EXTRACTOR ? null : readConfig(home);
  const id = input?.session_id, cwd = input?.cwd;
  if (!config || typeof id !== 'string' || !id || typeof cwd !== 'string' || !isCompanyFolder(cwd, config.folders)) return {};

  const s = loadSession(home, id);
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : s.transcriptPath;
  // only the fields this hook changes: another hook or a pass may save the session meanwhile
  /** @type {Partial<import('./state.mjs').SessionState>} */ const patch = { transcriptPath, cwd, lastActivity: now };
  /** @type {{ stdout?: string, spawn?: string[] }} */ let result = {};
  /** @type {string | null} */ let injected = null;

  if (event === 'prompt') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt === '/private') {
      patch.private = true;
      result = { stdout: block('SamePage: OK, this conversation will not be captured. Nothing was sent to Claude.') };
    } else if (prompt === '/forget') {
      try { patch.skipUntilLine = transcriptPath ? readTranscript(transcriptPath, 0).endLine : 0; } catch { patch.skipUntilLine = 0; }
      result = { stdout: block('SamePage: OK, everything so far that was not captured yet will be skipped. Nothing was sent to Claude.') };
    } else if (s.notice) {
      result = { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: s.notice } }) };
      injected = s.notice;
    }
  } else if (event === 'stop') {
    if (!s.private && transcriptPath) {
      try {
        if (readTranscript(transcriptPath, Math.max(s.processedLine, s.skipUntilLine)).userCount >= MID_SESSION_EVERY) result = { spawn: [EXTRACT, id, 'mid'] };
      } catch { /* transcript not readable yet: try again on the next Stop */ }
    }
  } else if (event === 'session-end') {
    if (!s.private) result = { spawn: [EXTRACT, id, 'final'] };
  } else if (event === 'session-start') {
    result = { spawn: [EXTRACT, '--sweep', id] };
  }

  const fresh = loadSession(home, id);
  try {
    saveSession(home, id, {
      ...fresh, ...patch,
      private: fresh.private || !!patch.private,
      skipUntilLine: Math.max(fresh.skipUntilLine, patch.skipUntilLine ?? 0),
      notice: injected !== null && fresh.notice === injected ? null : fresh.notice,
    });
  } catch (e) {
    if (patch.private || patch.skipUntilLine !== undefined) return { stdout: block('SamePage: could not save this setting (state not writable); the conversation may still be captured.') };
    throw e;
  }
  return result;
}
