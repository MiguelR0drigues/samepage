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
  s.transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : s.transcriptPath;
  s.cwd = cwd;
  s.lastActivity = now;
  /** @type {{ stdout?: string, spawn?: string[] }} */ let result = {};

  if (event === 'prompt') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt === '/private') {
      s.private = true;
      result = { stdout: block('SamePage: this conversation will not be captured.') };
    } else if (prompt === '/forget') {
      try { s.skipUntilLine = s.transcriptPath ? readTranscript(s.transcriptPath, 0).endLine : 0; } catch { s.skipUntilLine = 0; }
      result = { stdout: block('SamePage: everything so far that was not captured yet will be skipped.') };
    } else if (s.notice) {
      result = { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: s.notice } }) };
      s.notice = null;
    }
  } else if (event === 'stop') {
    if (!s.private && s.transcriptPath) {
      try {
        if (readTranscript(s.transcriptPath, Math.max(s.processedLine, s.skipUntilLine)).messages.length >= MID_SESSION_EVERY) result = { spawn: [EXTRACT, id, 'mid'] };
      } catch { /* transcript not readable yet: try again on the next Stop */ }
    }
  } else if (event === 'session-end') {
    if (!s.private) result = { spawn: [EXTRACT, id, 'final'] };
  } else if (event === 'session-start') {
    result = { spawn: [EXTRACT, '--sweep', id] };
  }

  saveSession(home, id, s);
  return result;
}
