import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, sha256Hex } from '../../src/http/app';
import { readClientId, s256 } from '../../src/http/oauth';
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
    const b = await (await register({ redirect_uris: ['https://x.example/cb'] })).json() as { client_id: string };
    expect((await readClientId(b.client_id, ENV.DASHBOARD_SECRET))!.name).toBe('An app');
  });

  it('rejects non-https, empty or missing redirect URIs', async () => {
    for (const body of [{ redirect_uris: ['http://evil.example/cb'] }, { redirect_uris: [] }, {}, { redirect_uris: ['not a url'] }]) {
      const res = await register(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_redirect_uri' });
    }
  });

  it('does not accept a client id signed with another secret', async () => {
    const b = await (await register({ redirect_uris: ['https://x.example/cb'] })).json() as { client_id: string };
    expect(await readClientId(b.client_id, 'other-secret')).toBeNull();
    expect(await readClientId('garbage', ENV.DASHBOARD_SECRET)).toBeNull();
  });

  it('answers 404 JSON when DASHBOARD_SECRET is unset', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
      const res = await app.request(`http://t${p}`, {}, NO_SECRET);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'oauth not configured' });
    }
    expect((await register({ redirect_uris: ['https://x.example/cb'] }, NO_SECRET)).status).toBe(404);
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
