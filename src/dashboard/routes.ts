import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import type { Person } from '../domain/types';
import type { Env } from '../http/app';
import { Memory } from '../service/memory';
import type { Store } from '../storage/store';
import { readSession, redeemLink, SESSION_TTL_S, sessionToken } from './auth';
import { message } from './html';

export type DashVars = { store: Store; memory: Memory; person: Person; people: Person[] };

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

  app.get('/', (c) => message(200, c.get('person').name));

  return app;
}
