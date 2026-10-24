import type { Store } from '../src/storage/store';
import { sha256Hex } from '../src/http/app';
import { newToken } from './add-person';
import { isMain, runCli } from './db';

// Replaces a person's token; the old one stops working immediately.
export async function rotateToken(store: Store, id: string) {
  const token = newToken();
  const person = await store.setTokenHash(id, await sha256Hex(token));
  if (!person) throw new Error(`Unknown person: ${id}`);
  return { person, token };
}

if (isMain(import.meta.url)) {
  const [id] = process.argv.slice(2);
  if (!id) {
    console.error('Usage: npm run person:rotate -- <id>');
    process.exitCode = 1;
  } else {
    await runCli(async (store) => {
      const { person, token } = await rotateToken(store, id);
      console.log(`New token for ${person.id} (${person.name}); the old one no longer works. Shown once, store it safely:\n${token}`);
    });
  }
}
