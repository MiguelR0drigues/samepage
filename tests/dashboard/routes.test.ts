import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Person } from '../../src/domain/types';
import { issueLink, sessionToken } from '../../src/dashboard/auth';
import { createApp, sha256Hex } from '../../src/http/app';
import { Memory } from '../../src/service/memory';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createTestDb } from '../helpers/db';
import { ENV, get, post, signIn } from './helpers';

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

  it('a failed read leaves the cursor where it was', async () => {
    const failing = Object.assign(Object.create(store), { changesSince: () => Promise.reject(new Error('db down')) });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get(createApp(() => failing), '/dashboard', await signIn(app, store, 'miguel'));
    log.mockRestore();
    expect(res.status).toBe(500);
    expect((await store.listPeople()).find((p) => p.id === 'miguel')!.dashboardSeenAt).toBeNull();
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

const both = { authors: ['miguel', 'joao'] };

describe('decision page', () => {
  it('shows question, positions by name, verdict and why without consensus', async () => {
    const e = await new Memory(store).record(miguel, {
      ...decision('Per-seat pricing'), question: 'How do we charge?', consensus: 'majority',
      consensusReason: 'We need a price for the landing page',
      positions: [{ person: 'miguel', position: 'per seat', arguments: '<b>predictable</b>' }, { person: 'joao', position: 'per use' }],
    });
    const res = await get(app, `/dashboard/entries/${e.id}`, await signIn(app, store, 'miguel'));
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const s of ['Miguel', 'João', 'per seat', 'per use', 'How do we charge?', 'We charge per seat.', '&lt;b&gt;predictable',
      'majority', 'Why we went ahead without full consensus', 'We need a price for the landing page']) expect(body).toContain(s);
    expect(body).not.toContain('<b>predictable');
  });

  it('shows the supersession history both ways', async () => {
    const a = await new Memory(store).record(miguel, { ...decision('Per-seat pricing'), ...both });
    const { entry: b } = await new Memory(store).supersede(miguel, a.id, { ...decision('Per-use pricing'), ...both });
    const session = await signIn(app, store, 'miguel');
    expect(await (await get(app, `/dashboard/entries/${a.id}`, session)).text()).toContain(`/dashboard/entries/${b.id}`);
    expect(await (await get(app, `/dashboard/entries/${b.id}`, session)).text()).toContain(`/dashboard/entries/${a.id}`);
  });

  it('lists revision proposals in the history', async () => {
    const a = await new Memory(store).record(miguel, { ...decision('Per-seat pricing'), ...both });
    const p = await new Memory(store).proposeRevision(joao, a.id, { title: 'Per-use pricing', content: 'x', justification: 'y' });
    const body = await (await get(app, `/dashboard/entries/${a.id}`, await signIn(app, store, 'miguel'))).text();
    expect(body).toContain(`/dashboard/entries/${p.id}`);
    expect(body).toContain('open');
  });

  it('a proposal shows what it revises; other types render too; a workstream redirects', async () => {
    const session = await signIn(app, store, 'miguel');
    const a = await new Memory(store).record(miguel, { ...decision('Per-seat pricing'), ...both });
    const p = await new Memory(store).proposeRevision(joao, a.id, { title: 'Per-use pricing', content: 'x', justification: 'y' });
    const body = await (await get(app, `/dashboard/entries/${p.id}`, session)).text();
    expect(body).toMatch(/Revises:[\s\S]*Per-seat pricing/);
    const view = await new Memory(store).record(joao, { type: 'view', title: 'My view', content: 'Seats are fine.', area: 'pricing' });
    expect(await (await get(app, `/dashboard/entries/${view.id}`, session)).text()).toContain('Seats are fine.');
    const w = await new Memory(store).record(joao, { type: 'workstream', title: 'Launch', content: 'c', area: 'gtm' });
    const res = await get(app, `/dashboard/entries/${w.id}`, session);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/dashboard/workstreams/${w.id}`);
  });

  it('a deleted predecessor shows (deleted) and not its title', async () => {
    const a = await new Memory(store).record(miguel, { ...decision('Old secret title'), ...both });
    const { entry: b } = await new Memory(store).supersede(miguel, a.id, { ...decision('Per-use pricing'), ...both });
    await new Memory(store).remove(miguel, a.id);
    const body = await (await get(app, `/dashboard/entries/${b.id}`, await signIn(app, store, 'miguel'))).text();
    expect(body).toContain('(deleted)');
    expect(body).not.toContain('Old secret title');
  });

  it('unknown, malformed and deleted ids are 404', async () => {
    const session = await signIn(app, store, 'miguel');
    const e = await new Memory(store).record(miguel, decision('Gone'));
    await new Memory(store).remove(miguel, e.id);
    for (const id of ['abc', 'a'.repeat(36), crypto.randomUUID(), e.id]) {
      const res = await get(app, `/dashboard/entries/${id}`, session);
      expect(res.status).toBe(404);
    }
    expect(await (await get(app, `/dashboard/entries/${e.id}`, session)).text()).not.toContain('Gone');
  });
});

describe('proposals', () => {
  async function propose() {
    const a = await new Memory(store).record(miguel, { ...decision('Per-seat pricing'), ...both });
    const p = await new Memory(store).proposeRevision(joao, a.id, { title: 'Per-use pricing', content: 'Switch.', justification: 'y' });
    return { a, p };
  }

  it('others can accept, the proposer cannot', async () => {
    const { a, p } = await propose();
    const [m, j] = [await signIn(app, store, 'miguel'), await signIn(app, store, 'joao')];
    const mine = await (await get(app, '/dashboard/proposals', m)).text();
    expect(mine).toContain('Accept');
    expect(mine).toContain('Per-use pricing');
    expect(mine).toContain('Revises:');
    const theirs = await (await get(app, '/dashboard/proposals', j)).text();
    expect(theirs).toContain('you cannot close your own proposal');
    expect(theirs).not.toContain('Accept');
    const refused = await post(app, `/dashboard/proposals/${p.id}/accept`, j, {});
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('You cannot close your own proposal.');
    const ok = await post(app, `/dashboard/proposals/${p.id}/accept`, m, {});
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/dashboard/proposals');
    expect((await store.getEntry(a.id))!.status).toBe('superseded');
    expect(await (await get(app, '/dashboard/proposals', m)).text()).toContain('No open proposals.');
  });

  it('reject keeps the decision and stores the reason', async () => {
    const { a, p } = await propose();
    const res = await post(app, `/dashboard/proposals/${p.id}/reject`, await signIn(app, store, 'miguel'), { reason: 'Too risky' });
    expect(res.status).toBe(303);
    expect((await store.getEntry(a.id))!.status).toBe('active');
    expect((await store.getEntry(p.id))!.resolutionNote).toBe('Too risky');
  });

  it('a bad id is 404', async () => {
    const session = await signIn(app, store, 'miguel');
    for (const id of ['abc', 'a'.repeat(36)]) expect((await post(app, `/dashboard/proposals/${id}/accept`, session, {})).status).toBe(404);
  });

  it('a proposal whose target was deleted shows (deleted), not the title', async () => {
    const { a } = await propose();
    await store.updateEntry(a.id, { deletedAt: new Date(), deletedBy: 'miguel' }, 'miguel');
    const body = await (await get(app, '/dashboard/proposals', await signIn(app, store, 'miguel'))).text();
    expect(body).toContain('Revises: (deleted)');
    expect(body).not.toContain('Per-seat pricing');
  });

  it('cross-site POST is refused', async () => {
    const { p } = await propose();
    const res = await app.request(`/dashboard/proposals/${p.id}/accept`, {
      method: 'POST', headers: { Cookie: await signIn(app, store, 'miguel'), Origin: 'https://evil.example' }, body: new URLSearchParams({}),
    }, ENV);
    expect(res.status).toBe(403);
    expect((await store.getEntry(p.id))!.status).toBe('open');
  });
});

const section = (body: string, tag: string, start: string) => body.split(tag).find((s) => s.startsWith(start))!;
const ws = (title: string) => ({ type: 'workstream' as const, title, content: 'About it.', area: 'gtm' });

describe('Who thinks what', () => {
  it('shows views side by side per area, with the current decisions', async () => {
    const m = new Memory(store);
    const view = (title: string, area: string) => ({ type: 'view' as const, title, content: `${title} text`, area });
    await m.record(miguel, view('Miguel on positioning', 'positioning'));
    await m.record(joao, view('Joao on positioning', 'positioning'));
    await m.record(miguel, view('Miguel on pricing', 'pricing'));
    await m.record(miguel, { ...decision('Own the category'), area: 'positioning' });
    const body = await (await get(app, '/dashboard/views', await signIn(app, store, 'miguel'))).text();
    const positioning = section(body, '<h2>', 'positioning');
    for (const s of ['Miguel', 'João', 'Miguel on positioning', 'Joao on positioning', 'Current decisions', 'Own the category']) {
      expect(positioning).toContain(s);
    }
    expect(positioning).not.toContain('No view recorded yet.');
    const pricing = section(body, '<h2>', 'pricing');
    expect(pricing).toContain('Miguel on pricing');
    expect(pricing).toContain('No view recorded yet.');
    expect(pricing).not.toContain('Current decisions');
  });

  it('says so when there are no views', async () => {
    expect(await (await get(app, '/dashboard/views', await signIn(app, store, 'miguel'))).text()).toContain('No views recorded yet.');
  });
});

describe('Team', () => {
  it('shows what each person works on, last activity and blockers', async () => {
    const m = new Memory(store);
    const w1 = await m.record(miguel, ws('Launch site'));
    await m.record(miguel, { type: 'update', title: 'Hero done', content: 'c', area: 'gtm', workstreamId: w1.id });
    const w2 = await m.record(joao, ws('Pricing page'));
    await m.setWorkstreamStatus(joao, w2.id, 'blocked');
    const w3 = await m.record(miguel, ws('Old thing'));
    await m.setWorkstreamStatus(miguel, w3.id, 'done');
    const body = await (await get(app, '/dashboard/team', await signIn(app, store, 'miguel'))).text();
    const [mCard, jCard] = [section(body, '<h3>', 'Miguel'), section(body, '<h3>', 'João')];
    expect(mCard).toMatch(/Working on:[\s\S]*Launch site/);
    expect(mCard).toMatch(/Last activity:[\s\S]*Old thing/);
    expect(mCard).toMatch(/Done \(1\)[\s\S]*Old thing/);
    expect(mCard).not.toContain('Blocked:');
    expect(jCard).toMatch(/Blocked:[\s\S]*Pricing page/);
    expect(jCard).not.toContain('Done (');
  });

  it('a person with nothing recorded gets the empty states', async () => {
    const jCard = section(await (await get(app, '/dashboard/team', await signIn(app, store, 'miguel'))).text(), '<h3>', 'João');
    expect(jCard).toContain('Nothing in progress.');
    expect(jCard).toContain('No activity yet.');
  });
});

describe('workstream page', () => {
  it('shows the progress timeline, newest first, with author names', async () => {
    const m = new Memory(store);
    const w = await m.record(miguel, ws('Launch site'));
    const up = (title: string) => ({ type: 'update' as const, title, content: `${title} text`, area: 'gtm', workstreamId: w.id });
    await m.record(miguel, up('First step'));
    await m.record(joao, up('Second step'));
    const res = await get(app, `/dashboard/workstreams/${w.id}`, await signIn(app, store, 'miguel'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Launch site');
    expect(body).toMatch(/Progress[\s\S]*Second step[\s\S]*João[\s\S]*First step[\s\S]*Miguel/);
  });

  it('renames, sets status and merges from the dashboard', async () => {
    const m = new Memory(store);
    const w1 = await m.record(miguel, ws('Launch site'));
    const w2 = await m.record(miguel, ws('Landing copy'));
    await m.record(miguel, { type: 'update', title: 'Copy drafted', content: 'c', area: 'gtm', workstreamId: w2.id });
    const session = await signIn(app, store, 'joao');
    const page = `/dashboard/workstreams/${w1.id}`;
    const renamed = await post(app, `${page}/rename`, session, { title: 'Launch v2' });
    expect(renamed.status).toBe(303);
    expect(renamed.headers.get('location')).toBe(page);
    expect((await store.getEntry(w1.id))!.title).toBe('Launch v2');
    expect((await post(app, `${page}/rename`, session, { title: '  ' })).status).toBe(400);
    expect((await post(app, `${page}/status`, session, { status: 'done' })).status).toBe(303);
    expect((await store.getEntry(w1.id))!.status).toBe('done');
    const bogus = await post(app, `${page}/status`, session, { status: 'bogus' });
    expect(bogus.status).toBe(400);
    expect((await store.getEntry(w1.id))!.status).toBe('done');
    await post(app, `${page}/status`, session, { status: 'in_progress' });
    expect(await (await get(app, page, session)).text()).toContain(`<option value="${w2.id}"`);
    const merged = await post(app, `/dashboard/workstreams/${w2.id}/merge`, session, { into: w1.id });
    expect(merged.status).toBe(303);
    expect(merged.headers.get('location')).toBe(page);
    expect(await (await get(app, page, session)).text()).toContain('Copy drafted');
    const from = await store.getEntry(w2.id);
    expect(from!.status).toBe('done');
    expect(await (await get(app, `/dashboard/workstreams/${w2.id}`, session)).text()).toContain('Merged into');
    const self = await post(app, `${page}/merge`, session, { into: w1.id });
    expect(self.status).toBe(400);
    expect(await self.text()).toContain('cannot be merged into itself');
    expect((await post(app, `${page}/merge`, session, { into: 'abc' })).status).toBe(400);
  });

  it('bad workstream ids are 404', async () => {
    const session = await signIn(app, store, 'miguel');
    const d = await new Memory(store).record(miguel, decision('Not a workstream'));
    const gone = await new Memory(store).record(miguel, ws('Gone'));
    await new Memory(store).remove(miguel, gone.id);
    for (const id of ['abc', 'a'.repeat(36), crypto.randomUUID(), d.id, gone.id]) {
      expect((await get(app, `/dashboard/workstreams/${id}`, session)).status).toBe(404);
    }
    for (const action of ['rename', 'status', 'merge']) expect((await post(app, `/dashboard/workstreams/abc/${action}`, session, {})).status).toBe(404);
  });
});
