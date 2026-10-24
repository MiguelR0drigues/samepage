import { beforeEach, describe, expect, it } from 'vitest';
import type { Person } from '../../src/domain/types';
import { issueLink, sessionToken } from '../../src/dashboard/auth';
import { createApp, sha256Hex } from '../../src/http/app';
import { Memory } from '../../src/service/memory';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createTestDb } from '../helpers/db';
import { ENV, get, signIn } from './helpers';

let store: PostgresStore;
let app: ReturnType<typeof createApp>;
let miguel: Person;
let joao: Person;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  app = createApp(() => store);
  miguel = await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, await sha256Hex('t-miguel'));
  joao = await store.addPerson({ id: 'joao', name: 'João', isSystem: false }, await sha256Hex('t-joao'));
});

const link = () => issueLink(store, miguel, 'http://localhost', ENV.DASHBOARD_SECRET);

describe('dashboard sign-in', () => {
  it('login sets a 30-day HttpOnly cookie and redirects', async () => {
    const res = await app.request(await link(), {}, ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = res.headers.get('set-cookie')!;
    for (const part of ['sp_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000', 'Path=/dashboard']) {
      expect(cookie).toContain(part);
    }
  });

  it('a used link shows the expired page', async () => {
    const url = await link();
    await app.request(url, {}, ENV);
    const res = await app.request(url, {}, ENV);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('expired or was already used');
  });

  it('without a session, or with a forged one, the dashboard asks you to sign in', async () => {
    const forged = `sp_session=${await sessionToken('miguel', 'other-secret')}`;
    for (const cookie of ['', forged]) {
      const res = await get(app, '/dashboard', cookie);
      expect(res.status).toBe(401);
      expect(await res.text()).toContain('open_dashboard');
    }
    const noSecret = await app.request('/dashboard', { headers: { Cookie: await signIn(app, store, 'miguel') } }, { DATABASE_URL: '' });
    expect(noSecret.status).toBe(401);
    expect(await noSecret.text()).toContain('open_dashboard');
  });

  it('refuses cross-origin form posts', async () => {
    const res = await app.request('/dashboard', {
      method: 'POST', headers: { Cookie: await signIn(app, store, 'miguel'), Origin: 'http://evil' },
      body: new URLSearchParams({ a: '1' }),
    }, ENV);
    expect(res.status).toBe(403);
  });

  it('the dashboard does not need a bearer token and /mcp still does', async () => {
    const cookie = await signIn(app, store, 'miguel');
    const res = await get(app, '/dashboard', cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Miguel');
    expect((await get(app, '/mcp', cookie)).status).toBe(401);
  });

  it('an unknown dashboard path is a 404 page for a signed-in user', async () => {
    const res = await get(app, '/dashboard/nope', await signIn(app, store, 'miguel'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Not found.');
  });
});

const decision = (title: string) => ({ type: 'decision' as const, title, content: 'We charge per seat.', area: 'pricing' });
const visitCookie = (res: Response) => /sp_visit=[^;]+/.exec(res.headers.get('set-cookie')!)![0];

describe('Home', () => {
  it("shows what others changed since the last visit, not your own", async () => {
    await new Memory(store).record(joao, decision('Per-seat pricing'));
    await new Memory(store).record(miguel, decision('Mine'));
    const body = await (await get(app, '/dashboard', await signIn(app, store, 'miguel'))).text();
    expect(body).toContain('Per-seat pricing');
    expect(body).toContain('by João');
    expect(body).not.toMatch(/What's new[\s\S]*Mine[\s\S]*Timeline/);
  });

  it("a refresh in the same visit keeps what's new; the next visit starts after it", async () => {
    const session = await signIn(app, store, 'miguel');
    await new Memory(store).record(joao, decision('Per-seat pricing'));
    const first = await get(app, '/dashboard', session);
    expect(await first.text()).toContain('Per-seat pricing');
    const cookie = first.headers.get('set-cookie')!;
    for (const part of ['HttpOnly', 'Path=/dashboard', 'Max-Age=1800']) expect(cookie).toContain(part);
    const again = await get(app, '/dashboard', `${session}; ${visitCookie(first)}`);
    expect(await again.text()).toContain('Per-seat pricing');
    expect(await (await get(app, '/dashboard', session)).text()).not.toMatch(/What's new[\s\S]*Per-seat pricing[\s\S]*Timeline/);
  });

  it('the dashboard and the MCP summary keep separate cursors', async () => {
    const lastSeenAt = new Date(Date.now() - 60_000);
    await store.touchLastSeen('miguel', lastSeenAt);
    await new Memory(store).record(joao, decision('Per-seat pricing'));
    const seen = async () => (await store.listPeople()).find((p) => p.id === 'miguel')!;
    await get(app, '/dashboard', await signIn(app, store, 'miguel'));
    expect((await seen()).lastSeenAt).toEqual(lastSeenAt);
    const { dashboardSeenAt } = await seen();
    expect(dashboardSeenAt).not.toBeNull();
    const summary = await app.request('/summary', { headers: { Authorization: 'Bearer t-miguel' } }, ENV);
    expect(await summary.text()).toMatch(/New since your last session[\s\S]*Per-seat pricing/);
    expect((await seen()).dashboardSeenAt).toEqual(dashboardSeenAt);
  });

  it('escapes text written by agents', async () => {
    await new Memory(store).record(joao, decision('<script>alert(1)</script>'));
    const body = await (await get(app, '/dashboard', await signIn(app, store, 'miguel'))).text();
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).not.toContain('<script>alert(1)');
  });

  it('removed entries show no title', async () => {
    const e = await new Memory(store).record(joao, decision('Secret plan'));
    await new Memory(store).remove(joao, e.id);
    const body = await (await get(app, '/dashboard', await signIn(app, store, 'miguel'))).text();
    expect(body).toContain('removed: decision');
    expect(body).not.toContain('Secret plan');
  });

  it('search and timeline', async () => {
    await new Memory(store).record(joao, decision('Per-seat pricing'));
    const session = await signIn(app, store, 'miguel');
    const found = await (await get(app, '/dashboard?q=pricing', session)).text();
    expect(found).toContain('Search results');
    expect(found).toMatch(/Search results[\s\S]*Per-seat pricing[\s\S]*Timeline/);
    expect(await (await get(app, '/dashboard?q=zzzz', session)).text()).toContain('No results.');
    const home = await (await get(app, '/dashboard', session)).text();
    expect(home).not.toContain('Search results');
    expect(home).toMatch(/Timeline[\s\S]*Per-seat pricing[\s\S]*active/);
  });
});
