import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, sha256Hex } from '../../src/http/app';
import { issueClientId, readCode } from '../../src/http/oauth';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createTestDb } from '../helpers/db';
import { ENV, get, post, signIn } from './helpers';

let store: PostgresStore;
let app: ReturnType<typeof createApp>;
let cookie: string;
let params: Record<string, string>;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  app = createApp(() => store);
  await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, await sha256Hex('t-miguel'));
  cookie = await signIn(app, store, 'miguel');
  params = {
    response_type: 'code', redirect_uri: 'https://chatgpt.com/cb', state: 'xyz',
    client_id: await issueClientId({ redirectUris: ['https://chatgpt.com/cb'], name: 'ChatGPT' }, ENV.DASHBOARD_SECRET),
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
  };
});

const url = (over: Record<string, string> = {}) => `/dashboard/oauth/authorize?${new URLSearchParams({ ...params, ...over })}`;

describe('OAuth consent page', () => {
  it('without a session, asks to sign in through the agent and reload', async () => {
    const res = await app.request(url(), {}, ENV);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('then reload this page');
  });

  it('with a session, shows who connects what', async () => {
    const res = await get(app, url(), cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const s of ['ChatGPT', 'chatgpt.com', 'Miguel', 'Allow', 'Cancel']) expect(body).toContain(s);
  });

  it('Allow redirects with a code for this person and the state', async () => {
    const res = await post(app, '/dashboard/oauth/authorize', cookie, { ...params, decision: 'allow' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://chatgpt.com/cb');
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(await readCode(loc.searchParams.get('code')!, ENV.DASHBOARD_SECRET)).toEqual({
      personId: 'miguel', clientId: params.client_id, redirectUri: 'https://chatgpt.com/cb', challenge: params.code_challenge,
    });
  });

  it('Cancel redirects with error=access_denied and the state', async () => {
    const res = await post(app, '/dashboard/oauth/authorize', cookie, { ...params, decision: 'cancel' });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('an unregistered redirect_uri shows an error page and never redirects', async () => {
    const evil = { redirect_uri: 'https://evil.example/cb' };
    for (const res of [await get(app, url(evil), cookie),
      await post(app, '/dashboard/oauth/authorize', cookie, { ...params, ...evil, decision: 'allow' })]) {
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('rejects a bad client_id, a missing code_challenge, another method or response_type', async () => {
    const bad: Record<string, string>[] = [{ client_id: 'garbage' }, { code_challenge: '' }, { code_challenge_method: 'plain' }, { response_type: 'token' }];
    for (const over of bad) {
      const res = await get(app, url(over), cookie);
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
  });
});
