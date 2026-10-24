import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_TIMEOUT_MS } from './limits.mjs';

/**
 * The parent session's env minus Claude/Anthropic keys, so `claude -p` runs on its own token.
 * @param {Record<string, string | undefined>} env
 * @param {string | null} [claudeToken]
 * @returns {Record<string, string>}
 */
export function sanitizeEnv(env, claudeToken) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (k === 'CLAUDE_CONFIG_DIR' || !/^(CLAUDE|ANTHROPIC_)/.test(k))) out[k] = v;
  }
  out.SAMEPAGE_EXTRACTOR = '1';
  if (claudeToken) out.CLAUDE_CODE_OAUTH_TOKEN = claudeToken;
  return out;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ claudePath: string | null }} config
 * @returns {string[]}
 */
export function claudeCommand(env, config) {
  const exec = env.CLAUDE_CODE_EXECPATH;
  if (exec && path.basename(exec).toLowerCase().startsWith('claude') && fs.existsSync(exec)) return [exec];
  return [config.claudePath ?? 'claude'];
}

// cmd.exe joins args unquoted: quote each one the way the MSVCRT parser in node.exe reads it back
const winQuote = (/** @type {string} */ a) => `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;

/**
 * Runs `claude -p` with the extractor flags; resolves with the schema output.
 * @param {{ command: string[], prompt: string, systemPromptFile: string, schema: object, cwd: string, env: Record<string, string>, timeoutMs?: number }} o
 * @returns {Promise<unknown>}
 */
export function runClaude({ command, prompt, systemPromptFile, schema, cwd, env, timeoutMs = CLAUDE_TIMEOUT_MS }) {
  const [bin, ...pre] = command;
  const args = [...pre,
    '-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--settings', '{"disableAllHooks":true}', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--system-prompt-file', systemPromptFile];
  const shell = /\.cmd$/i.test(bin);
  return new Promise((resolve, reject) => {
    // shortcut: on a .cmd shim, kill() stops cmd.exe but may leave claude running until it exits
    const child = shell
      ? spawn(winQuote(bin), args.map(winQuote), { cwd, env, windowsHide: true, shell: true })
      : spawn(bin, args, { cwd, env, windowsHide: true });
    let stdout = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stdin.on('error', () => { /* child exited before reading: reported on close */ });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`claude could not start: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude timed out after ${timeoutMs} ms`));
      let out;
      try { out = JSON.parse(stdout); } catch {
        return reject(new Error(code ? `claude exited ${code}` : 'claude output is not JSON'));
      }
      if (out?.is_error) return reject(new Error(`claude error: ${String(out.result).slice(0, 200)}`));
      if (code) return reject(new Error(`claude exited ${code}`));
      if (out?.structured_output !== undefined) return resolve(out.structured_output);
      try { resolve(JSON.parse(out?.result)); } catch { reject(new Error('claude result is not JSON')); }
    });
    child.stdin.end(prompt);
  });
}
