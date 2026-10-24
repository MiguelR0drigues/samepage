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

  it('an author can correct the title, others cannot, omitted fields stay unchanged', async () => {
    const positions = [{ person: 'miguel', position: 'yes' }];
    const e = await memory.record(miguel, decision({ question: 'Which DB?', positions, consensusReason: 'why' }));
    const u = await memory.correctText(miguel, e.id, { title: 'Use Neon DB' });
    expect(u).toMatchObject({ title: 'Use Neon DB', content: 'We use Neon.', question: 'Which DB?', positions, consensusReason: 'why' });
    await expect(memory.correctText(joao, e.id, { title: 'x' })).rejects.toBeInstanceOf(MemoryError);
  });

  it('deleting an open proposal restores its target to active', async () => {
    const old = await memory.record(miguel, decision());
    const p = await memory.proposeRevision(joao, old.id, { title: 't', content: 'c', justification: 'j' });
    await memory.remove(joao, p.id);
    expect((await store.getEntry(p.id))?.deletedAt).not.toBeNull();
    expect((await store.getEntry(old.id))?.status).toBe('active');
    await expect(memory.proposeRevision(joao, old.id, { title: 't2', content: 'c', justification: 'j' })).resolves.toBeDefined();
  });

  it('cannot delete a decision that is under review', async () => {
    const old = await memory.record(miguel, decision());
    await memory.proposeRevision(joao, old.id, { title: 't', content: 'c', justification: 'j' });
    await expect(memory.remove(miguel, old.id)).rejects.toThrow('Close the open proposal for this decision first.');
    const after = await store.getEntry(old.id);
    expect(after).toMatchObject({ status: 'under_review', deletedAt: null });
  });

  it('removing an auto-captured entry with a reason stores a correction', async () => {
    const e = await memory.record(miguel, decision({ type: 'view', sourceKind: 'claude_code', sourceRef: 'claude_code:s1' }));
    await memory.remove(miguel, e.id, 'personal');
    expect((await store.getEntry(e.id))?.deletedAt).not.toBeNull();
    expect(await store.listCorrections('miguel', 10)).toMatchObject([{
      verdict: 'personal', candidate: { type: 'view', title: 'Use Neon', content: '', area: 'infra' },
    }]);
  });

  it('removing an auto-captured entry as not worth recording keeps its content in the correction', async () => {
    const e = await memory.record(miguel, decision({ type: 'view', sourceKind: 'claude_code', sourceRef: 'claude_code:s1' }));
    await memory.remove(miguel, e.id, 'not_worth_recording');
    expect((await store.listCorrections('miguel', 10))[0]?.candidate.content).toBe('We use Neon.');
  });

  it('a reason on an explicit entry stores nothing', async () => {
    const e = await memory.record(miguel, decision());
    await memory.remove(miguel, e.id, 'not_worth_recording');
    expect(await store.listCorrections('miguel', 10)).toEqual([]);
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

  it('source "meet" from a human does not make a team decision', async () => {
    const old = await memory.record(miguel, decision(team));
    const { outcome } = await memory.supersede(joao, old.id, decision({ authors: ['joao'], sourceKind: 'meet' }));
    expect(outcome).toBe('proposal');
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

  it('cannot close a proposal you recorded even if you are not an author', async () => {
    const old = await memory.record(miguel, decision(team));
    const { entry } = await memory.supersede(miguel, old.id, decision({ authors: ['joao'], title: 'Use Supabase' }));
    expect(entry).toMatchObject({ type: 'proposal', recordedBy: 'miguel', authors: ['joao'] });
    await expect(memory.acceptProposal(miguel, entry.id)).rejects.toThrow('You cannot close your own proposal.');
    await expect(memory.rejectProposal(miguel, entry.id)).rejects.toThrow('You cannot close your own proposal.');
    expect((await store.getEntry(entry.id))?.status).toBe('open');
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

  it('a system actor cannot propose a revision', async () => {
    const old = await memory.record(miguel, decision());
    await expect(memory.proposeRevision(meet, old.id, { title: 't', content: 'c', justification: 'j' }))
      .rejects.toBeInstanceOf(MemoryError);
    expect((await store.getEntry(old.id))?.status).toBe('active');
  });

  it('a system actor superseding a team decision creates a proposal with the given authors', async () => {
    const old = await memory.record(miguel, decision(team));
    const { entry, outcome } = await memory.supersede(meet, old.id, decision({ authors: ['joao'], sourceKind: 'claude_code' }));
    expect(outcome).toBe('proposal');
    expect(entry.authors).toEqual(['joao']);
  });

  it('a system actor cannot accept or reject', async () => {
    const { proposal } = await openProposal();
    await expect(memory.acceptProposal(meet, proposal.id)).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.rejectProposal(meet, proposal.id)).rejects.toBeInstanceOf(MemoryError);
  });
});

describe('progress tracking', () => {
  const workstream = (over: Partial<RecordInput> = {}): RecordInput => ({
    type: 'workstream', title: 'Launch site', content: 'Ship the landing page.', area: 'marketing', ...over,
  });
  const update = (workstreamId?: string): RecordInput => ({
    type: 'update', title: 'Hero done', content: 'Hero section merged.', area: 'marketing', workstreamId,
  });

  it('records a workstream as in_progress and an update linked to it', async () => {
    const w = await memory.record(miguel, workstream());
    expect(w.status).toBe('in_progress');
    const u = await memory.record(joao, update(w.id));
    expect(u.status).toBe('active');
    expect(u.workstreamId).toBe(w.id);
  });

  it('rejects an update without, with a bogus, a deleted or a non-workstream target', async () => {
    const w = await memory.record(miguel, workstream());
    const d = await memory.record(miguel, decision());
    await memory.remove(miguel, w.id);
    for (const id of [undefined, '00000000-0000-0000-0000-000000000000', w.id, d.id]) {
      const err = await memory.record(miguel, update(id)).catch((e) => e);
      expect(err).toBeInstanceOf(MemoryError);
      expect(err.message).toContain('An update needs an existing workstream');
    }
    expect(await store.listEntries({ type: 'update' })).toEqual([]);
  });

  it('rejects workstreamId on other types', async () => {
    const w = await memory.record(miguel, workstream());
    await expect(memory.record(miguel, decision({ workstreamId: w.id }))).rejects.toThrow('Only updates can link to a workstream.');
    await expect(memory.record(miguel, workstream({ workstreamId: w.id }))).rejects.toThrow('Only updates can link to a workstream.');
  });

  it('any human can set the workstream status; a system actor cannot', async () => {
    const w = await memory.record(miguel, workstream());
    expect((await memory.setWorkstreamStatus(joao, w.id, 'blocked')).status).toBe('blocked');
    expect((await memory.setWorkstreamStatus(joao, w.id, 'done')).status).toBe('done');
    await expect(memory.setWorkstreamStatus(meet, w.id, 'blocked')).rejects.toBeInstanceOf(MemoryError);
    expect((await store.getEntry(w.id))?.status).toBe('done');
  });

  it('setWorkstreamStatus only targets live workstreams', async () => {
    const d = await memory.record(miguel, decision());
    await expect(memory.setWorkstreamStatus(miguel, d.id, 'done')).rejects.toBeInstanceOf(MemoryError);
    const w = await memory.record(miguel, workstream());
    await memory.remove(miguel, w.id);
    await expect(memory.setWorkstreamStatus(miguel, w.id, 'done')).rejects.toBeInstanceOf(MemoryError);
  });
});
