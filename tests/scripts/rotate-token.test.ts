import { expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { sha256Hex } from '../../src/http/app';
import { createPerson } from '../../scripts/add-person';
import { rotateToken } from '../../scripts/rotate-token';

it('rotateToken issues a new token and invalidates the old one', async () => {
  const store = new PostgresStore(await createTestDb());
  const { token: old } = await createPerson(store, { id: 'miguel', name: 'Miguel', isSystem: false });
  const { person, token } = await rotateToken(store, 'miguel');
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(token).not.toBe(old);
  expect(await store.findPersonByTokenHash(await sha256Hex(old))).toBeNull();
  expect((await store.findPersonByTokenHash(await sha256Hex(token)))?.id).toBe('miguel');
  expect(person.id).toBe('miguel');
});

it('rotateToken rejects an unknown person', async () => {
  const store = new PostgresStore(await createTestDb());
  await expect(rotateToken(store, 'ana')).rejects.toThrow('Unknown person: ana');
});
