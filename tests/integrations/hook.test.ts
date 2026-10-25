import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleHook, LOGIN_NOTE } from '../../integrations/claude-code/lib/handle-hook.mjs';
import { loadSession, saveSession, listSessions } from '../../integrations/claude-code/lib/state.mjs';

// lets a test write the session file while handleHook is reading the transcript
const race = vi.hoisted(() => ({ onRead: null as null | (() => void) }));
vi.mock('../../integrations/claude-code/lib/transcript.mjs', async (orig) => {
  const m = await orig<typeof import('../../integrations/claude-code/lib/transcript.mjs')>();
  return { ...m, readTranscript: (f: string, from: number) => { race.onRead?.(); return m.readTranscript(f, from); } };
});

const NOW = 1_000_000;
const EXTRACT = fileURLToPath(new URL('../../integrations/claude-code/extract.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../../integrations/claude-code/hook.mjs', import.meta.url));
let home: string;
let cwd: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hook-'));
  cwd = path.join(home, 'company', 'web-app');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'http://x', token: 't', claudeToken: 'x', folders: [path.join(home, 'company')] }));
});
afterEach(() => { race.onRead = null; fs.rmSync(home, { recursive: true, force: true }); });

const run = (event: string, input: object, env: Record<string, string> = {}) =>
  handleHook(event, { session_id: 's1', transcript_path: path.join(home, 't.jsonl'), cwd, ...input }, { home, env, now: NOW });

function transcript(messages: number) {
  const f = path.join(home, 't.jsonl');
  fs.writeFileSync(f, Array.from({ length: messages }, (_, i) =>
    JSON.stringify({ type: i % 2 ? 'assistant' : 'user', message: { role: 'user', content: i % 2 ? [{ type: 'text', text: `m${i}` }] : `m${i}` } })).join('\n') + '\n');
  return f;
}

it('outside company folders: no output, no state, no spawn', () => {
  expect(run('prompt', { cwd: path.join(home, 'other'), prompt: '/off-record' })).toEqual({});
  expect(run('session-end', { cwd: path.join(home, 'other') })).toEqual({});
  expect(listSessions(home)).toEqual([]);
});

it('SAMEPAGE_EXTRACTOR set: nothing happens', () => {
  expect(run('session-end', {}, { SAMEPAGE_EXTRACTOR: '1' })).toEqual({});
  expect(listSessions(home)).toEqual([]);
});

it('no config: nothing happens', () => {
  fs.rmSync(path.join(home, 'config.json'));
  expect(run('session-end', {})).toEqual({});
  expect(listSessions(home)).toEqual([]);
});

it('/off-record blocks, marks the session private, spawns the removal, and later session-end spawns nothing', () => {
  const r = run('prompt', { prompt: '/off-record\n' });
  expect(JSON.parse(r.stdout!)).toEqual({ decision: 'block', reason: 'SamePage: OK, this conversation is off the record: nothing more is captured and what was already captured from it is being removed. Nothing was sent to Claude.' });
  expect(r.spawn).toEqual([EXTRACT, '--off-record', 's1']);
  expect(loadSession(home, 's1')).toMatchObject({ private: true, offRecordPending: true });
  expect(run('session-end', {})).toEqual({});
  expect(run('stop', {})).toEqual({});
});

it('/forget blocks and sets skipUntilLine to the transcript length', () => {
  transcript(7);
  const r = run('prompt', { prompt: ' /forget ' });
  expect(JSON.parse(r.stdout!)).toEqual({ decision: 'block', reason: 'SamePage: OK, everything so far that was not captured yet will be skipped. Nothing was sent to Claude.' });
  expect(loadSession(home, 's1').skipUntilLine).toBe(7);
  const s = loadSession(home, 's1');
  expect(s.cwd).toBe(cwd);
  expect(s.lastActivity).toBe(NOW);
});

it('/forget with a missing transcript skips from 0', () => {
  run('prompt', { prompt: '/forget' });
  expect(loadSession(home, 's1').skipUntilLine).toBe(0);
});

it('a notice is injected once as additionalContext', () => {
  saveSession(home, 's1', { ...loadSession(home, 's1'), notice: 'SamePage: 2 proposals pending' });
  const r = run('prompt', { prompt: 'hello' });
  expect(JSON.parse(r.stdout!)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'SamePage: 2 proposals pending' } });
  expect(loadSession(home, 's1').notice).toBeNull();
  expect(run('prompt', { prompt: 'hello' })).toEqual({});
});

