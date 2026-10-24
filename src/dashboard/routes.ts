import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import type { Entry, Person } from '../domain/types';
import type { Env } from '../http/app';
import { Memory, MemoryError } from '../service/memory';
import type { Store } from '../storage/store';
import { readSession, redeemLink, SESSION_TTL_S, sessionToken } from './auth';
import { message } from './html';
import { entryPage, homePage, proposalsPage } from './pages';

export type DashVars = { store: Store; memory: Memory; person: Person; people: Person[] };

export const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_MAX = 10;
const VISIT_TTL_S = 1800;
const FIRST_VISIT_MS = 7 * 86_400_000;
const EXPIRED = 'This sign-in link has expired or was already used. Ask your agent to open the dashboard again.';
const SIGN_IN = 'Sign in by asking your agent to open the dashboard (open_dashboard tool).';

export function dashboardRoutes(getStore: (env: Env) => Store) {
  const app = new Hono<{ Bindings: Env; Variables: DashVars }>();

  // The login URL carries a token: never leak it (or any dashboard URL) to other sites.
  app.use('*', async (c, next) => {
    await next();
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/login', async (c) => {
    const secret = c.env.DASHBOARD_SECRET;
    const personId = secret ? await redeemLink(getStore(c.env), c.req.query('t') ?? '', secret) : null;
    if (!personId || !secret) return message(401, EXPIRED);
    setCookie(c, 'sp_session', await sessionToken(personId, secret),
      { httpOnly: true, secure: true, sameSite: 'Lax', path: '/dashboard', maxAge: SESSION_TTL_S });
    return c.redirect('/dashboard');
  });

  // Everything below /login needs a session of a current, human team member.
  app.use('*', csrf(), async (c, next) => {
    const secret = c.env.DASHBOARD_SECRET;
    const personId = secret ? await readSession(getCookie(c, 'sp_session') ?? '', secret) : null;
    const store = getStore(c.env);
    const people = personId ? await store.listPeople() : [];
    const person = people.find((p) => p.id === personId && !p.isSystem);
    if (!person) return message(401, SIGN_IN);
    c.set('store', store);
    c.set('memory', new Memory(store));
    c.set('person', person);
    c.set('people', people);
    await next();
  });

  app.get('/', async (c) => {
    const [store, person] = [c.get('store'), c.get('person')];
    const now = new Date();
    // A visit = Home without a live sp_visit: the cookie carries its cutoff; refreshes reuse it.
    const stored = new Date(getCookie(c, 'sp_visit') ?? NaN);
    const resumed = !Number.isNaN(stored.getTime());
    const cutoff = resumed ? stored : person.dashboardSeenAt ?? new Date(now.getTime() - FIRST_VISIT_MS);
    const q = (c.req.query('q') ?? '').trim();
    // Sequential: each read takes a pooled connection, and the Worker has few.
    const changes = await store.changesSince(cutoff, person.id);
    const results = q ? await store.search(q, { limit: 20 }) : null;
    const timeline = await store.listEntries({ type: 'decision', limit: 20 });
    const page = await homePage({ person, people: c.get('people'), changes, q, results, timeline });
    // Only after every read succeeded: a failed load must not lose the old cutoff.
    if (!resumed) await store.touchDashboardSeen(person.id, now);
    setCookie(c, 'sp_visit', cutoff.toISOString(), { httpOnly: true, path: '/dashboard', maxAge: VISIT_TTL_S });
    return c.html(page);
  });

  app.get('/entries/:id', async (c) => {
    const store = c.get('store');
    const id = c.req.param('id');
    const entry = ID.test(id) ? await store.getEntry(id) : null;
    if (!entry || entry.deletedAt) return message(404, 'Entry not found.');
    if (entry.type === 'workstream') return c.redirect(`/dashboard/workstreams/${entry.id}`);
    const history: { before: (Entry | null)[]; after: Entry[]; proposals: Entry[] } = { before: [], after: [], proposals: [] };
    let target: Entry | null = null;
    // Sequential reads; a deleted link ends the chain and is shown without its title.
    if (entry.type === 'decision') {
      for (let cur: Entry | null = entry; cur?.supersedesId && history.before.length < HISTORY_MAX;) {
        cur = await store.getEntry(cur.supersedesId);
        history.before.push(cur);
        if (cur?.deletedAt) break;
      }
      for (let cur = entry; history.after.length < HISTORY_MAX;) {
        const [next] = await store.listEntries({ supersedesId: cur.id, limit: 1 });
        if (!next) break;
        history.after.push(next);
        cur = next;
      }
      history.proposals = await store.listEntries({ type: 'proposal', targetId: entry.id });
    } else if (entry.type === 'proposal' && entry.targetId) {
      target = await store.getEntry(entry.targetId);
    }
    return c.html(await entryPage({ person: c.get('person'), people: c.get('people'), entry, target, history }));
  });

  app.get('/proposals', async (c) => {
    const store = c.get('store');
    const proposals = await store.listEntries({ type: 'proposal', status: 'open', limit: 50 });
    const ids = [...new Set(proposals.flatMap((p) => p.targetId ?? []))];
    // One read for all targets; a deleted target is absent from the result.
    const targets = new Map((ids.length ? await store.listEntries({ ids, limit: ids.length }) : []).map((e) => [e.id, e]));
    const items = proposals.map((proposal) => ({ proposal, target: targets.get(proposal.targetId ?? '') ?? null }));
    return c.html(await proposalsPage({ person: c.get('person'), people: c.get('people'), items }));
  });

  app.post('/proposals/:id/:action{accept|reject}', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return message(404, 'Not found.');
    const [memory, person] = [c.get('memory'), c.get('person')];
    try {
      if (c.req.param('action') === 'accept') await memory.acceptProposal(person, id);
      else {
        const reason = (await c.req.parseBody()).reason;
        await memory.rejectProposal(person, id, typeof reason === 'string' && reason.trim() ? reason.trim() : undefined);
      }
    } catch (e) {
      if (e instanceof MemoryError) return message(400, e.message, { href: '/dashboard/proposals', label: 'Back to proposals' });
      throw e;
    }
    return c.redirect('/dashboard/proposals', 303);
  });

  // Keep last: unknown dashboard paths answer here instead of falling through to the bearer middleware.
  app.all('*', () => message(404, 'Not found.'));

  return app;
}
