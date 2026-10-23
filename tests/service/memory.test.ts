import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { Memory, MemoryError, type RecordInput } from '../../src/service/memory';
import type { Person } from '../../src/domain/types';

let store: PostgresStore;
let memory: Memory;
let miguel: Person;
let joao: Person;
let meet: Person;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  memory = new Memory(store);
  miguel = await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, 'h-miguel');
  joao = await store.addPerson({ id: 'joao', name: 'Joao', isSystem: false }, 'h-joao');
  meet = await store.addPerson({ id: 'meet', name: 'Meet', isSystem: true }, 'h-meet');
});

const decision = (over: Partial<RecordInput> = {}): RecordInput => ({
  type: 'decision', title: 'Use Neon', content: 'We use Neon.', area: 'infra', ...over,
});
const team = { authors: ['miguel', 'joao'] };
const sorted = (a: string[]) => [...a].sort();

describe('Memory.record', () => {
  it('uses the actor as the default author', async () => {
    const e = await memory.record(miguel, decision());
    expect(e.authors).toEqual(['miguel']);
    expect(e.status).toBe('active');
    expect(e.sourceKind).toBe('explicit');
    expect(e.recordedBy).toBe('miguel');
  });

  it('rejects unknown authors with the list of valid ids', async () => {
    const err = await memory.record(miguel, decision({ authors: ['miguel', 'ana'] })).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryError);
    expect(err.message).toContain('Unknown authors: ana');
    expect(err.message).toContain('joao, miguel');
    expect(await store.listEntries({})).toEqual([]);
  });

  it('by the system requires authors', async () => {
    await expect(memory.record(meet, decision())).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.record(meet, decision({ authors: ['meet'] }))).rejects.toThrow('Unknown authors: meet');
    const e = await memory.record(meet, decision({ authors: ['miguel'], sourceKind: 'meet' }));
    expect(e.recordedBy).toBe('meet');
  });
});

describe('Memory.remove / correctText', () => {
  it('only authors can delete', async () => {
    const e = await memory.record(miguel, decision());
    await expect(memory.remove(joao, e.id)).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.remove(meet, e.id)).rejects.toBeInstanceOf(MemoryError);
    await memory.remove(miguel, e.id);
    const gone = await store.getEntry(e.id);
    expect(gone?.deletedAt).not.toBeNull();
    expect(gone?.deletedBy).toBe('miguel');
  });

  it('a deleted entry disappears from listEntries', async () => {
    const e = await memory.record(miguel, decision());
    await memory.remove(miguel, e.id);
    expect(await store.listEntries({})).toEqual([]);
  });

  it('a decision verdict cannot be edited', async () => {
    const e = await memory.record(miguel, decision());
    await expect(memory.correctText(miguel, e.id, { content: 'New verdict' }))
      .rejects.toThrow('A decision verdict cannot be edited: use supersede_decision or propose_revision.');
  });

  it('an author can correct the title, others cannot', async () => {
    const e = await memory.record(miguel, decision());
    expect((await memory.correctText(miguel, e.id, { title: 'Use Neon DB' })).title).toBe('Use Neon DB');
    await expect(memory.correctText(joao, e.id, { title: 'x' })).rejects.toBeInstanceOf(MemoryError);
  });

  it('content of a non-decision can be corrected', async () => {
    const e = await memory.record(miguel, decision({ type: 'view' }));
    expect((await memory.correctText(miguel, e.id, { content: 'Better' })).content).toBe('Better');
  });
});

