import { beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createApp, sha256Hex, type Env } from '../../src/http/app';
import { ENV } from '../dashboard/helpers';

let store: PostgresStore;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  app = createApp(() => store);
  for (const id of ['miguel', 'joao']) {
    await store.addPerson({ id, name: id, isSystem: false }, await sha256Hex(`t-${id}`));
  }
});

async function connect(token: string, env?: Env) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://t/mcp'), {
    fetch: (u, i) => Promise.resolve(app.request(u as string, i, env)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const rec = { type: 'decision', title: 'Per-seat pricing', content: 'We charge per seat.', area: 'pricing' };

describe('HTTP auth', () => {
  it('responds 401 without a token', async () => {
    for (const path of ['/mcp', '/summary']) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid token' });
    }
    expect((await app.request('/mcp', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('serves /health without a token', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('MCP transport', () => {
  it('answers with plain JSON, not an SSE stream (the Worker closes its DB pool once the response returns)', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer t-miguel', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('samepage');
  });

  it('puts the personal session summary in the initialize instructions, and only there', async () => {
    const joao = (await store.listPeople()).find((p) => p.id === 'joao')!;
    await store.insertEntry({
      type: 'principle', status: 'active', title: 'Plain language', content: 'No jargon.', question: null, positions: null,
      consensus: null, consensusReason: null, area: 'brand', sourceKind: 'explicit', sourceRef: null, authors: [joao.id],
      recordedBy: joao.id, supersedesId: null, targetId: null, resolutionNote: null, workstreamId: null,
    });
    const post = (body: object) => app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer t-miguel', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect((await store.listPeople()).find((p) => p.id === 'miguel')!.lastSeenAt).toBeNull();

    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const { instructions } = ((await res.json()) as { result: { instructions: string } }).result;
    expect(instructions).toContain('Shared team memory');
    expect(instructions).toContain('# Team memory (SamePage)');
    expect(instructions).toContain('Plain language');
    expect((await store.listPeople()).find((p) => p.id === 'miguel')!.lastSeenAt).not.toBeNull();
  });
});

describe('MCP tools', () => {
  it('lists the 17 tools', async () => {
    const { tools } = await (await connect('t-miguel')).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'accept_proposal', 'answer_pending', 'correct_text', 'delete_entry', 'list_decisions', 'list_team', 'list_workstreams',
      'merge_workstreams', 'open_dashboard', 'pending', 'propose_revision', 'record', 'reject_proposal', 'rename_workstream',
      'search_context', 'set_workstream_status', 'supersede_decision',
    ]);
  });

  it('open_dashboard returns a link that signs you in', async () => {
    const out = text(await (await connect('t-miguel', ENV)).callTool({ name: 'open_dashboard', arguments: {} }));
    expect(out).toContain('http://t/dashboard/login?t=');
    expect((await app.request(out.slice(out.indexOf('http://')), {}, ENV)).status).toBe(302);
  });

  it('open_dashboard without DASHBOARD_SECRET is a tool error', async () => {
    const res = await (await connect('t-miguel', { DATABASE_URL: '' })).callTool({ name: 'open_dashboard', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('not configured');
  });

  it('pending then answer_pending records the candidate', async () => {
    const candidate = { type: 'view' as const, title: 'Pricing view', content: 'Seats are better.', area: 'pricing' };
    const p = await store.insertPending({ personId: 'miguel', candidate, question: 'Is this about the company?', sourceRef: 's1' });
    const client = await connect('t-miguel');
    expect(text(await client.callTool({ name: 'pending', arguments: {} })))
      .toBe(`[${p.id}] Is this about the company?\n  view: Pricing view — Seats are better.`);
    const res = await client.callTool({ name: 'answer_pending', arguments: { id: p.id, answer: 'record' } });
    const [e] = await store.listEntries({});
    expect(text(res)).toBe(`Recorded ${e!.id}`);
    expect(e).toMatchObject({ title: 'Pricing view', sourceKind: 'claude_code', sourceRef: 's1' });
    expect(text(await client.callTool({ name: 'pending', arguments: {} }))).toBe('No pending questions.');
    expect((await client.callTool({ name: 'answer_pending', arguments: { id: p.id, answer: 'skip' } })).isError).toBe(true);
  });

  it('pending caps the question at 300 and answer_pending can record it as another type', async () => {
    const candidate = { type: 'view' as const, title: 'Pricing view', content: 'Seats are better.', area: 'pricing' };
    const p = await store.insertPending({ personId: 'miguel', candidate, question: 'q'.repeat(400), sourceRef: null });
    const client = await connect('t-miguel');
    expect(text(await client.callTool({ name: 'pending', arguments: {} }))).toBe(`[${p.id}] ${'q'.repeat(300)}\n  view: Pricing view — Seats are better.`);
    await client.callTool({ name: 'answer_pending', arguments: { id: p.id, answer: 'record', type: 'decision' } });
    expect(await store.listEntries({})).toMatchObject([{ type: 'decision', title: 'Pricing view' }]);
  });

  it('answer_pending personal or skip records nothing', async () => {
    const candidate = { type: 'view' as const, title: 'Lunch', content: 'Pizza.', area: 'life' };
    const p = await store.insertPending({ personId: 'miguel', candidate, question: 'Q?', sourceRef: null });
    const res = await (await connect('t-miguel')).callTool({ name: 'answer_pending', arguments: { id: p.id, answer: 'personal' } });
    expect(text(res)).toBe('Noted: not recorded.');
    expect(await store.listEntries({})).toEqual([]);
    expect((await store.listCorrections('miguel', 5))[0]!.verdict).toBe('personal');
  });

  it('delete_entry with reason stores a correction', async () => {
    const client = await connect('t-miguel');
    const id = text(await client.callTool({ name: 'record', arguments: { ...rec, type: 'view', source: 'claude_code' } })).replace('Recorded ', '');
    await client.callTool({ name: 'delete_entry', arguments: { id, reason: 'not_worth_recording' } });
    const [c] = await store.listCorrections('miguel', 5);
    expect(c).toMatchObject({ verdict: 'not_worth_recording', candidate: { title: 'Per-seat pricing' } });
  });

  it('records then finds with search_context', async () => {
    const client = await connect('t-miguel');
    await client.callTool({ name: 'record', arguments: rec });
    const res = await client.callTool({ name: 'search_context', arguments: { query: 'pricing' } });
    expect(text(res)).toContain('Per-seat pricing');
    expect(text(res)).toContain('miguel');
  });

  it('returns rule errors as isError', async () => {
    const client = await connect('t-miguel');
    const res = await client.callTool({ name: 'record', arguments: { ...rec, authors: ['ana'] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Unknown authors');
  });

  it('takes authorship from the token', async () => {
    await (await connect('t-joao')).callTool({ name: 'record', arguments: rec });
    const [e] = await store.listEntries({});
    expect(e!.recordedBy).toBe('joao');
  });

  it('tracks progress: record workstream and update, set status, list_workstreams', async () => {
    const client = await connect('t-miguel');
    const ws = { type: 'workstream', title: 'Launch site', content: 'Ship it.', area: 'marketing' };
    const id = text(await client.callTool({ name: 'record', arguments: ws })).replace('Recorded ', '');
    const up = await client.callTool({ name: 'record', arguments: { ...ws, type: 'update', title: 'Hero done', workstream_id: id } });
    expect(up.isError).toBeFalsy();
    expect(text(await client.callTool({ name: 'record', arguments: { ...ws, type: 'update' } }))).toContain('needs an existing workstream');
    expect(text(await client.callTool({ name: 'set_workstream_status', arguments: { id, status: 'blocked' } }))).toBe(`Workstream ${id} is blocked`);
    const listed = text(await client.callTool({ name: 'list_workstreams', arguments: {} }));
    expect(listed).toContain('workstream (blocked): Launch site');
    expect(listed).not.toContain('Hero done');
    expect(text(await client.callTool({ name: 'list_workstreams', arguments: { status: 'done' } }))).toBe('No results.');
    expect((await store.listEntries({ type: 'update' }))[0]!.workstreamId).toBe(id);
  });

  it('rename_workstream and merge_workstreams work through MCP', async () => {
    const client = await connect('t-miguel');
    const ws = { type: 'workstream', title: 'Launch site', content: 'Ship it.', area: 'marketing' };
    const mk = async (title: string) => text(await client.callTool({ name: 'record', arguments: { ...ws, title } })).replace('Recorded ', '');
    const [a, b] = [await mk('A'), await mk('B')];
    await client.callTool({ name: 'record', arguments: { ...ws, type: 'update', title: 'Hero done', workstream_id: a } });
    expect(text(await client.callTool({ name: 'rename_workstream', arguments: { id: a, title: 'Launch v2' } }))).toBe(`Renamed workstream ${a}`);
    expect((await store.getEntry(a))!.title).toBe('Launch v2');
    expect(text(await client.callTool({ name: 'merge_workstreams', arguments: { from_id: a, into_id: b } }))).toBe(`Merged ${a} into ${b}`);
    expect((await store.listEntries({ type: 'update' }))[0]!.workstreamId).toBe(b);
    const self = await client.callTool({ name: 'merge_workstreams', arguments: { from_id: b, into_id: b } });
    expect(self.isError).toBe(true);
    expect(text(self)).toContain('cannot be merged into itself');
  });

  it('supersede_decision reports the outcome', async () => {
    const client = await connect('t-miguel');
    await client.callTool({ name: 'record', arguments: rec });
    const [old] = await store.listEntries({});
    const res = await client.callTool({
      name: 'supersede_decision', arguments: { ...rec, old_id: old!.id, title: 'Flat pricing', type: 'decision' },
    });
    expect(text(res)).toMatch(/^Superseded /);
    expect((await store.getEntry(old!.id))!.status).toBe('superseded');
  });
});

it('supersede_decision by another single author creates a proposal', async () => {
  await (await connect('t-miguel')).callTool({ name: 'record', arguments: rec });
  const [old] = await store.listEntries({});
  const res = await (await connect('t-joao')).callTool({ name: 'supersede_decision', arguments: { ...rec, old_id: old!.id } });
  expect(text(res)).toContain('Created proposal');
  expect((await store.getEntry(old!.id))!.status).toBe('under_review');
});

describe('GET /summary', () => {
  it('returns text with the header', async () => {
    const res = await app.request('/summary', { headers: { Authorization: 'Bearer t-miguel' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('# Team memory (SamePage)');
  });
});

describe('/extractor', () => {
  const headers = { Authorization: 'Bearer t-miguel', 'Content-Type': 'application/json' };
  const item = { type: 'view', title: 'Seats win', content: 'Per-seat is simpler.', area: 'pricing', certainty: 'high', relation: 'new' };
  const apply = (body: unknown) => app.request('/extractor/apply', { method: 'POST', headers, body: JSON.stringify(body) });

  it('/extractor/context requires a token and returns people and entries', async () => {
    expect((await app.request('/extractor/context')).status).toBe(401);
    await (await connect('t-miguel')).callTool({ name: 'record', arguments: rec });
    const res = await app.request('/extractor/context', { headers });
    const ctx = (await res.json()) as { person: string; people: { id: string }[]; entries: { title: string }[] };
    expect(res.status).toBe(200);
    expect(ctx.person).toBe('miguel');
    expect(ctx.people.map((p) => p.id).sort()).toEqual(['joao', 'miguel']);
    expect(ctx.entries.map((e) => e.title)).toEqual(['Per-seat pricing']);
  });

  it('/extractor/apply records a high item and returns ids', async () => {
    const res = await apply({ session_ref: 's1', items: [item] });
    const r = (await res.json()) as { recorded: string[] };
    expect(res.status).toBe(200);
    const [e] = await store.listEntries({});
    expect(r.recorded).toEqual([e!.id]);
    expect(e).toMatchObject({ sourceKind: 'claude_code', sourceRef: 's1', recordedBy: 'miguel' });
  });

  it('/extractor/apply returns pending ids with their questions', async () => {
    const r = (await (await apply({ session_ref: 's1', items: [{ ...item, certainty: 'medium', ask: 'Is it?' }] })).json()) as { pending: { id: string; question: string }[] };
    const [p] = await store.listPending('miguel');
    expect(r.pending).toEqual([{ id: p!.id, question: p!.question }]);
    expect(p!.question).toContain('Is it? — view: "Seats win"');
  });

  it('/extractor/forget-session removes what the session recorded', async () => {
    await apply({ session_ref: 's1', items: [item] });
    const forget = (body: unknown) => app.request('/extractor/forget-session', { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await forget({})).status).toBe(400);
    const res = await forget({ session_ref: 's1' });
    expect(await res.json()).toEqual({ removed: 1, kept: 0, pending: 0 });
    expect(await store.listEntries({})).toEqual([]);
  });

  it('/extractor/apply rejects a malformed body with 400', async () => {
    for (const body of [null, {}, { session_ref: 's1', items: Array(21).fill(item) }, { session_ref: 's1', items: [{ ...item, title: 'x'.repeat(4001) }] }]) {
      const res = await apply(body);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe('string');
    }
    expect((await app.request('/extractor/apply', { method: 'POST', headers, body: '{' })).status).toBe(400);
  });

  it('/extractor/apply strips unknown keys and rejects bad enums with 400', async () => {
    const res = await apply({ session_ref: 's1', items: [{ ...item, workstream_id: 'x', consensus: 'unanimous' }] });
    expect(res.status).toBe(200);
    expect(await store.listEntries({})).toHaveLength(1);
    for (const bad of [{ type: 'update' }, { certainty: 'sure' }, { relation: 'replaces' }]) {
      expect((await apply({ session_ref: 's1', items: [{ ...item, ...bad }] })).status).toBe(400);
    }
    expect(await store.listEntries({})).toHaveLength(1);
  });

  it('a system actor gets 400, not 500', async () => {
    await store.addPerson({ id: 'meet', name: 'Meet', isSystem: true }, await sha256Hex('t-meet'));
    const res = await app.request('/extractor/context', { headers: { Authorization: 'Bearer t-meet' } });
    expect(res.status).toBe(400);
  });
});

describe('GET /mcp', () => {
  it('responds 405 instead of opening a never-ending stream', async () => {
    const res = await app.request('/mcp', { headers: { Authorization: 'Bearer t-miguel' } });
    expect(res.status).toBe(405);
  });
});

describe('proposal flow through MCP', () => {
  const propose = async () => {
    await store.insertEntry({
      type: 'decision', status: 'active', title: 'Use Neon', content: 'We use Neon.', area: 'infra', question: null, positions: null,
      consensus: null, consensusReason: null, sourceKind: 'explicit', sourceRef: null, authors: ['miguel', 'joao'],
      recordedBy: 'miguel', supersedesId: null, targetId: null, resolutionNote: null, workstreamId: null,
    });
    const [decision] = await store.listEntries({ type: 'decision' });
    const created = text(await (await connect('t-joao')).callTool({
      name: 'propose_revision', arguments: { decision_id: decision!.id, title: 'Use Supabase', suggestion: 'Switch.', justification: 'Cheaper' },
    }));
    return { decision: decision!, proposalId: created.replace('Created proposal ', '') };
  };

  it('the summary prints full ids that accept_proposal takes', async () => {
    const { decision, proposalId } = await propose();
    const summary = await (await app.request('/summary', { headers: { Authorization: 'Bearer t-miguel' } })).text();
    expect(summary).toContain(`[${proposalId}]`);
    const res = await (await connect('t-miguel')).callTool({ name: 'accept_proposal', arguments: { id: proposalId } });
    expect(res.isError).toBeFalsy();
    expect((await store.getEntry(decision.id))!.status).toBe('superseded');
  });

  it('a rejected proposal shows its note and what it revises', async () => {
    const { decision, proposalId } = await propose();
    const miguel = await connect('t-miguel');
    await miguel.callTool({ name: 'reject_proposal', arguments: { id: proposalId, reason: 'Too risky' } });
    const out = text(await miguel.callTool({ name: 'search_context', arguments: { query: 'Supabase' } }));
    expect(out).toContain(`revises: ${decision.id}`);
    expect(out).toContain('note: Too risky');
    expect(out).not.toContain('recorded by:');
  });
});
