export type EntryType = 'decision' | 'view' | 'principle' | 'exploration' | 'proposal' | 'update' | 'workstream';
export type EntryStatus = 'active' | 'superseded' | 'under_review' | 'open' | 'accepted' | 'rejected'
  | 'in_progress' | 'blocked' | 'done';
export type Consensus = 'unanimous' | 'majority' | 'no_consensus';
export type SourceKind = 'meet' | 'claude_code' | 'explicit';
export interface Position { person: string; position: string; arguments?: string }
export interface Person { id: string; name: string; isSystem: boolean; lastSeenAt: Date | null; dashboardSeenAt: Date | null }
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
export type CandidateType = 'decision' | 'principle' | 'view' | 'exploration';
// replaces: the active decision a confirmed decision supersedes.
export interface Candidate { type: CandidateType; title: string; content: string; area: string; authors?: string[]; question?: string; replaces?: string }
export type PendingAnswer = 'record' | 'personal' | 'skip';
export interface Pending {
  id: string; personId: string; candidate: Candidate; question: string; sourceRef: string | null;
  status: 'open' | 'answered'; answer: PendingAnswer | null; createdAt: Date; answeredAt: Date | null;
}
export type CorrectionVerdict = 'company' | 'personal' | 'not_worth_recording';
export interface Correction { id: string; personId: string; verdict: CorrectionVerdict; candidate: Candidate; createdAt: Date }
// pending/corrections are optional so Phase 1 exports still import.
export interface PersonToken { personId: string; tokenHash: string; createdAt: Date }
type SnapshotBody = { entries: Entry[]; pending?: Pending[]; corrections?: Correction[] };
type SnapshotPerson = Person & { dashboardNonce?: string | null };
export type SnapshotV2 = SnapshotBody & { version: 2; people: SnapshotPerson[]; tokens: PersonToken[] };
// Old exports kept one token per person on the person row.
export type SnapshotV1 = SnapshotBody & { version: 1; people: (SnapshotPerson & { tokenHash: string })[] };
export type Snapshot = SnapshotV1 | SnapshotV2;
