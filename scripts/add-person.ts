import { randomBytes } from 'node:crypto';
import type { Store } from '../src/storage/store';
import { sha256Hex } from '../src/http/app';
import { isMain, runCli } from './db';

export const newToken = () => randomBytes(32).toString('hex');

// The one line a teammate pastes to connect Claude Code (any folder, desktop app included).
export const setupCommand = (token: string, url = process.env.SAMEPAGE_URL ?? 'https://samepage.scooli.workers.dev') =>
  `claude mcp add --scope user --transport http samepage ${url}/mcp --header "Authorization: Bearer ${token}"`;

export async function createPerson(store: Store, p: { id: string; name: string; isSystem: boolean }) {
  const token = newToken();
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
      // PowerShell drops the `--` after `npm run`, so npm swallows --system and exposes it as npm_config_system.
      const isSystem = flags.includes('--system') || process.env.npm_config_system === 'true';
      const { person, token } = await createPerson(store, { id, name, isSystem });
      console.log(`Added ${person.id} (${person.name}). Send them this setup command privately (shown once, it contains their token):\n${setupCommand(token)}`);
    });
  }
}
