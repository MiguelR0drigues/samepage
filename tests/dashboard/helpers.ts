import { issueLink } from '../../src/dashboard/auth';
import type { createApp } from '../../src/http/app';
import type { Store } from '../../src/storage/store';

type App = ReturnType<typeof createApp>;

export const ENV = { DATABASE_URL: '', DASHBOARD_SECRET: 'test-secret' };

// Issues a link, follows it, returns the `sp_session=...` cookie pair.
export async function signIn(app: App, store: Store, personId: string): Promise<string> {
  const person = (await store.listPeople()).find((p) => p.id === personId)!;
  const res = await app.request(await issueLink(store, person, 'http://localhost', ENV.DASHBOARD_SECRET), {}, ENV);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

export const get = (app: App, path: string, cookie: string) => app.request(path, { headers: { Cookie: cookie } }, ENV);

export const post = (app: App, path: string, cookie: string, form: Record<string, string>) =>
  app.request(path, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost' }, body: new URLSearchParams(form) }, ENV);
