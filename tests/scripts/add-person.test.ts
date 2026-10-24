import { expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { sha256Hex } from '../../src/http/app';
import { createPerson, setupCommand } from '../../scripts/add-person';

it('setupCommand is a one-line user-scope claude mcp add with the token', () => {
  expect(setupCommand('abc', 'https://sp.example.dev')).toBe(
    'claude mcp add --scope user --transport http samepage https://sp.example.dev/mcp --header "Authorization: Bearer abc"');
});

it('createPerson returns a token whose hash authenticates', async () => {
  const store = new PostgresStore(await createTestDb());
  const { person, token } = await createPerson(store, { id: 'miguel', name: 'Miguel', isSystem: false });
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(await store.findPersonByTokenHash(await sha256Hex(token))).toEqual(person);
  expect(person.id).toBe('miguel');
});
