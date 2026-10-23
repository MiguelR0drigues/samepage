import { expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { sha256Hex } from '../../src/http/app';
import { createPerson } from '../../scripts/add-person';

it('createPerson returns a token whose hash authenticates', async () => {
  const store = new PostgresStore(await createTestDb());
  const { person, token } = await createPerson(store, { id: 'miguel', name: 'Miguel', isSystem: false });
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(await store.findPersonByTokenHash(await sha256Hex(token))).toEqual(person);
  expect(person.id).toBe('miguel');
});
