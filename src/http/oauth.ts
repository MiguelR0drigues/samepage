import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import type { Store } from '../storage/store';
import { sha256Hex, type Env } from './app';
import { newToken } from './join';

// A minimal, stateless OAuth 2.1 server for chat apps (ChatGPT): client ids and codes are signed JWTs.
export const CODE_TTL_S = 300;

type Client = { redirectUris: string[]; name: string };
type Code = { personId: string; clientId: string; redirectUri: string; challenge: string };

async function claims(token: string, secret: string, kind: 'client' | 'code') {
  try {
    const p = await verify(token, secret, 'HS256');
    return p.kind === kind ? p : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

export const issueClientId = (c: Client, secret: string) =>
  sign({ kind: 'client', uris: c.redirectUris, name: c.name }, secret, 'HS256');

export async function readClientId(id: string, secret: string): Promise<Client | null> {
  const p = await claims(id, secret, 'client');
  return p && strings(p.uris) && typeof p.name === 'string' ? { redirectUris: p.uris, name: p.name } : null;
}

export const issueCode = (c: Code, secret: string) =>
  sign({ kind: 'code', sub: c.personId, cid: c.clientId, uri: c.redirectUri, ch: c.challenge,
    exp: Math.floor(Date.now() / 1000) + CODE_TTL_S }, secret, 'HS256');

export async function readCode(code: string, secret: string): Promise<Code | null> {
  const p = await claims(code, secret, 'code');
  const [sub, cid, uri, ch] = [p?.sub, p?.cid, p?.uri, p?.ch];
  return typeof sub === 'string' && typeof cid === 'string' && typeof uri === 'string' && typeof ch === 'string'
    ? { personId: sub, clientId: cid, redirectUri: uri, challenge: ch } : null;
}

export async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isHttps = (u: string) => URL.canParse(u) && new URL(u).protocol === 'https:';

export function oauthRoutes(getStore: (env: Env) => Store) {
  const app = new Hono<{ Bindings: Env }>();

  // Mounted at '/': guard only our own paths, not the whole app.
  for (const p of ['/.well-known/*', '/oauth/*']) {
    app.use(p, async (c, next) => c.env.DASHBOARD_SECRET ? next() : c.json({ error: 'oauth not configured' }, 404));
  }

  // Clients may append the resource path (…/mcp) to the well-known URL.
  app.on('GET', ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*'], (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  });

  app.on('GET', ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/*'], (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/dashboard/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  app.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => null) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = body?.redirect_uris;
    if (!strings(uris) || !uris.length || !uris.every(isHttps)) return c.json({ error: 'invalid_redirect_uri' }, 400);
    const name = typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'An app';
    const clientId = await issueClientId({ redirectUris: uris, name }, c.env.DASHBOARD_SECRET!);
    return c.json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name,
      redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }, 201);
  });

  // Mints an ordinary person token: /mcp checks it like a Claude Code one.
  // shortcut: codes are not single-use (stateless); a replay within CODE_TTL_S, PKCE-bound, only adds another token for the same person.
  app.post('/oauth/token', async (c) => {
    const f = await c.req.parseBody();
    const s = (k: string) => (typeof f[k] === 'string' ? f[k] : '');
    if (s('grant_type') !== 'authorization_code') return c.json({ error: 'unsupported_grant_type' }, 400);
    if (!s('code') || !s('redirect_uri') || !s('client_id') || !s('code_verifier')) return c.json({ error: 'invalid_request' }, 400);
    const code = await readCode(s('code'), c.env.DASHBOARD_SECRET!);
    const store = getStore(c.env);
    const person = code && code.clientId === s('client_id') && code.redirectUri === s('redirect_uri')
      && code.challenge === await s256(s('code_verifier')) ? await store.findPersonById(code.personId) : null;
    if (!person || person.isSystem) return c.json({ error: 'invalid_grant' }, 400);
    const token = newToken();
    await store.addToken(person.id, await sha256Hex(token));
    return c.json({ access_token: token, token_type: 'Bearer' }, 200, { 'Cache-Control': 'no-store' });
  });

  return app;
}
