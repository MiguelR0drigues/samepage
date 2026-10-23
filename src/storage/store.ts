import type { Change, Entry, EntryStatus, EntryType, NewEntry, Person, Snapshot } from '../domain/types';

export interface EntryFilter { type?: EntryType; status?: EntryStatus; area?: string; limit?: number }
export type EntryPatch = Partial<Pick<Entry, 'type' | 'status' | 'title' | 'content' | 'question' | 'positions'
  | 'consensus' | 'consensusReason' | 'supersedesId' | 'authors' | 'resolutionNote' | 'deletedAt' | 'deletedBy'>>;

export interface Store {
  findPersonByTokenHash(hash: string): Promise<Person | null>;
  listPeople(): Promise<Person[]>;
  addPerson(p: { id: string; name: string; isSystem: boolean }, tokenHash: string): Promise<Person>;
  touchLastSeen(personId: string, at: Date): Promise<void>;
  getEntry(id: string): Promise<Entry | null>;                  // includes deleted
  listEntries(f: EntryFilter): Promise<Entry[]>;                 // excludes deleted, newest first, limit default 20
  search(q: string, f: { area?: string; limit?: number }): Promise<Entry[]>; // excludes deleted
  changesSince(since: Date, excludePersonId: string): Promise<Change[]>;
  insertEntry(e: NewEntry): Promise<Entry>;
  updateEntry(id: string, patch: EntryPatch, by: string): Promise<Entry>; // sets updatedAt=now, updatedBy=by
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  exportAll(): Promise<Snapshot>;
  importAll(s: Snapshot): Promise<void>;                        // throws if the database is not empty
}
