export type EntryType = 'decision' | 'view' | 'principle' | 'exploration' | 'proposal' | 'update' | 'workstream';
export type EntryStatus = 'active' | 'superseded' | 'under_review' | 'open' | 'accepted' | 'rejected'
  | 'in_progress' | 'blocked' | 'done';
export type Consensus = 'unanimous' | 'majority' | 'no_consensus';
export type SourceKind = 'meet' | 'claude_code' | 'explicit';
export interface Position { person: string; position: string; arguments?: string }
export interface Person { id: string; name: string; isSystem: boolean; lastSeenAt: Date | null }
export interface Entry {
  id: string; type: EntryType; status: EntryStatus; title: string; content: string;
  question: string | null; positions: Position[] | null; consensus: Consensus | null;
  consensusReason: string | null; area: string; sourceKind: SourceKind; sourceRef: string | null;
  authors: string[]; recordedBy: string; updatedBy: string | null;
  supersedesId: string | null; targetId: string | null; resolutionNote: string | null;
  workstreamId: string | null;
  createdAt: Date; updatedAt: Date; deletedAt: Date | null; deletedBy: string | null;
}
export type NewEntry = Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy' | 'deletedAt' | 'deletedBy'>;
export interface Change { kind: 'new' | 'changed' | 'removed'; entry: Entry }
export interface Snapshot { version: 1; people: (Person & { tokenHash: string })[]; entries: Entry[] }
