import { beforeEach, describe, expect, it } from 'vitest';
import type { Person } from '../../src/domain/types';
import { issueLink, sessionToken } from '../../src/dashboard/auth';
import { createApp } from '../../src/http/app';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createTestDb } from '../helpers/db';
import { ENV, get, signIn } from './helpers';

let store: PostgresStore;
let app: ReturnType<typeof createApp>;
let miguel: Person;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  app = createApp(() => store);
  miguel = await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, 'h-miguel');
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
});
