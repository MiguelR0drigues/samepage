import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeEnv, claudeCommand, runClaude } from '../../integrations/claude-code/lib/claude.mjs';
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, buildPrompt } from '../../integrations/claude-code/lib/policy.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cl-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function fake(out: unknown, extra: Record<string, string> = {}) {
  const outFile = path.join(dir, 'out.json');
  fs.writeFileSync(outFile, typeof out === 'string' ? out : JSON.stringify(out));
  const env = sanitizeEnv({ ...process.env, FAKE_CLAUDE_OUT: outFile, FAKE_CLAUDE_LOG: path.join(dir, 'log'), ...extra } as Record<string, string>);
  return { command: [process.execPath, fixture], prompt: 'the prompt', systemPromptFile: path.join(dir, 'policy.md'), schema: { type: 'object' }, cwd: dir, env };
}
const logged = () => fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

it('sanitizeEnv strips CLAUDECODE, CLAUDE_CODE_*, ANTHROPIC_API_KEY, keeps PATH, CLAUDE_CONFIG_DIR and CLAUDE_CODE_GIT_BASH_PATH, adds SAMEPAGE_EXTRACTOR and CLAUDE_CODE_OAUTH_TOKEN when given', () => {
  const env = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 'old', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_GIT_BASH_PATH: 'D:/Git/bin/bash.exe' };
  const kept = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_GIT_BASH_PATH: 'D:/Git/bin/bash.exe', SAMEPAGE_EXTRACTOR: '1' };
  expect(sanitizeEnv(env)).toEqual(kept);
  expect(sanitizeEnv(env, 'oat')).toEqual({ ...kept, CLAUDE_CODE_OAUTH_TOKEN: 'oat' });
});

it('claudeCommand prefers CLAUDE_CODE_EXECPATH when it is a claude binary', () => {
  const bin = path.join(dir, 'claude.exe');
  fs.writeFileSync(bin, '');
  const config = { claudePath: null } as any;
  expect(claudeCommand({ CLAUDE_CODE_EXECPATH: bin }, config)).toEqual([bin]);
  expect(claudeCommand({ CLAUDE_CODE_EXECPATH: process.execPath }, config)).toEqual(['claude']);
  expect(claudeCommand({ CLAUDE_CODE_EXECPATH: path.join(dir, 'claude-missing') }, { claudePath: '/x/claude' } as any)).toEqual(['/x/claude']);
  expect(claudeCommand({}, config)).toEqual(['claude']);
});

it('runClaude passes the exact flags and returns the structured output', async () => {
  const opts = fake({ type: 'result', is_error: false, result: '', structured_output: { items: [], progress: 'p', update: null } });
  await expect(runClaude(opts)).resolves.toEqual({ items: [], progress: 'p', update: null });
  const [call] = logged();
  expect(call.SAMEPAGE_EXTRACTOR).toBe('1');
  expect(call.argv).toEqual([
    '-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--settings', '{"disableAllHooks":true}', '--output-format', 'json', '--json-schema', '{"type":"object"}',
    '--system-prompt-file', opts.systemPromptFile,
  ]);
});

it('runClaude falls back to parsing result and writes the prompt to stdin', async () => {
  const opts = fake({ is_error: false, result: '{"items":[]}' }, { FAKE_CLAUDE_STDIN: path.join(dir, 'stdin') });
  await expect(runClaude(opts)).resolves.toEqual({ items: [] });
  expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('the prompt');
});

it('runClaude rejects on is_error, non-JSON and timeout', async () => {
  // the error names the subtype only: result may be model text, which must not reach the log
  await expect(runClaude(fake({ is_error: true, subtype: 'error_during_execution', result: 'Not logged in' }, { FAKE_CLAUDE_EXIT: '1' }))).rejects.toThrow(/^claude error: error_during_execution$/);
  await expect(runClaude(fake({ is_error: true, result: 'Not logged in' }))).rejects.toThrow(/^claude error: error$/);
  await expect(runClaude(fake('oops not json'))).rejects.toThrow(/not JSON/);
  await expect(runClaude(fake('', { FAKE_CLAUDE_EXIT: '1' }))).rejects.toThrow(/exited 1/);
  await expect(runClaude({ ...fake('', { FAKE_CLAUDE_SLEEP: '1' }), timeoutMs: 500 })).rejects.toThrow(/timed out/);
});

it('buildPrompt writes the sections in order and omits empty ones', () => {
  const context = {
    person: 'miguel', people: [{ id: 'joao', name: 'João' }],
    entries: [{ id: 'e1', type: 'decision', status: 'active', area: 'pricing', title: 'Per seat', content: 'We price per seat.', authors: ['miguel'] }],
    workstreams: [{ id: 'w1', status: 'active', title: 'Billing', branch: 'web-app@billing' }],
    corrections: [{ verdict: 'personal', type: 'view', title: 'Likes tabs' }],
  };
  const p = buildPrompt({ context, excerpt: '[user] hello', branchHint: 'web-app@main', notes: ['did a'], wantUpdate: true });
  expect(p).toBe([
    '# You extract for: miguel', '',
    '# Team', 'joao: João', '',
    '# Existing entries', 'e1 | decision | active | pricing | Per seat — We price per seat.', '',
    '# Workstreams', 'w1 | active | Billing | web-app@billing', '',
    '# Corrections from this person', 'personal: view — Likes tabs', '',
    '# Branch hint: web-app@main', '',
    '# Session update: needed', '',
    '# Progress earlier in this session', 'did a', '',
    '# Excerpt', '[user] hello',
  ].join('\n'));
  const empty = buildPrompt({ context: { person: 'miguel', people: [], entries: [], workstreams: [], corrections: [] }, excerpt: 'x', branchHint: null, notes: [], wantUpdate: false });
  expect(empty).toBe('# You extract for: miguel\n\n# Session update: not needed\n\n# Excerpt\nx');
});

it('policy exports the system prompt and a schema with required items, progress and update', () => {
  expect(SYSTEM_PROMPT).toMatch(/^You extract team memory for SamePage/);
  expect(OUTPUT_SCHEMA.required).toEqual(['items', 'progress', 'update']);
  expect(OUTPUT_SCHEMA.properties.items.maxItems).toBe(5);
});
