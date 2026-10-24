import { sign, verify } from 'hono/jwt';
import type { Person } from '../domain/types';
import { MemoryError } from '../service/memory';
import type { Store } from '../storage/store';

export const LINK_TTL_S = 600;
export const SESSION_TTL_S = 30 * 24 * 3600;

const now = () => Math.floor(Date.now() / 1000);

// The payload of a valid, unexpired token of this kind, or null.
async function claims(token: string, secret: string, kind: 'link' | 'session') {
  try {
    const p = await verify(token, secret, 'HS256');
    return p.kind === kind && typeof p.sub === 'string' ? { sub: p.sub, nonce: p.nonce } : null;
  } catch {
    return null;
  }
}

export async function issueLink(store: Store, person: Person, origin: string, secret: string | undefined): Promise<string> {
  if (person.isSystem) throw new MemoryError('A system actor cannot perform this action.');
  if (!secret) throw new MemoryError('The dashboard is not configured on this server.');
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Replaces the stored nonce, so any earlier link stops working.
  await store.setDashboardNonce(person.id, nonce);
  const t = await sign({ sub: person.id, kind: 'link', nonce, exp: now() + LINK_TTL_S }, secret, 'HS256');
  return `${origin}/dashboard/login?t=${t}`;
}

export async function redeemLink(store: Store, token: string, secret: string): Promise<string | null> {
  const p = await claims(token, secret, 'link');
  if (!p || typeof p.nonce !== 'string') return null;
  return (await store.consumeDashboardNonce(p.sub, p.nonce)) ? p.sub : null;
}

export const sessionToken = (personId: string, secret: string): Promise<string> =>
  sign({ sub: personId, kind: 'session', exp: now() + SESSION_TTL_S }, secret, 'HS256');

export const readSession = async (token: string, secret: string): Promise<string | null> =>
  (await claims(token, secret, 'session'))?.sub ?? null;
