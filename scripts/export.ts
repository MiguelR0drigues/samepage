import { writeFileSync } from 'node:fs';
import { isMain, runCli } from './db';

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run db:export -- <file.json>');
    process.exitCode = 1;
  } else {
    await runCli(async (store) => {
      const snapshot = await store.exportAll();
      writeFileSync(file, JSON.stringify(snapshot, null, 2));
      console.log(`Exported ${snapshot.people.length} people and ${snapshot.entries.length} entries to ${file}.`);
    });
  }
}
