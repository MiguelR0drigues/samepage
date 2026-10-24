import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPass, sweep } from '../../integrations/claude-code/lib/pass.mjs';
import { loadSession, saveSession, takeLock, addUsage } from '../../integrations/claude-code/lib/state.mjs';
import { SYSTEM_PROMPT } from '../../integrations/claude-code/lib/policy.mjs';
import { SWEEP_IDLE_MS, SWEEP_MAX_AGE_MS } from '../../integrations/claude-code/lib/limits.mjs';

const NOW = new Date(2026, 9, 24, 12).getTime();
const SECRET = 'SECRET-CONVO-TEXT';
let home: string;
let files = 0;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pass-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** Writes `pairs` user/assistant pairs; returns the transcript path. */
function transcript(pairs: number, text = `${SECRET} ${'x'.repeat(300)}`) {
  const f = path.join(home, `t${++files}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < pairs; i++) {
    lines.push(JSON.stringify({ type: 'user', cwd: '/w', gitBranch: 'main', message: { role: 'user', content: `u${i} ${text}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `a${i} ${text}` }] } }));
  }
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

function session(id: string, over: object = {}) {
  saveSession(home, id, { ...loadSession(home, id), transcriptPath: transcript(5), cwd: '/w', lastActivity: NOW, ...over });
}

const context = { person: 'miguel', people: [{ id: 'miguel', name: 'Miguel' }], entries: [], workstreams: [], corrections: [] };
const applied = { recorded: ['r1'], proposals: [], pending: [], ignored: 0, update: null, workstream: null };
const out = {
  items: [{ type: 'decision', title: 'Per seat', content: 'We price per seat.', area: 'pricing', certainty: 'high', relation: 'new', related_id: null, authors: null, ask: null }],
  progress: 'worked on pricing',
  update: { title: 'Pricing', content: 'Set pricing. Next: page.', area: 'pricing', workstream_id: null, workstream_title: 'Pricing' },
};

function deps(o: { ctxStatus?: number; applyStatus?: number; applyResult?: object; claudeOut?: unknown; claudeError?: boolean; dailyLimit?: number; onClaude?: () => void } = {}) {
  const calls: { url: string; init: any }[] = [];
  const claudeCalls: any[] = [];
  const fetch = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    const status = url.endsWith('/context') ? o.ctxStatus ?? 200 : o.applyStatus ?? 200;
    const body = url.endsWith('/context') ? context : o.applyResult ?? applied;
    return new Response(JSON.stringify(body), { status });
  };
  const runClaude = async (args: any) => {
    claudeCalls.push(args);
    o.onClaude?.();
    if (o.claudeError) throw new Error('claude failed');
    return o.claudeOut ?? out;
  };
  const config = { url: 'https://sp.test/', token: 'tok', folders: [], dailyLimit: o.dailyLimit ?? 20, claudePath: null, claudeToken: 'oat' };
  return { d: { home, config, env: {}, fetch: fetch as any, runClaude, now: NOW }, calls, claudeCalls };
}
const logText = () => { try { return fs.readFileSync(path.join(home, 'capture.log'), 'utf8'); } catch { return ''; } };

it('mid pass below 40 messages does nothing', async () => {
  session('s1');
  const { d, calls, claudeCalls } = deps();
  expect(await runPass('s1', 'mid', d)).toBe('skipped');
  expect(calls).toHaveLength(0);
  expect(claudeCalls).toHaveLength(0);
  expect(loadSession(home, 's1').processedLine).toBe(0);
});

