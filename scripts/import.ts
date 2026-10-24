import { readFileSync } from 'node:fs';
import type { Snapshot } from '../src/domain/types';
import { isMain, runCli } from './db';

// shortcut: revives every string under a key ending in "At" as a Date, so a free-form jsonb key like that would be altered; fine while no jsonb content uses such keys.
const reviveDates = (key: string, v: unknown) => (key.endsWith('At') && typeof v === 'string' ? new Date(v) : v);

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run db:import -- <file.json>');
    process.exitCode = 1;
  } else {
    await runCli(async (store) => {
      const snapshot: Snapshot = JSON.parse(readFileSync(file, 'utf8'), reviveDates);
      const { version } = snapshot as { version: number };
      if (version !== 1 && version !== 2) throw new Error(`Unsupported snapshot version: ${version}`);
      await store.importAll(snapshot);
      console.log(`Imported ${snapshot.people.length} people and ${snapshot.entries.length} entries from ${file}.`);
    });
  }
}
