import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createApp, sha256Hex } from '../../src/http/app';
import { runPass } from '../../integrations/claude-code/lib/pass.mjs';
import { loadSession, saveSession } from '../../integrations/claude-code/lib/state.mjs';

// Pins the body shape the client sends against the real server routes.
let home: string;
let store: PostgresStore;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-contract-'));
  store = new PostgresStore(await createTestDb());
  await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, await sha256Hex('t-miguel'));
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

it('a final pass records the high item and attaches the update to a workstream on the real server', async () => {
  const app = createApp(() => store);
  const t = path.join(home, 't.jsonl');
  fs.writeFileSync(t, Array.from({ length: 5 }, (_, i) => [
    JSON.stringify({ type: 'user', cwd: '/w', gitBranch: 'main', message: { role: 'user', content: `u${i} ${'x'.repeat(300)}` } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `a${i} ${'x'.repeat(300)}` }] } }),
  ].join('\n')).join('\n') + '\n');
  saveSession(home, 's1', { ...loadSession(home, 's1'), transcriptPath: t, cwd: '/w' });
  let context: any;
  const runClaude = async ({ prompt }: { prompt: string }) => {
    context = prompt;
    return {
      items: [{ type: 'decision', title: 'Per seat', content: 'We price per seat.', area: 'pricing', certainty: 'high', relation: 'new', related_id: null, authors: null, question: null, ask: null }],
      progress: 'worked on pricing',
      update: { title: 'Pricing', content: 'Set pricing. Next: page.', area: 'pricing', workstream_id: null, workstream_title: 'Pricing' },
    };
  };
  const config = { url: 'http://sp.test/', token: 't-miguel', folders: [], dailyLimit: 20, claudePath: null, claudeToken: 'oat' };
  const fetch = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));

  expect(await runPass('s1', 'final', { home, config, env: {}, fetch: fetch as any, runClaude, now: Date.now() })).toBe('done');
  expect(context).toContain('# You extract for: miguel');
  const [decision] = await store.listEntries({ type: 'decision' });
  expect(decision).toMatchObject({ title: 'Per seat', sourceKind: 'claude_code', sourceRef: 'claude_code:s1', authors: ['miguel'] });
  const [w] = await store.listEntries({ type: 'workstream' });
  expect(w).toMatchObject({ title: 'Pricing', sourceRef: 'branch:w@main' });
  expect((await store.listEntries({ type: 'update' }))[0]).toMatchObject({ title: 'Pricing', workstreamId: w!.id });
  expect(fs.readFileSync(path.join(home, 'capture.log'), 'utf8')).toMatch(/s1 final: recorded 1, proposals 0, pending 0, update yes\n$/);
});