it('final pass sends only items and update, never excerpt text', async () => {
  session('s1');
  const { d, calls, claudeCalls } = deps();
  expect(await runPass('s1', 'final', d)).toBe('done');
  expect(calls.map((c) => c.url)).toEqual(['https://sp.test/extractor/context', 'https://sp.test/extractor/apply']);
  expect(calls.every((c) => c.init.headers.Authorization === 'Bearer tok' && c.init.signal instanceof AbortSignal)).toBe(true);
  const raw = calls[1]!.init.body as string;
  expect(raw).not.toContain(SECRET);
  expect(JSON.parse(raw)).toEqual({
    session_ref: 'claude_code:s1', branch_hint: 'w@main',
    items: [{ type: 'decision', title: 'Per seat', content: 'We price per seat.', area: 'pricing', certainty: 'high', relation: 'new' }],
    update: { title: 'Pricing', content: 'Set pricing. Next: page.', area: 'pricing', workstream_title: 'Pricing' },
  });
  const c = claudeCalls[0];
  expect(c.prompt).toContain(SECRET);
  expect(c.prompt).toContain('# Session update: needed');
  expect(c.cwd).toBe(path.join(home, 'work'));
  expect(c.env.SAMEPAGE_EXTRACTOR).toBe('1');
  expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat');
  expect(fs.readFileSync(c.systemPromptFile, 'utf8')).toBe(SYSTEM_PROMPT);
  expect(c.systemPromptFile).toBe(path.join(home, 'work', 'policy.md'));
  const s = loadSession(home, 's1');
  expect(s).toMatchObject({ processedLine: 10, processedAt: NOW, notes: [], notice: null });
  expect(logText()).toMatch(/s1 final: recorded 1, proposals 0, pending 0, update no\n$/);
  expect(logText()).not.toContain(SECRET);
});

it('state advances only after a successful apply', async () => {
  session('s1');
  expect(await runPass('s1', 'final', deps({ applyStatus: 500 }).d)).toBe('failed');
  expect(loadSession(home, 's1')).toMatchObject({ processedLine: 0, processedAt: 0, notes: [] });
  expect(await runPass('s1', 'final', deps().d)).toBe('done');
  expect(loadSession(home, 's1').processedLine).toBe(10);
  // nothing new since: the next pass skips
  expect(await runPass('s1', 'final', deps().d)).toBe('skipped');
});

it('private session is never processed', async () => {
  session('s1', { private: true });
  const { d, calls } = deps();
  expect(await runPass('s1', 'final', d)).toBe('skipped');
  expect(calls).toHaveLength(0);
});

it('skipUntilLine drops earlier messages', async () => {
  session('s1', { skipUntilLine: 4 });
  const { d, claudeCalls } = deps();
  expect(await runPass('s1', 'final', d)).toBe('done');
  expect(claudeCalls[0].prompt).not.toContain('u1 ');
  expect(claudeCalls[0].prompt).toContain('u2 ');
});

it('daily limit stops the pass', async () => {
  session('s1');
  addUsage(home, NOW);
  addUsage(home, NOW);
  const { d, calls } = deps({ dailyLimit: 2 });
  expect(await runPass('s1', 'final', d)).toBe('skipped');
  expect(calls).toHaveLength(0);
  expect(logText()).toContain('daily limit reached');
});

it('held lock skips', async () => {
  session('s1');
  const release = takeLock(home, 's1', NOW)!;
  const { d, calls } = deps();
  expect(await runPass('s1', 'final', d)).toBe('skipped');
  expect(calls).toHaveLength(0);
  release();
  expect(await runPass('s1', 'final', d)).toBe('done');
  expect(fs.readdirSync(path.join(home, 'locks'))).toEqual([]);
});

it('tiny final session is marked done without calling claude', async () => {
  session('s1', { transcriptPath: transcript(2, 'short') });
  const { d, calls, claudeCalls } = deps();
  expect(await runPass('s1', 'mid', d)).toBe('skipped');
  expect(await runPass('s1', 'final', d)).toBe('done');
  expect(calls).toHaveLength(0);
  expect(claudeCalls).toHaveLength(0);
  expect(loadSession(home, 's1')).toMatchObject({ processedLine: 4, processedAt: NOW });
});

it('tiny final tail with earlier notes still calls claude and sends the update', async () => {
  session('s1', { transcriptPath: transcript(2, 'short'), notes: ['did a'] });
  const { d, calls, claudeCalls } = deps();
  expect(await runPass('s1', 'mid', d)).toBe('skipped');
  expect(await runPass('s1', 'final', d)).toBe('done');
  expect(claudeCalls).toHaveLength(1);
  expect(claudeCalls[0].prompt).toContain('# Progress earlier in this session\ndid a');
  expect(JSON.parse(calls[1]!.init.body).update).toMatchObject({ title: 'Pricing' });
  expect(loadSession(home, 's1')).toMatchObject({ processedLine: 4, notes: [] });
});

