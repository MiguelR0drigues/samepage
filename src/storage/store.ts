import type { Change, Correction, Entry, EntryStatus, EntryType, NewEntry, Pending, PendingAnswer, Person, Snapshot } from '../domain/types';

export interface EntryFilter { type?: EntryType; status?: EntryStatus; area?: string; limit?: number }
export type EntryPatch = Partial<Pick<Entry, 'type' | 'status' | 'title' | 'content' | 'question' | 'positions'
  | 'consensus' | 'consensusReason' | 'supersedesId' | 'authors' | 'resolutionNote' | 'deletedAt' | 'deletedBy'>>;

export interface Store {
  findPersonByTokenHash(hash: string): Promise<Person | null>;
  listPeople(): Promise<Person[]>;
  addPerson(p: { id: string; name: string; isSystem: boolean }, tokenHash: string): Promise<Person>;
  touchLastSeen(personId: string, at: Date): Promise<void>;
  setTokenHash(personId: string, tokenHash: string): Promise<Person | null>; // null if the person does not exist
  // Includes deleted. forUpdate locks the row (SELECT ... FOR UPDATE) until the transaction ends: call it inside transaction() to serialize concurrent changes.
  getEntry(id: string, opts?: { forUpdate?: boolean }): Promise<Entry | null>;
  listEntries(f: EntryFilter): Promise<Entry[]>;                 // excludes deleted, newest first, limit default 20
  search(q: string, f: { area?: string; limit?: number }): Promise<Entry[]>; // excludes deleted
  changesSince(since: Date, excludePersonId: string): Promise<Change[]>;
  insertEntry(e: NewEntry): Promise<Entry>;
  updateEntry(id: string, patch: EntryPatch, by: string): Promise<Entry>; // sets updatedAt=now, updatedBy=by
  insertPending(p: Pick<Pending, 'personId' | 'candidate' | 'question' | 'sourceRef'>): Promise<Pending>;
  getPending(id: string, opts?: { forUpdate?: boolean }): Promise<Pending | null>;
  listPending(personId: string, limit?: number): Promise<Pending[]>;   // open only, oldest first, default 20
  answerPending(id: string, answer: PendingAnswer, at: Date): Promise<Pending>;
  insertCorrection(c: Pick<Correction, 'personId' | 'verdict' | 'candidate'>): Promise<Correction>;
  listCorrections(personId: string, limit: number): Promise<Correction[]>; // newest first
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  exportAll(): Promise<Snapshot>;
  importAll(s: Snapshot): Promise<void>;                        // throws if the database is not empty
}
