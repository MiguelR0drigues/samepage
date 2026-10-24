import { beforeEach, describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import type { Person } from '../../src/domain/types';
import { issueLink, readSession, redeemLink, sessionToken } from '../../src/dashboard/auth';
import { MemoryError } from '../../src/service/memory';
import { PostgresStore } from '../../src/storage/postgres/store';
import { createTestDb } from '../helpers/db';

const S = 'test-secret';
let store: PostgresStore;
let miguel: Person;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  miguel = await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, 'h-miguel');
});

const tokenOf = (link: string) => new URL(link).searchParams.get('t')!;

describe('dashboard auth', () => {
  it('a link works once', async () => {
    const t = tokenOf(await issueLink(store, miguel, 'http://x', S));
    expect(await redeemLink(store, t, S)).toBe('miguel');
    expect(await redeemLink(store, t, S)).toBeNull();
  });

  it('a link expires', async () => {
    await store.setDashboardNonce('miguel', 'abc');
    const t = await sign({ sub: 'miguel', kind: 'link', nonce: 'abc', exp: Math.floor(Date.now() / 1000) - 1 }, S, 'HS256');
    expect(await redeemLink(store, t, S)).toBeNull();
  });

  it('a new link revokes the previous one', async () => {
    const first = tokenOf(await issueLink(store, miguel, 'http://x', S));
    const second = tokenOf(await issueLink(store, miguel, 'http://x', S));
    expect(await redeemLink(store, first, S)).toBeNull();
    expect(await redeemLink(store, second, S)).toBe('miguel');
  });

  it('a link signed with another secret is refused', async () => {
    const t = tokenOf(await issueLink(store, miguel, 'http://x', 'other-secret'));
    expect(await redeemLink(store, t, S)).toBeNull();
  });

  it('link and session tokens are not interchangeable', async () => {
    const link = tokenOf(await issueLink(store, miguel, 'http://x', S));
    const session = await sessionToken('miguel', S);
    expect(await readSession(session, S)).toBe('miguel');
    expect(await readSession(link, S)).toBeNull();
    expect(await redeemLink(store, session, S)).toBeNull();
  });

  it('system actors and a missing secret get MemoryError', async () => {
    const meet = await store.addPerson({ id: 'meet', name: 'Meet', isSystem: true }, 'h-meet');
    await expect(issueLink(store, meet, 'http://x', S)).rejects.toThrow(MemoryError);
    await expect(issueLink(store, miguel, 'http://x', undefined)).rejects.toThrow('The dashboard is not configured on this server.');
  });
});
