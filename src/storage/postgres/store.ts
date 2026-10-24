import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { Change, Entry, NewEntry, Person, Snapshot } from '../../domain/types';
import type { EntryFilter, EntryPatch, Store } from '../store';
import * as schema from './schema';

const { entries, entryAuthors, people } = schema;
type EntryRow = typeof entries.$inferSelect;
type PersonRow = typeof people.$inferSelect;

const DEFAULT_LIMIT = 20;
const toPerson = ({ tokenHash: _t, ...p }: PersonRow): Person => p;

export class PostgresStore implements Store {
  constructor(private db: PgDatabase<any, typeof schema>) {}

  // Attaches the sorted author ids to entry rows, in one extra query.
  private async withAuthors(rows: EntryRow[]): Promise<Entry[]> {
    if (rows.length === 0) return [];
    const links = await this.db.select().from(entryAuthors)
      .where(inArray(entryAuthors.entryId, rows.map((r) => r.id)));
    const byEntry = new Map<string, string[]>();
    for (const l of links) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l.personId]);
    return rows.map((r) => ({ ...r, authors: (byEntry.get(r.id) ?? []).sort() }));
  }

  private async setAuthors(entryId: string, authors: string[]) {
    await this.db.delete(entryAuthors).where(eq(entryAuthors.entryId, entryId));
    if (authors.length > 0) {
      await this.db.insert(entryAuthors).values(authors.map((personId) => ({ entryId, personId })));
    }
  }

  async findPersonByTokenHash(hash: string) {
    const [row] = await this.db.select().from(people).where(eq(people.tokenHash, hash));
    return row ? toPerson(row) : null;
  }

  async listPeople() {
    return (await this.db.select().from(people).orderBy(asc(people.id))).map(toPerson);
  }

  async addPerson(p: { id: string; name: string; isSystem: boolean }, tokenHash: string) {
    const [row] = await this.db.insert(people).values({ ...p, tokenHash }).returning();
    return toPerson(row!);
  }

  async touchLastSeen(personId: string, at: Date) {
    await this.db.update(people).set({ lastSeenAt: at }).where(eq(people.id, personId));
  }

  async setTokenHash(personId: string, tokenHash: string) {
    const [row] = await this.db.update(people).set({ tokenHash }).where(eq(people.id, personId)).returning();
    return row ? toPerson(row) : null;
  }

  async getEntry(id: string, opts?: { forUpdate?: boolean }) {
    const q = this.db.select().from(entries).where(eq(entries.id, id));
    const [row] = await (opts?.forUpdate ? q.for('update') : q);
    return row ? (await this.withAuthors([row]))[0]! : null;
  }

  async listEntries(f: EntryFilter) {
    const rows = await this.db.select().from(entries)
      .where(and(
        isNull(entries.deletedAt),
        f.type ? eq(entries.type, f.type) : undefined,
        f.status ? eq(entries.status, f.status) : undefined,
        f.area ? eq(entries.area, f.area) : undefined,
      ))
      .orderBy(desc(entries.createdAt)).limit(f.limit ?? DEFAULT_LIMIT);
    return this.withAuthors(rows);
  }

  async search(q: string, f: { area?: string; limit?: number }) {
    if (q.trim() === '') return this.listEntries({ area: f.area, limit: f.limit });
    // shortcut: 'simple' config with no stemming or index; switch to a GIN index/embeddings if search misses or gets slow
    const doc = sql`to_tsvector('simple', ${entries.title} || ' ' || coalesce(${entries.question}, '') || ' ' || ${entries.content})`;
    // websearch ANDs the words; swap to OR so partial matches still hit (ts_rank puts full matches first).
    const query = sql`replace(websearch_to_tsquery('simple', ${q})::text, '&', '|')::tsquery`;
    const rows = await this.db.select().from(entries)
      .where(and(isNull(entries.deletedAt), f.area ? eq(entries.area, f.area) : undefined, sql`${doc} @@ ${query}`))
      .orderBy(desc(sql`ts_rank(${doc}, ${query})`), desc(entries.createdAt))
      .limit(f.limit ?? DEFAULT_LIMIT);
    return this.withAuthors(rows);
  }

  async changesSince(since: Date, excludePersonId: string) {
    const rows = await this.db.select().from(entries)
      .where(or(gt(entries.deletedAt, since), gt(entries.createdAt, since), gt(entries.updatedAt, since)))
      .orderBy(desc(entries.updatedAt));
    const changes: Change[] = [];
    for (const e of await this.withAuthors(rows)) {
      // A deleted entry is only ever reported as removed, never as new or changed.
      const kind = e.deletedAt
        ? e.deletedAt > since && e.deletedBy !== excludePersonId ? 'removed' : null
        : e.createdAt > since && e.recordedBy !== excludePersonId ? 'new'
        : e.updatedBy && e.updatedAt > since && e.updatedBy !== excludePersonId ? 'changed' : null;
      if (kind) changes.push({ kind, entry: e });
    }
    return changes;
  }

  // Row + authors are written in one transaction (a savepoint when already inside one), so a bad author id leaves nothing behind.
  insertEntry(e: NewEntry): Promise<Entry> {
    const { authors, ...row } = e;
    return this.db.transaction(async (tx) => {
      const store = new PostgresStore(tx);
      const [inserted] = await tx.insert(entries).values(row).returning();
      await store.setAuthors(inserted!.id, authors);
      return (await store.getEntry(inserted!.id))!;
    });
  }

  updateEntry(id: string, patch: EntryPatch, by: string): Promise<Entry> {
    const { authors, ...cols } = patch;
    return this.db.transaction(async (tx) => {
      const store = new PostgresStore(tx);
      const [updated] = await tx.update(entries)
        .set({ ...cols, updatedAt: new Date(), updatedBy: by })
        .where(eq(entries.id, id)).returning({ id: entries.id });
      if (!updated) throw new Error(`Entry not found: ${id}`);
      if (authors) await store.setAuthors(id, authors);
      return (await store.getEntry(id))!;
    });
  }

  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new PostgresStore(tx)));
  }

  async exportAll(): Promise<Snapshot> {
    const [peopleRows, entryRows] = await Promise.all([
      this.db.select().from(people).orderBy(asc(people.id)),
      this.db.select().from(entries).orderBy(asc(entries.createdAt), asc(entries.id)),
    ]);
    return { version: 1, people: peopleRows, entries: await this.withAuthors(entryRows) };
  }

  async importAll(s: Snapshot) {
    await this.db.transaction(async (tx) => {
      const [p] = await tx.select({ n: count() }).from(people);
      const [e] = await tx.select({ n: count() }).from(entries);
      if (p!.n > 0 || e!.n > 0) throw new Error('Cannot import: the database is not empty.');
      if (s.people.length > 0) await tx.insert(people).values(s.people);
      // One multi-row statement, so entries may reference each other (supersedes/target).
      if (s.entries.length > 0) await tx.insert(entries).values(s.entries.map(({ authors: _a, ...r }) => r));
      const links = s.entries.flatMap((x) => x.authors.map((personId) => ({ entryId: x.id, personId })));
      if (links.length > 0) await tx.insert(entryAuthors).values(links);
    });
  }
}
