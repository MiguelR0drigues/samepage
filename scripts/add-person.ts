import { randomBytes } from 'node:crypto';
import type { Store } from '../src/storage/store';
import { sha256Hex } from '../src/http/app';
import { isMain, runCli } from './db';

export async function createPerson(store: Store, p: { id: string; name: string; isSystem: boolean }) {
  const token = randomBytes(32).toString('hex');
  const person = await store.addPerson(p, await sha256Hex(token));
  return { person, token };
}

if (isMain(import.meta.url)) {
  const [id, name, ...flags] = process.argv.slice(2);
  if (!id || !name) {
    console.error('Usage: npm run person:add -- <id> "<Name>" [--system]');
    process.exitCode = 1;
  } else {
    await runCli(async (store) => {
      const { person, token } = await createPerson(store, { id, name, isSystem: flags.includes('--system') });
      console.log(`Added ${person.id} (${person.name}). Token (shown once, store it safely):\n${token}`);
    });
  }
}
