import { beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createApp, sha256Hex } from '../../src/http/app';

let store: PostgresStore;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  app = createApp(() => store);
  for (const id of ['miguel', 'joao']) {
    await store.addPerson({ id, name: id, isSystem: false }, await sha256Hex(`t-${id}`));
  }
});

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://t/mcp'), {
    fetch: (u, i) => Promise.resolve(app.request(u as string, i)),
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

describe('MCP tools', () => {
  it('lists the 10 tools', async () => {
    const { tools } = await (await connect('t-miguel')).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'accept_proposal', 'correct_text', 'delete_entry', 'list_decisions', 'list_team', 'propose_revision',
      'record', 'reject_proposal', 'search_context', 'supersede_decision',
    ]);
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
