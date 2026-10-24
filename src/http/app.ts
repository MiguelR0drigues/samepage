import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { issueLink } from '../dashboard/auth';
import { dashboardRoutes } from '../dashboard/routes';
import type { Person } from '../domain/types';
import { buildMcpServer } from '../mcp/server';
import { sessionSummary } from '../service/summary';
import type { Store } from '../storage/store';

export interface Env { DATABASE_URL: string; DASHBOARD_SECRET?: string }

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createApp(getStore: (env: Env) => Store) {
  const app = new Hono<{ Bindings: Env; Variables: { person: Person; store: Store } }>();

  app.get('/health', (c) => c.text('ok'));
  // Signs in with its own cookie, so it sits before the bearer middleware.
  app.route('/dashboard', dashboardRoutes(getStore));

  app.use('*', async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    const store = getStore(c.env);
    // Loaded fresh per request so the summary sees an up-to-date lastSeenAt.
    const person = token ? await store.findPersonByTokenHash(await sha256Hex(token)) : null;
    if (!person) return c.json({ error: 'invalid token' }, 401);
    c.set('person', person);
    c.set('store', store);
    await next();
  });

  // Stateless mode has no session to stream to: a GET would hang open forever.
  app.get('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));

  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // The client's instructions are only read at initialize: build the summary (and advance lastSeenAt) only then.
    const body: unknown = await c.req.raw.clone().json().catch(() => null);
    const isInit = (Array.isArray(body) ? body : [body]).some((m) => (m as { method?: string } | null)?.method === 'initialize');
    const summary = isInit ? await sessionSummary(c.get('store'), c.get('person'), new Date()) : undefined;
    const [store, person] = [c.get('store'), c.get('person')];
    const openDashboard = () => issueLink(store, person, new URL(c.req.url).origin, c.env.DASHBOARD_SECRET);
    await buildMcpServer(store, person, summary, openDashboard).connect(transport);
    // JSON (not SSE) so the response is complete when handleRequest resolves; the Worker closes its DB pool right after.
    return transport.handleRequest(c.req.raw);
  });

  app.get('/summary', async (c) =>
    c.text(await sessionSummary(c.get('store'), c.get('person'), new Date()), 200, { 'Content-Type': 'text/plain; charset=utf-8' }));

  return app;
}
