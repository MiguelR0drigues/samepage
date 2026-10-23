import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/storage/postgres/schema';

export async function createTestDb(): Promise<PgliteDatabase<typeof schema>> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: 'src/storage/postgres/migrations' });
  return db;
}
