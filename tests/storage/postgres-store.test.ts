import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import type { Candidate, NewEntry } from '../../src/domain/types';

const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const base = (over: Partial<NewEntry> = {}): NewEntry => ({
  type: 'decision', status: 'active', title: 'Title', content: 'Content', question: null,
  positions: null, consensus: null, consensusReason: null, area: 'general', sourceKind: 'explicit',
  sourceRef: null, authors: ['miguel'], recordedBy: 'miguel', supersedesId: null, targetId: null,
  resolutionNote: null, workstreamId: null, ...over,
});

const cand = (over: Partial<Candidate> = {}): Candidate => ({ type: 'decision', title: 'T', content: 'C', area: 'general', ...over });

async function setup() {
  const store = new PostgresStore(await createTestDb());
  await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, 'h-miguel');
  await store.addPerson({ id: 'joao', name: 'Joao', isSystem: false }, 'h-joao');
  return store;
}

let store: PostgresStore;
beforeEach(async () => { store = await setup(); });

describe('PostgresStore', () => {
  it('inserts and reads an entry with authors', async () => {
    const e = await store.insertEntry(base({ authors: ['miguel', 'joao'] }));
    expect((await store.getEntry(e.id))?.authors).toEqual(['joao', 'miguel']);
  });

  it('replaces authors on update', async () => {
    const e = await store.insertEntry(base({ authors: ['miguel', 'joao'] }));
    const u = await store.updateEntry(e.id, { authors: ['joao'] }, 'joao');
    expect(u.authors).toEqual(['joao']);
    expect(u.updatedBy).toBe('joao');
  });

  it('finds a person by token hash', async () => {
    expect((await store.findPersonByTokenHash('h-miguel'))?.id).toBe('miguel');
    expect(await store.findPersonByTokenHash('x')).toBeNull();
  });

  it('searches by text', async () => {
    await store.insertEntry(base({ title: 'Per-seat pricing' }));
    await sleep();
    await store.insertEntry(base({ title: 'Use Neon' }));
    expect((await store.search('pricing', {})).map((e) => e.title)).toEqual(['Per-seat pricing']);
    expect((await store.search('', {})).map((e) => e.title)).toEqual(['Use Neon', 'Per-seat pricing']);
    await expect(store.search('"; drop table', {})).resolves.toBeDefined();
  });

  it('matches entries containing any of the search words, not all', async () => {
    await store.insertEntry(base({ title: 'Per-seat pricing' }));
    await store.insertEntry(base({ title: 'Use Neon' }));
    expect((await store.search('pricing model', {})).map((e) => e.title)).toEqual(['Per-seat pricing']);
    expect(await store.search('kubernetes cluster', {})).toEqual([]);
  });

  it('listEntries filters by type and status and excludes deleted', async () => {
    await store.insertEntry(base({ title: 'a' }));
    await store.insertEntry(base({ title: 'b', type: 'view' }));
    await store.insertEntry(base({ title: 'c', status: 'superseded' }));
    const d = await store.insertEntry(base({ title: 'd' }));
    await store.updateEntry(d.id, { deletedAt: new Date(), deletedBy: 'miguel' }, 'miguel');
    expect((await store.listEntries({ type: 'view' })).map((e) => e.title)).toEqual(['b']);
    expect((await store.listEntries({ status: 'superseded' })).map((e) => e.title)).toEqual(['c']);
    expect((await store.listEntries({})).map((e) => e.title).sort()).toEqual(['a', 'b', 'c']);
    expect(await store.listEntries({ limit: 1 })).toHaveLength(1);
  });

  it('deleted entries are absent from search and listEntries but appear in changesSince as removed', async () => {
    const e = await store.insertEntry(base({ title: 'pricing' }));
    await sleep();
    const before = new Date();
    await sleep();
    await store.updateEntry(e.id, { deletedAt: new Date(), deletedBy: 'joao' }, 'joao');
    expect(await store.search('pricing', {})).toEqual([]);
    expect(await store.listEntries({})).toEqual([]);
    expect((await store.getEntry(e.id))?.deletedBy).toBe('joao');
    const changes = await store.changesSince(before, 'miguel');
    expect(changes.map((c) => c.kind)).toEqual(['removed']);
  });

  it("changesSince excludes the person's own changes and classifies new and changed", async () => {
    const old = await store.insertEntry(base({ title: 'old' }));
    await sleep();
    const since = new Date();
    await sleep();
    const fresh = await store.insertEntry(base({ title: 'fresh' }));
    await store.updateEntry(old.id, { content: 'edited' }, 'joao');
    const mine = await store.insertEntry(base({ title: 'mine', recordedBy: 'joao', authors: ['joao'] }));
    const got = await store.changesSince(since, 'joao');
    expect(got.map((c) => [c.kind, c.entry.id])).toEqual([['new', fresh.id]]);
    const forMiguel = await store.changesSince(since, 'miguel');
    expect(forMiguel.map((c) => [c.kind, c.entry.id]).sort()).toEqual(
      [['changed', old.id], ['new', mine.id]].sort(),
    );
  });

  it('transaction rolls back if the function throws', async () => {
    await expect(store.transaction(async (tx) => {
      await tx.insertEntry(base());
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await store.listEntries({})).toEqual([]);
  });

  it('exportAll and importAll round-trip', async () => {
    const a = await store.insertEntry(base({ authors: ['miguel', 'joao'] }));
    await store.insertEntry(base({ title: 'b', supersedesId: a.id, positions: [{ person: 'joao', position: 'x' }] }));
    const w = await store.insertEntry(base({ type: 'workstream', status: 'in_progress' }));
    await store.insertEntry(base({ type: 'update', workstreamId: w.id }));
    await store.touchLastSeen('joao', new Date());
    const p = await store.insertPending({ personId: 'miguel', candidate: cand({ authors: ['joao'] }), question: 'Q?', sourceRef: 'web@main' });
    await store.answerPending(p.id, 'record', new Date());
    await store.insertPending({ personId: 'joao', candidate: cand(), question: 'Q2?', sourceRef: null });
    await store.insertCorrection({ personId: 'miguel', verdict: 'personal', candidate: cand() });
    const snap = await store.exportAll();
    const fresh = new PostgresStore(await createTestDb());
    await fresh.importAll(snap);
    expect(await fresh.exportAll()).toEqual(snap);
    expect(snap.entries.find((e) => e.type === 'update')?.workstreamId).toBe(w.id);
    await expect(store.importAll(snap)).rejects.toThrow();
    expect(snap.pending).toHaveLength(2);
    expect(snap.corrections).toHaveLength(1);
  });

  it('importAll accepts a snapshot without pending/corrections', async () => {
    await store.insertEntry(base());
    const { pending: _p, corrections: _c, ...old } = await store.exportAll();
    const fresh = new PostgresStore(await createTestDb());
    await fresh.importAll(old);
    expect((await fresh.exportAll()).entries).toEqual(old.entries);
  });

  it('pending: insert, list open oldest first, answer', async () => {
    const a = await store.insertPending({ personId: 'miguel', candidate: cand({ title: 'a' }), question: 'Qa?', sourceRef: 'r' });
    await sleep();
    const b = await store.insertPending({ personId: 'miguel', candidate: cand({ title: 'b' }), question: 'Qb?', sourceRef: null });
    await store.insertPending({ personId: 'joao', candidate: cand(), question: 'Qj?', sourceRef: null });
    expect(a).toMatchObject({ status: 'open', answer: null, answeredAt: null, sourceRef: 'r', question: 'Qa?' });
    expect((await store.listPending('miguel')).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(await store.listPending('miguel', 1)).toHaveLength(1);
    expect(await store.listPending('joao')).toHaveLength(1);
    const now = new Date();
    const done = await store.answerPending(a.id, 'record', now);
    expect(done).toMatchObject({ status: 'answered', answer: 'record', answeredAt: now });
    expect(await store.getPending(a.id)).toEqual(done);
    expect((await store.listPending('miguel')).map((p) => p.id)).toEqual([b.id]);
    expect(await store.getPending('00000000-0000-0000-0000-000000000000', { forUpdate: true })).toBeNull();
  });

  it('corrections: newest first, per person, limited', async () => {
    const c1 = await store.insertCorrection({ personId: 'miguel', verdict: 'company', candidate: cand({ title: '1' }) });
    await sleep();
    const c2 = await store.insertCorrection({ personId: 'miguel', verdict: 'not_worth_recording', candidate: cand({ title: '2' }) });
    await store.insertCorrection({ personId: 'joao', verdict: 'personal', candidate: cand() });
    expect((await store.listCorrections('miguel', 10)).map((c) => c.id)).toEqual([c2.id, c1.id]);
    expect(await store.listCorrections('miguel', 1)).toHaveLength(1);
    expect(c1.candidate.title).toBe('1');
  });

  it('getEntry with forUpdate runs inside a transaction and returns the entry', async () => {
    const e = await store.insertEntry(base({ authors: ['miguel'] }));
    const got = await store.transaction((tx) => tx.getEntry(e.id, { forUpdate: true }));
    expect(got).toEqual(e);
    expect(await store.getEntry('00000000-0000-0000-0000-000000000000', { forUpdate: true })).toBeNull();
  });

  it('insertEntry with an unknown author throws and leaves no entry', async () => {
    await expect(store.insertEntry(base({ authors: ['ghost'] }))).rejects.toThrow();
    expect(await store.listEntries({})).toEqual([]);
  });

  it('updateEntry with an unknown author throws and leaves the entry unchanged', async () => {
    const e = await store.insertEntry(base({ authors: ['miguel', 'joao'] }));
    await expect(store.updateEntry(e.id, { title: 'changed', authors: ['ghost'] }, 'joao')).rejects.toThrow();
    expect(await store.getEntry(e.id)).toEqual(e);
  });
});