describe('Memory.supersede', () => {
  it('a team decision supersedes directly', async () => {
    const old = await memory.record(miguel, decision(team));
    const { entry, outcome } = await memory.supersede(joao, old.id, decision({ ...team, title: 'Use Supabase' }));
    expect(outcome).toBe('superseded');
    expect(entry.status).toBe('active');
    expect(entry.supersedesId).toBe(old.id);
    expect((await store.getEntry(old.id))?.status).toBe('superseded');
  });

  it('one person against a team decision creates a proposal', async () => {
    const old = await memory.record(miguel, decision(team));
    const { entry, outcome } = await memory.supersede(joao, old.id, decision({ title: 'Use Supabase' }));
    expect(outcome).toBe('proposal');
    expect(entry).toMatchObject({ type: 'proposal', status: 'open', targetId: old.id, authors: ['joao'] });
    expect((await store.getEntry(old.id))?.status).toBe('under_review');
  });

  it('a sole owner supersedes their own decision directly', async () => {
    const old = await memory.record(miguel, decision());
    const { entry, outcome } = await memory.supersede(miguel, old.id, decision({ title: 'v2' }));
    expect(outcome).toBe('superseded');
    expect(entry.supersedesId).toBe(old.id);
  });

  it('a meet decision counts as a team decision', async () => {
    const old = await memory.record(miguel, decision(team));
    const { outcome } = await memory.supersede(meet, old.id, decision({ authors: ['joao'], sourceKind: 'meet' }));
    expect(outcome).toBe('superseded');
  });

  it('only an active decision can be superseded', async () => {
    const old = await memory.record(miguel, decision());
    await memory.supersede(miguel, old.id, decision());
    await expect(memory.supersede(miguel, old.id, decision())).rejects.toThrow('This decision is no longer active.');
    const view = await memory.record(miguel, decision({ type: 'view' }));
    await expect(memory.supersede(miguel, view.id, decision())).rejects.toThrow('This decision is no longer active.');
  });

  it('concurrent supersessions: only one wins', async () => {
    const old = await memory.record(miguel, decision(team));
    const results = await Promise.allSettled([
      memory.supersede(miguel, old.id, decision({ ...team, title: 'A' })),
      memory.supersede(joao, old.id, decision({ ...team, title: 'B' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.message).toBe('This decision is no longer active.');
    expect(await store.listEntries({ type: 'decision', status: 'active' })).toHaveLength(1);
  });
});

describe('proposals', () => {
  async function openProposal() {
    const old = await memory.record(miguel, decision());
    const proposal = await memory.proposeRevision(joao, old.id, { title: 'Use Supabase', content: 'Switch.', justification: 'Cheaper' });
    return { old, proposal };
  }

  it('proposeRevision stores the justification', async () => {
    const { old, proposal } = await openProposal();
    expect(proposal).toMatchObject({
      type: 'proposal', status: 'open', targetId: old.id, authors: ['joao'],
      content: 'Switch.\n\nJustification: Cheaper', resolutionNote: null, area: 'infra',
    });
    expect((await store.getEntry(old.id))?.status).toBe('under_review');
  });

  it('another person accepts a proposal and it supersedes the original', async () => {
    const { old, proposal } = await openProposal();
    const accepted = await memory.acceptProposal(miguel, proposal.id);
    expect(accepted).toMatchObject({ type: 'decision', status: 'active', supersedesId: old.id });
    expect(sorted(accepted.authors)).toEqual(['joao', 'miguel']);
    expect((await store.getEntry(old.id))?.status).toBe('superseded');
  });

  it('rejecting restores the original to active and stores the reason', async () => {
    const { old, proposal } = await openProposal();
    const rejected = await memory.rejectProposal(miguel, proposal.id, 'Too risky');
    expect(rejected).toMatchObject({ status: 'rejected', resolutionNote: 'Too risky' });
    expect((await store.getEntry(old.id))?.status).toBe('active');
  });

  it('cannot accept or reject your own proposal', async () => {
    const { old, proposal } = await openProposal();
    await expect(memory.acceptProposal(joao, proposal.id)).rejects.toThrow('You cannot close your own proposal.');
    await expect(memory.rejectProposal(joao, proposal.id)).rejects.toThrow('You cannot close your own proposal.');
    expect((await store.getEntry(proposal.id))?.status).toBe('open');
    expect((await store.getEntry(old.id))?.status).toBe('under_review');
  });

  it('cannot accept an already closed proposal', async () => {
    const { proposal } = await openProposal();
    await memory.rejectProposal(miguel, proposal.id);
    await expect(memory.acceptProposal(miguel, proposal.id)).rejects.toThrow('This proposal is already closed.');
    await expect(memory.rejectProposal(miguel, proposal.id)).rejects.toThrow('This proposal is already closed.');
  });

  it('cannot propose a revision while one is open', async () => {
    const { old } = await openProposal();
    await expect(memory.proposeRevision(joao, old.id, { title: 't', content: 'c', justification: 'j' }))
      .rejects.toThrow('This decision already has an open proposal.');
  });

  it('a system actor cannot accept or reject', async () => {
    const { proposal } = await openProposal();
    await expect(memory.acceptProposal(meet, proposal.id)).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.rejectProposal(meet, proposal.id)).rejects.toBeInstanceOf(MemoryError);
  });
});