const withoutClaudeToken = () => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'http://x', token: 't', folders: [path.join(home, 'company')] }));
const noteOf = (r: { stdout?: string }) => JSON.parse(r.stdout!).hookSpecificOutput.additionalContext;

it('without a Claude token the first prompt of a session says capture is off, the second does not', () => {
  withoutClaudeToken();
  expect(noteOf(run('prompt', { prompt: 'hello' }))).toBe(LOGIN_NOTE('http://x'));
  expect(loadSession(home, 's1').loginNoticed).toBe(true);
  expect(run('prompt', { prompt: 'hello' })).toEqual({});
});

it('with a Claude token there is no login note', () => {
  expect(run('prompt', { prompt: 'hello' })).toEqual({});
});

it('a pending notice wins over the login note', () => {
  withoutClaudeToken();
  saveSession(home, 's1', { ...loadSession(home, 's1'), notice: 'SamePage: 2 proposals pending' });
  expect(noteOf(run('prompt', { prompt: 'hello' }))).toBe('SamePage: 2 proposals pending');
  expect(noteOf(run('prompt', { prompt: 'hello' }))).toBe(LOGIN_NOTE('http://x'));
});

it('stop spawns a mid pass only at 15 new user messages', () => {
  transcript(28);
  expect(run('stop', {})).toEqual({});
  transcript(29);
  expect(run('stop', {}).spawn).toEqual([EXTRACT, 's1', 'mid']);
  saveSession(home, 's1', { ...loadSession(home, 's1'), processedLine: 10 });
  expect(run('stop', {})).toEqual({});
});

it('stop counts from skipUntilLine when it is ahead', () => {
  transcript(40);
  saveSession(home, 's1', { ...loadSession(home, 's1'), skipUntilLine: 12 });
  expect(run('stop', {})).toEqual({});
});

it('a privacy command or a finished pass saved during a hook survives its save', () => {
  transcript(4);
  race.onRead = () => saveSession(home, 's1', { ...loadSession(home, 's1'), private: true, skipUntilLine: 3, processedLine: 4, notice: 'new' });
  run('stop', {});
  expect(loadSession(home, 's1')).toMatchObject({ private: true, skipUntilLine: 3, processedLine: 4, notice: 'new', lastActivity: NOW });
});

it('/off-record and /forget still block, and spawn nothing, when the state cannot be saved', () => {
  fs.writeFileSync(path.join(home, 'sessions'), 'not a folder');
  for (const prompt of ['/off-record', '/forget']) {
    expect(run('prompt', { prompt })).toEqual({ stdout: expect.any(String) });
    expect(JSON.parse(run('prompt', { prompt }).stdout!)).toEqual({
      decision: 'block', reason: 'SamePage: could not save this setting (state not writable); the conversation may still be captured.',
    });
  }
});

it('stop with a missing transcript spawns nothing', () => {
  expect(run('stop', {})).toEqual({});
});

it('session-end spawns a final pass', () => {
  expect(run('session-end', { reason: 'other' }).spawn).toEqual([EXTRACT, 's1', 'final']);
});

it('session-start spawns a sweep with the current id', () => {
  expect(run('session-start', { source: 'startup' }).spawn).toEqual([EXTRACT, '--sweep', 's1']);
});

it('hook.mjs exits 0 with no output on malformed stdin', () => {
  for (const input of ['not json', '']) {
    const r = spawnSync(process.execPath, [HOOK, 'prompt'], { input, encoding: 'utf8', env: { ...process.env, SAMEPAGE_HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }
});

it('hook.mjs prints the /off-record block end to end', () => {
  const input = JSON.stringify({ session_id: 's9', transcript_path: 'x', cwd, prompt: '/off-record' });
  const r = spawnSync(process.execPath, [HOOK, 'prompt'], { input, encoding: 'utf8', env: { ...process.env, SAMEPAGE_HOME: home, SAMEPAGE_EXTRACTOR: '' } });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).decision).toBe('block');
  expect(loadSession(home, 's9').private).toBe(true);
});
