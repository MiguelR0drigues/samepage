import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Store } from '../src/storage/store';
import { PostgresStore } from '../src/storage/postgres/store';
import * as schema from '../src/storage/postgres/schema';

export function openStore(url = process.env.DATABASE_URL): { store: Store; close(): Promise<void> } {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const pool = new pg.Pool({ connectionString: url });
  return { store: new PostgresStore(drizzle(pool, { schema })), close: () => pool.end() };
}

// True when the given module is the one being run directly (not imported).
export const isMain = (metaUrl: string) => !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;

// Runs a CLI body against the database, prints errors and always closes the pool.
export async function runCli(body: (store: Store) => Promise<void>) {
  let db: ReturnType<typeof openStore> | undefined;
  try {
    db = openStore();
    await body(db.store);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
