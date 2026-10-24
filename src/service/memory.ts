import type { CandidateType, Consensus, Entry, EntryType, NewEntry, Person, Position, SourceKind } from '../domain/types';
import type { Store } from '../storage/store';

export class MemoryError extends Error {}

export interface RecordInput {
  type: Exclude<EntryType, 'proposal'>; title: string; content: string; area: string;
  authors?: string[]; question?: string; positions?: Position[]; consensus?: Consensus;
  consensusReason?: string; sourceKind?: SourceKind; sourceRef?: string; workstreamId?: string;
}

type TextPatch = Partial<Pick<Entry, 'title' | 'question' | 'positions' | 'consensusReason' | 'content'>>;

const NOT_ACTIVE = 'This decision is no longer active.';

// Only the system actor (Meet) speaks for the team when it records a meeting; a human claiming 'meet' does not.
const isTeam = (actor: Person, authors: string[], sourceKind: SourceKind) =>
  authors.length >= 2 || (sourceKind === 'meet' && actor.isSystem);

export const CANDIDATE_TYPES: CandidateType[] = ['decision', 'principle', 'view', 'exploration'];
export const isCandidateType = (t: EntryType): t is CandidateType => (CANDIDATE_TYPES as EntryType[]).includes(t);

export function assertHuman(actor: Person) {
  if (actor.isSystem) throw new MemoryError('A system actor cannot perform this action.');
}

function assertAuthor(actor: Person, e: Entry) {
  assertHuman(actor);
  if (!e.authors.includes(actor.id)) throw new MemoryError('Only the authors of this entry can do that.');
}

async function load(store: Store, id: string, opts?: { forUpdate?: boolean }): Promise<Entry> {
  const e = await store.getEntry(id, opts);
  if (!e || e.deletedAt) throw new MemoryError(`Entry not found: ${id}`);
  return e;
}

export class Memory {
  constructor(private store: Store) {}

  private async resolveAuthors(actor: Person, authors?: string[]): Promise<string[]> {
    if (actor.isSystem && !authors?.length) throw new MemoryError('A system actor must specify authors.');
    const list = authors?.length ? authors : [actor.id];
    const valid = (await this.store.listPeople()).filter((p) => !p.isSystem).map((p) => p.id).sort();
    const unknown = list.filter((a) => !valid.includes(a));
    if (unknown.length) throw new MemoryError(`Unknown authors: ${unknown.join(', ')}. Valid ids: ${valid.join(', ')}`);
    return [...new Set(list)];
  }

  private toNewEntry(actor: Person, input: RecordInput, authors: string[]): NewEntry {
    return {
      type: input.type, status: 'active', title: input.title, content: input.content, area: input.area,
      question: input.question ?? null, positions: input.positions ?? null, consensus: input.consensus ?? null,
      consensusReason: input.consensusReason ?? null, sourceKind: input.sourceKind ?? 'explicit',
      sourceRef: input.sourceRef ?? null, authors, recordedBy: actor.id,
      supersedesId: null, targetId: null, resolutionNote: null, workstreamId: null,
    };
  }

  async record(actor: Person, input: RecordInput): Promise<Entry> {
    if (input.workstreamId && input.type !== 'update') throw new MemoryError('Only updates can link to a workstream.');
    const next = this.toNewEntry(actor, input, await this.resolveAuthors(actor, input.authors));
    if (input.type === 'workstream') return this.store.insertEntry({ ...next, status: 'in_progress' });
    if (input.type !== 'update') return this.store.insertEntry(next);
    // Lock the workstream so a concurrent delete cannot leave a dangling link.
    return this.store.transaction(async (tx) => {
      const w = input.workstreamId ? await tx.getEntry(input.workstreamId, { forUpdate: true }) : null;
      if (w?.type !== 'workstream' || w.deletedAt) {
        throw new MemoryError('An update needs an existing workstream: use list_workstreams or record a workstream first.');
      }
      return tx.insertEntry({ ...next, workstreamId: w.id });
    });
  }

  async setWorkstreamStatus(actor: Person, id: string, status: 'in_progress' | 'blocked' | 'done'): Promise<Entry> {
    assertHuman(actor);
    return this.store.transaction(async (tx) => {
      const w = await load(tx, id, { forUpdate: true });
      if (w.type !== 'workstream') throw new MemoryError(`Entry not found: ${id}`);
      return tx.updateEntry(id, { status }, actor.id);
    });
  }

  async correctText(actor: Person, id: string, patch: TextPatch): Promise<Entry> {
    const e = await load(this.store, id);
    assertAuthor(actor, e);
    if (e.type === 'decision' && patch.content !== undefined) {
      throw new MemoryError('A decision verdict cannot be edited: use supersede_decision or propose_revision.');
    }
    // Pick the allowed keys: callers come from the MCP boundary and could pass anything.
    const { title, question, positions, consensusReason, content } = patch;
    return this.store.updateEntry(id, { title, question, positions, consensusReason, content }, actor.id);
  }

