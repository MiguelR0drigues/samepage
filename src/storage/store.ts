import type { Change, Entry, EntryStatus, EntryType, NewEntry, Person, Snapshot } from '../domain/types';

export interface EntryFilter { type?: EntryType; status?: EntryStatus; area?: string; limit?: number;
  workstreamId?: string; supersedesId?: string; targetId?: string; ids?: string[] }
export type EntryPatch = Partial<Pick<Entry, 'type' | 'status' | 'title' | 'content' | 'question' | 'positions'
  | 'consensus' | 'consensusReason' | 'supersedesId' | 'authors' | 'resolutionNote' | 'deletedAt' | 'deletedBy'>>;

export interface Store {
  findPersonByTokenHash(hash: string): Promise<Person | null>;
  listPeople(): Promise<Person[]>;
  addPerson(p: { id: string; name: string; isSystem: boolean }, tokenHash: string): Promise<Person>;
  touchLastSeen(personId: string, at: Date): Promise<void>;
  touchDashboardSeen(personId: string, at: Date): Promise<void>;
  setDashboardNonce(personId: string, nonce: string): Promise<void>;
  // Atomic: clears the nonce only if it matches. False if it did not match.
  consumeDashboardNonce(personId: string, nonce: string): Promise<boolean>;
  // Does not touch updatedAt/updatedBy, so moved updates do not flood "what's new". Returns rows moved.
  moveUpdates(fromWorkstreamId: string, toWorkstreamId: string): Promise<number>;
  setTokenHash(personId: string, tokenHash: string): Promise<Person | null>; // null if the person does not exist
  // Includes deleted. forUpdate locks the row (SELECT ... FOR UPDATE) until the transaction ends: call it inside transaction() to serialize concurrent changes.
  getEntry(id: string, opts?: { forUpdate?: boolean }): Promise<Entry | null>;
  listEntries(f: EntryFilter): Promise<Entry[]>;                 // excludes deleted, newest first, limit default 20
  search(q: string, f: { area?: string; limit?: number }): Promise<Entry[]>; // excludes deleted
  listAreas(): Promise<string[]>;                                // distinct areas of non-deleted entries, sorted
  changesSince(since: Date, excludePersonId: string): Promise<Change[]>;
  insertEntry(e: NewEntry): Promise<Entry>;
  updateEntry(id: string, patch: EntryPatch, by: string): Promise<Entry>; // sets updatedAt=now, updatedBy=by
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  exportAll(): Promise<Snapshot>;
  importAll(s: Snapshot): Promise<void>;                        // throws if the database is not empty
}
