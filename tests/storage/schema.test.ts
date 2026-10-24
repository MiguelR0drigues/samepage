import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../helpers/db';

describe('schema', () => {
  it('applies migrations and creates the tables', async () => {
    const db = await createTestDb();
    const res = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = res.rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(['people', 'entries', 'entry_authors', 'pending', 'corrections']));
  });
});