  async remove(actor: Person, id: string, reason?: 'personal' | 'not_worth_recording'): Promise<void> {
    await this.store.transaction(async (tx) => {
      const e = await load(tx, id, { forUpdate: true });
      assertAuthor(actor, e);
      if (e.type === 'decision' && e.status === 'under_review') {
        throw new MemoryError('Close the open proposal for this decision first.');
      }
      await tx.updateEntry(id, { deletedAt: new Date(), deletedBy: actor.id }, actor.id);
      // Deleting an open proposal must not leave its target stuck in review.
      if (e.type === 'proposal' && e.status === 'open' && e.targetId) {
        await tx.updateEntry(e.targetId, { status: 'active' }, actor.id);
      }
      // Teaches the extractor what this person does not want captured. Personal text does not stay on the server.
      if (reason && e.sourceKind === 'claude_code' && isCandidateType(e.type)) {
        await tx.insertCorrection({ personId: actor.id, verdict: reason,
          candidate: { type: e.type, title: e.title, content: reason === 'personal' ? '' : e.content, area: e.area } });
      }
    });
  }

  async supersede(actor: Person, oldId: string, input: RecordInput): Promise<{ entry: Entry; outcome: 'superseded' | 'proposal' }> {
    const authors = await this.resolveAuthors(actor, input.authors);
    const next = this.toNewEntry(actor, { ...input, type: 'decision' }, authors);
    return this.store.transaction(async (tx) => {
      const old = await load(tx, oldId, { forUpdate: true });
      if (old.type !== 'decision' || old.status !== 'active') throw new MemoryError(NOT_ACTIVE);
      if (isTeam(actor, authors, next.sourceKind) || (old.authors.length === 1 && old.authors[0] === actor.id)) {
        const entry = await tx.insertEntry({ ...next, supersedesId: old.id });
        await tx.updateEntry(old.id, { status: 'superseded' }, actor.id);
        return { entry, outcome: 'superseded' as const };
      }
      const entry = await tx.insertEntry({ ...next, type: 'proposal', status: 'open', targetId: old.id });
      await tx.updateEntry(old.id, { status: 'under_review' }, actor.id);
      return { entry, outcome: 'proposal' as const };
    });
  }

  async proposeRevision(actor: Person, decisionId: string, input: { title: string; content: string; justification: string }): Promise<Entry> {
    assertHuman(actor);
    return this.store.transaction(async (tx) => {
      const old = await load(tx, decisionId, { forUpdate: true });
      if (old.type === 'decision' && old.status === 'under_review') {
        throw new MemoryError('This decision already has an open proposal.');
      }
      if (old.type !== 'decision' || old.status !== 'active') throw new MemoryError(NOT_ACTIVE);
      const entry = await tx.insertEntry({
        ...this.toNewEntry(actor, { type: 'decision', title: input.title, area: old.area,
          content: `${input.content}\n\nJustification: ${input.justification}` }, [actor.id]),
        type: 'proposal', status: 'open', targetId: old.id,
      });
      await tx.updateEntry(old.id, { status: 'under_review' }, actor.id);
      return entry;
    });
  }

  // Both closers lock the proposal, check it is open and not the actor's own, then run `apply`.
  private async closeProposal(actor: Person, id: string, apply: (tx: Store, p: Entry) => Promise<Entry>): Promise<Entry> {
    assertHuman(actor);
    return this.store.transaction(async (tx) => {
      const p = await load(tx, id, { forUpdate: true });
      if (p.type !== 'proposal') throw new MemoryError(`Entry not found: ${id}`);
      if (p.status !== 'open') throw new MemoryError('This proposal is already closed.');
      if (p.authors.includes(actor.id) || p.recordedBy === actor.id) throw new MemoryError('You cannot close your own proposal.');
      return apply(tx, p);
    });
  }

  acceptProposal(actor: Person, id: string): Promise<Entry> {
    return this.closeProposal(actor, id, async (tx, p) => {
      const entry = await tx.updateEntry(p.id, {
        type: 'decision', status: 'active', supersedesId: p.targetId, authors: [...p.authors, actor.id],
      }, actor.id);
      await tx.updateEntry(p.targetId!, { status: 'superseded' }, actor.id);
      return entry;
    });
  }

  rejectProposal(actor: Person, id: string, note?: string): Promise<Entry> {
    return this.closeProposal(actor, id, async (tx, p) => {
      const entry = await tx.updateEntry(p.id, { status: 'rejected', resolutionNote: note ?? null }, actor.id);
      await tx.updateEntry(p.targetId!, { status: 'active' }, actor.id);
      return entry;
    });
  }
}