it('final pass after a mid pass with no new messages still sends the update', async () => {
  session('s1', { transcriptPath: transcript(20) });
  expect(await runPass('s1', 'mid', deps().d)).toBe('done');
  expect(loadSession(home, 's1')).toMatchObject({ processedLine: 40, notes: ['worked on pricing'] });
  const { d, calls, claudeCalls } = deps();
  expect(await runPass('s1', 'final', d)).toBe('done');
  expect(claudeCalls[0].prompt).toContain('# Session update: needed');
  expect(claudeCalls[0].prompt).not.toContain(SECRET);
  expect(JSON.parse(calls[1]!.init.body).update).toMatchObject({ title: 'Pricing' });
  expect(loadSession(home, 's1')).toMatchObject({ processedLine: 40, notes: [] });
});

it('a second final pass with nothing new is skipped', async () => {
  session('s1');
  expect(await runPass('s1', 'final', deps().d)).toBe('done');
  const { d, calls, claudeCalls } = deps();
  expect(await runPass('s1', 'final', d)).toBe('skipped');
  expect(calls).toHaveLength(0);
  expect(claudeCalls).toHaveLength(0);
});

it('a privacy command during the pass drops the result', async () => {
  const changes = { s1: { private: true }, s2: { skipUntilLine: 10 } };
  for (const [id, change] of Object.entries(changes)) {
    session(id);
    const before = loadSession(home, id);
    const { d, calls } = deps({ onClaude: () => saveSession(home, id, { ...loadSession(home, id), ...change }) });
    expect(await runPass(id, 'final', d)).toBe('skipped');
    expect(calls.map((c) => c.url)).toEqual(['https://sp.test/extractor/context']);
    expect(loadSession(home, id)).toEqual({ ...before, ...change });
    expect(logText()).toContain(`${id} final: dropped (privacy command during pass)`);
  }
});

it('context or claude failure logs and leaves state unchanged', async () => {
  session('s1');
  const before = loadSession(home, 's1');
  const ctx = deps({ ctxStatus: 401 });
  expect(await runPass('s1', 'final', ctx.d)).toBe('failed');
  expect(ctx.claudeCalls).toHaveLength(0);
  const cl = deps({ claudeError: true });
  expect(await runPass('s1', 'final', cl.d)).toBe('failed');
  const bad = deps({ claudeOut: { progress: 'x' } });
  expect(await runPass('s1', 'final', bad.d)).toBe('failed');
  expect(cl.calls).toHaveLength(1);
  expect(bad.calls).toHaveLength(1);
  expect(loadSession(home, 's1')).toEqual(before);
  const log = logText();
  expect(log.trim().split('\n')).toHaveLength(3);
  expect(log).not.toContain('tok');
  expect(log).not.toContain('oat');
});

it('mid pass with medium items stores a notice', async () => {
  session('s1', { transcriptPath: transcript(20) });
  const medium = (title: string, ask?: string) => ({ type: 'view', title, content: 'c', area: 'a', certainty: 'medium', relation: 'new', ...(ask ? { ask } : {}) });
  const claudeOut = { items: [{ ...out.items[0], related_id: undefined, authors: undefined, ask: undefined }, medium('One', 'Was "One" a team view?'), medium('Two')], progress: 'p', update: out.update };
  const { d, calls, claudeCalls } = deps({ claudeOut, applyResult: { ...applied, pending: ['p1', 'p2'] } });
  expect(await runPass('s1', 'mid', d)).toBe('done');
  expect(claudeCalls[0].prompt).toContain('# Session update: not needed');
  expect(JSON.parse(calls[1]!.init.body).update).toBeNull();
  expect(loadSession(home, 's1').notice).toBe(
    'SamePage has a question for you (answer with answer_pending): [p1] Was "One" a team view? [p2] Should "Two" be recorded as a view for the team?',
  );
});

it('sweep runs final only for idle, unprocessed, recent sessions and never the current one', async () => {
  const idle = NOW - SWEEP_IDLE_MS - 1000;
  session('idle', { lastActivity: idle });
  session('current', { lastActivity: idle });
  session('busy', { lastActivity: NOW - 1000 });
  session('processed', { lastActivity: idle, processedAt: idle + 1 });
  session('old', { lastActivity: NOW - SWEEP_MAX_AGE_MS - 1000 });
  session('idle2', { lastActivity: idle });
  const ran: string[] = [];
  const { d } = deps();
  await sweep('current', d, async (id: string, mode: string) => { ran.push(`${id}:${mode}`); return 'done'; });
  expect(ran.sort()).toEqual(['idle2:final', 'idle:final']);
});
