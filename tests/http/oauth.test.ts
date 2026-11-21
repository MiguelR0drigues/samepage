import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, sha256Hex } from '../../src/http/app';
import { CODE_TTL_S, issueClientId, issueCode, readClientId, s256 } from '../../src/http/oauth';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createTestDb } from '../helpers/db';
import { ENV } from '../dashboard/helpers';

let store: PostgresStore;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  app = createApp(() => store);
  await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, await sha256Hex('t-miguel'));
});

const NO_SECRET = { DATABASE_URL: '' };
const register = (body: unknown, env: object = ENV) => app.request('http://t/oauth/register',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);

describe('OAuth discovery and registration', () => {
  it('serves protected-resource metadata, bare and path-suffixed', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await (await app.request(`http://t${p}`, {}, ENV)).json())
        .toEqual({ resource: 'http://t/mcp', authorization_servers: ['http://t'] });
    }
  });

  it('serves authorization-server metadata, bare and path-suffixed', async () => {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
      expect(await (await app.request(`http://t${p}`, {}, ENV)).json()).toMatchObject({
        issuer: 'http://t', authorization_endpoint: 'http://t/dashboard/oauth/authorize',
        token_endpoint: 'http://t/oauth/token', registration_endpoint: 'http://t/oauth/register',
        code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'],
        response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'],
      });
    }
  });

  it('registers an https client statelessly', async () => {
    const res = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/cb'] });
    expect(res.status).toBe(201);
    const b = await res.json() as { client_id: string; redirect_uris: string[] };
    expect(b.redirect_uris).toEqual(['https://chatgpt.com/cb']);
    expect(await readClientId(b.client_id, ENV.DASHBOARD_SECRET)).toEqual({ redirectUris: ['https://chatgpt.com/cb'], name: 'ChatGPT' });
  });

  it('names an unnamed client "An app"', async () => {
    const b = await (await register({ redirect_uris: ['https://chatgpt.com/other'] })).json() as { client_id: string };
    expect((await readClientId(b.client_id, ENV.DASHBOARD_SECRET))!.name).toBe('An app');
  });

  it('rejects non-https, empty or missing redirect URIs', async () => {
    for (const body of [{ redirect_uris: ['http://evil.example/cb'] }, { redirect_uris: [] }, {}, { redirect_uris: ['not a url'] }]) {
      const res = await register(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_redirect_uri' });
    }
  });

  it('registers Claude web (claude.ai) as a chat app', async () => {
    for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']) {
      expect((await register({ client_name: 'Claude', redirect_uris: [uri] })).status).toBe(201);
    }
  });

  it('only registers ChatGPT redirect hosts, so a look-alike app cannot get a consent page', async () => {
    for (const uri of ['https://chatgpt-connect.app/cb', 'https://chatgpt.com.evil.example/cb', 'https://evil.example/chatgpt.com']) {
      const res = await register({ client_name: 'ChatGPT', redirect_uris: [uri] });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_redirect_uri' });
    }
  });

  it('does not accept a client id signed with another secret', async () => {
    const b = await (await register({ redirect_uris: ['https://chatgpt.com/other'] })).json() as { client_id: string };
    expect(await readClientId(b.client_id, 'other-secret')).toBeNull();
    expect(await readClientId('garbage', ENV.DASHBOARD_SECRET)).toBeNull();
  });

  it('answers 404 JSON when DASHBOARD_SECRET is unset', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
      const res = await app.request(`http://t${p}`, {}, NO_SECRET);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'oauth not configured' });
    }
    expect((await register({ redirect_uris: ['https://chatgpt.com/other'] }, NO_SECRET)).status).toBe(404);
  });

  it('401 from /mcp names the resource metadata', async () => {
    const res = await app.request('http://t/mcp', {}, ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://t/.well-known/oauth-protected-resource"');
  });

  it('s256 matches the RFC 7636 example', async () => {
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('OAuth token endpoint', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const redirectUri = 'https://chatgpt.com/cb';
  let clientId: string;
  let code: string;

  beforeEach(async () => {
    clientId = await issueClientId({ redirectUris: [redirectUri], name: 'ChatGPT' }, ENV.DASHBOARD_SECRET);
    code = await issueCode({ personId: 'miguel', clientId, redirectUri, challenge: await s256(verifier) }, ENV.DASHBOARD_SECRET);
  });
  afterEach(() => vi.useRealTimers());

  const token = (form: Record<string, string>, env: object = ENV) => app.request('http://t/oauth/token',
    { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', ...form }) }, env);
  const valid = () => ({ code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
  const mcpAs = (t: string) => app.request('http://t/mcp', { method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_team', arguments: {} } }) }, ENV);

  it('exchanges a valid code for a token that works on /mcp as that person', async () => {
    const res = await token(valid());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const b = await res.json() as { access_token: string; token_type: string };
    expect(b.token_type).toBe('Bearer');
    expect(await store.findPersonByTokenHash(await sha256Hex(b.access_token))).toMatchObject({ id: 'miguel' });
    expect((await mcpAs(b.access_token)).status).toBe(200);
  });

  it('the Claude Code token keeps working after a ChatGPT connection', async () => {
    await token(valid());
    expect((await mcpAs('t-miguel')).status).toBe(200);
  });

  it('invalid_grant for a wrong verifier, other client, other redirect or tampered code', async () => {
    const otherClient = await issueClientId({ redirectUris: [redirectUri], name: 'Other' }, ENV.DASHBOARD_SECRET);
    for (const over of [{ code_verifier: 'x'.repeat(43) }, { client_id: otherClient }, { redirect_uri: 'https://chatgpt.com/other' }, { code: `${code}x` }]) {
      const res = await token({ ...valid(), ...over });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_grant' });
    }
  });

  it('invalid_grant for an expired code', async () => {
    vi.useFakeTimers({ now: Date.now() + (CODE_TTL_S + 5) * 1000 });
    expect(await (await token(valid())).json()).toEqual({ error: 'invalid_grant' });
  });

  it('invalid_grant when the person is gone or is a system actor', async () => {
    await store.addPerson({ id: 'meet', name: 'Meet', isSystem: true }, await sha256Hex('t-meet'));
    for (const personId of ['ghost', 'meet']) {
      const c = await issueCode({ personId, clientId, redirectUri, challenge: await s256(verifier) }, ENV.DASHBOARD_SECRET);
      expect(await (await token({ ...valid(), code: c })).json()).toEqual({ error: 'invalid_grant' });
    }
  });

  it('unsupported_grant_type for refresh_token; invalid_request when a field is missing', async () => {
    expect(await (await token({ ...valid(), grant_type: 'refresh_token' })).json()).toEqual({ error: 'unsupported_grant_type' });
    const { code_verifier: _, ...missing } = valid();
    expect(await (await token(missing)).json()).toEqual({ error: 'invalid_request' });
  });

  it('404 JSON when DASHBOARD_SECRET is unset', async () => {
    const res = await token(valid(), NO_SECRET);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'oauth not configured' });
  });
});
