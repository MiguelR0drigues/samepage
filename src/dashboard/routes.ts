import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import type { Person } from '../domain/types';
import type { Env } from '../http/app';
import { Memory } from '../service/memory';
import type { Store } from '../storage/store';
import { readSession, redeemLink, SESSION_TTL_S, sessionToken } from './auth';
import { message } from './html';
import { homePage } from './pages';

export type DashVars = { store: Store; memory: Memory; person: Person; people: Person[] };

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
    if (!resumed) await store.touchDashboardSeen(person.id, now);
    setCookie(c, 'sp_visit', cutoff.toISOString(), { httpOnly: true, path: '/dashboard', maxAge: VISIT_TTL_S });
    const q = (c.req.query('q') ?? '').trim();
    // Sequential: each read takes a pooled connection, and the Worker has few.
    const changes = await store.changesSince(cutoff, person.id);
    const results = q ? await store.search(q, { limit: 20 }) : null;
    const timeline = await store.listEntries({ type: 'decision', limit: 20 });
    return c.html(await homePage({ person, people: c.get('people'), changes, q, results, timeline }));
  });

  // Keep last: unknown dashboard paths answer here instead of falling through to the bearer middleware.
  app.all('*', () => message(404, 'Not found.'));

  return app;
}
