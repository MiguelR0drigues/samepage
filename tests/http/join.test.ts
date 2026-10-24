import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createApp, sha256Hex, type Env } from '../../src/http/app';
import { pasteMessage, slugify } from '../../src/http/join';

const ENV = { JOIN_CODE: 'c0de' } as Env;
// Same escaping as the page (Hono's html helper).
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let store: PostgresStore;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  app = createApp(() => store);
  await store.addPerson({ id: 'extractor', name: 'Extractor', isSystem: true }, await sha256Hex('t-extractor'));
});

const join = (body: unknown, env: Env | undefined = ENV) =>
  app.request('http://t/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
const summary = async (token: string) => (await app.request('http://t/summary', { headers: { Authorization: `Bearer ${token}` } }, ENV)).status;

describe('slugify', () => {
  it('strips accents, lowercases and dashes', () => {
    expect(slugify('Ana Silva')).toBe('ana-silva');
    expect(slugify('  João  Ñ ')).toBe('joao-n');
    expect(slugify('🙂')).toBe('');
  });
});

describe('pasteMessage', () => {
  it('is one line and carries the literal Windows npx path', () => {
    const m = pasteMessage('http://t', 'c0de');
    expect(m).toContain('C:\\Program Files\\nodejs\\npx.cmd');
    expect(m).not.toContain('\n');
  });
});

describe('GET /join/:code', () => {
  it('shows the paste message and the terminal line for the right code', async () => {
    const res = await app.request('http://t/join/c0de', {}, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    const body = await res.text();
    expect(body).toContain(esc(pasteMessage('http://t', 'c0de')));
    expect(body).toContain('npx -y http://t/samepage-setup.tgz --join c0de');
  });

  it('is 404 for a wrong code or when JOIN_CODE is unset', async () => {
    expect((await app.request('http://t/join/nope', {}, ENV)).status).toBe(404);
    expect((await app.request('http://t/join/c0de', {}, {} as Env)).status).toBe(404);
  });
});

describe('POST /join', () => {
  it('creates a new person whose token works', async () => {
    const res = await join({ code: 'c0de', name: 'Ana Silva' });
    expect(res.status).toBe(201);
    const { id, name, token, created } = await res.json() as { id: string; name: string; token: string; created: boolean };
    expect([id, name, created]).toEqual(['ana-silva', 'Ana Silva', true]);
    expect(await summary(token)).toBe(200);
  });

  it('answers 409 when the slug is taken, however the name is spelled', async () => {
    await join({ code: 'c0de', name: 'João' });
    const again = await join({ code: 'c0de', name: 'ana SILVA' });
    expect(again.status).toBe(201);
    const res = await join({ code: 'c0de', name: 'Joao' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ id: 'joao', name: 'João' });
    expect((await join({ code: 'c0de', name: 'ana silva' })).status).toBe(409);
  });

  it('adds a token to the existing person with existing: true', async () => {
    const first = await (await join({ code: 'c0de', name: 'Ana Silva' })).json() as { token: string };
    const res = await join({ code: 'c0de', name: 'ana silva', existing: true });
    expect(res.status).toBe(200);
    const second = await res.json() as { id: string; token: string; created: boolean };
    expect([second.id, second.created]).toEqual(['ana-silva', false]);
    expect(await summary(first.token)).toBe(200);
    expect(await summary(second.token)).toBe(200);
  });

  it('rejects a wrong or missing code without creating anyone', async () => {
    const before = await store.listPeople();
    expect((await join({ code: 'nope', name: 'Ana' })).status).toBe(403);
    expect((await join({ code: 'c0de', name: 'Ana' }, {} as Env)).status).toBe(403);
    const res = await join({ code: 'c0de', name: 'Ana' }, {} as Env);
    expect(await res.json()).toEqual({ error: 'invalid join code' });
    expect(await store.listPeople()).toEqual(before);
  });

  it('rejects names without letters or too long', async () => {
    expect(await (await join({ code: 'c0de', name: '🙂' })).json()).toEqual({ error: 'name needs letters or digits' });
    const long = await join({ code: 'c0de', name: 'a'.repeat(81) });
    expect([long.status, await long.json()]).toEqual([400, { error: 'name is too long' }]);
  });

  it('never attaches to a system person', async () => {
    expect((await join({ code: 'c0de', name: 'Extractor' })).status).toBe(409);
    const res = await join({ code: 'c0de', name: 'Extractor', existing: true });
    expect([res.status, await res.json()]).toEqual([403, { error: 'cannot join as this member' }]);
  });

  it('answers 409, not 500, when a concurrent join takes the name between lookup and insert', async () => {
    await join({ code: 'c0de', name: 'Ana' });
    const find = store.findPersonById.bind(store);
    let first = true;
    store.findPersonById = async (id) => (first ? ((first = false), null) : find(id));
    const res = await join({ code: 'c0de', name: 'ana' });
    expect([res.status, await res.json()]).toEqual([409, { id: 'ana', name: 'Ana' }]);
  });
});
