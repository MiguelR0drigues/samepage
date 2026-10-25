import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { Memory, MemoryError, type RecordInput } from '../../src/service/memory';
import { Capture, type ExtractedItem, type Extraction } from '../../src/service/capture';
import type { Person } from '../../src/domain/types';
import type { Store } from '../../src/storage/store';

let store: PostgresStore;
let memory: Memory;
let capture: Capture;
let miguel: Person;
let joao: Person;
let meet: Person;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  memory = new Memory(store);
  capture = new Capture(store);
  miguel = await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, 'h-miguel');
  joao = await store.addPerson({ id: 'joao', name: 'Joao', isSystem: false }, 'h-joao');
  meet = await store.addPerson({ id: 'meet', name: 'Meet', isSystem: true }, 'h-meet');
});

const item = (over: Partial<ExtractedItem> = {}): ExtractedItem => ({
  type: 'decision', title: 'Use Neon', content: 'We use Neon.', area: 'infra', certainty: 'high', relation: 'new', ...over,
});
const x = (over: Partial<Extraction> = {}): Extraction => ({ session_ref: 'claude_code:s1', items: [], ...over });
const decision = (over: Partial<RecordInput> = {}): RecordInput => ({
  type: 'decision', title: 'Use Neon', content: 'We use Neon.', area: 'infra', ...over,
});
const update = { title: 'Shipped login', content: 'Login works.', area: 'web' };

describe('Capture.apply', () => {
  it('high new item is recorded with source claude_code and the session ref', async () => {
    const r = await capture.apply(miguel, x({ items: [item()] }));
    expect(r).toMatchObject({ proposals: [], pending: [], ignored: 0, update: null, workstream: null });
    expect(await store.getEntry(r.recorded[0]!)).toMatchObject({
      type: 'decision', sourceKind: 'claude_code', sourceRef: 'claude_code:s1', authors: ['miguel'], recordedBy: 'miguel',
    });
  });

  it('low items are ignored and medium items become pending for the actor (max 2)', async () => {
    const r = await capture.apply(miguel, x({ items: [
      item({ certainty: 'low' }),
      item({ certainty: 'medium', title: 'A', ask: 'Is A for the team?' }),
      item({ certainty: 'medium', title: 'B', type: 'view' }),
      item({ certainty: 'medium', title: 'C' }),
    ] }));
    expect(r.recorded).toEqual([]);
    expect(r.ignored).toBe(2);
    expect(r.pending).toHaveLength(2);
    const pending = await Promise.all(r.pending.map(({ id }) => store.getPending(id)));
    expect(pending.map((p) => p?.personId)).toEqual(['miguel', 'miguel']);
    expect(r.pending.map((p) => p.question)).toEqual(pending.map((p) => p?.question));
    expect(pending[1]).toMatchObject({ sourceRef: 'claude_code:s1', candidate: { type: 'view', title: 'B', authors: ['miguel'] } });
    expect(await store.listEntries({})).toEqual([]);
  });

  it('a pending question names the subject, its origin and the date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await capture.apply(miguel, x({ branch_hint: 'web@main', items: [
      item({ certainty: 'medium', title: 'A', ask: 'Is A\n  for the team?' }),
      item({ certainty: 'medium', title: 'B', type: 'view' }),
    ] }));
    expect(r.pending.map((p) => p.question)).toEqual([
      `Is A for the team? — decision: "A" (from web@main, ${today})`,
      `Should "B" be recorded as a view for the team? — view: "B" (from web@main, ${today})`,
    ]);
    const [n] = (await capture.apply(miguel, x({ items: [item({ certainty: 'medium', title: 'C', ask: 'q'.repeat(500) })] }))).pending;
    expect(n!.question).toHaveLength(400);
    const [m] = (await capture.apply(miguel, x({ items: [item({ certainty: 'medium', title: 'D', ask: 'Q?' })] }))).pending;
    expect(m!.question).toBe(`Q? — decision: "D" (from a Claude Code session, ${today})`);
  });

  it('more than 5 items: the rest are ignored', async () => {
    const r = await capture.apply(miguel, x({ items: Array.from({ length: 7 }, (_, i) => item({ title: `D${i}` })) }));
    expect(r.recorded).toHaveLength(5);
    expect(r.ignored).toBe(2);
  });

  it('supersedes on a team decision creates a proposal', async () => {
    const old = await memory.record(miguel, decision({ authors: ['miguel', 'joao'] }));
    const r = await capture.apply(miguel, x({ items: [item({ title: 'Use Supabase', relation: 'supersedes', related_id: old.id })] }));
    expect(r.recorded).toEqual([]);
    expect(r.proposals).toHaveLength(1);
    expect(await store.getEntry(r.proposals[0]!)).toMatchObject({ type: 'proposal', targetId: old.id, sourceKind: 'claude_code' });
    expect((await store.getEntry(old.id))?.status).toBe('under_review');
  });

  it("updates merges into the actor's own view", async () => {
    const v = await memory.record(miguel, decision({ type: 'view', title: 'Tabs', content: 'Tabs are fine.' }));
    const r = await capture.apply(miguel, x({ items: [item({ type: 'view', title: 'Tabs', content: 'Tabs win.', relation: 'updates', related_id: v.id })] }));
    expect(r.recorded).toEqual([v.id]);
    expect((await store.getEntry(v.id))?.content).toBe('Tabs win.');
    expect(await store.listEntries({})).toHaveLength(1);
  });

  it("updates on someone else's entry or a decision records a new entry instead", async () => {
    const v = await memory.record(joao, decision({ type: 'view', content: 'Joao view.' }));
    const d = await memory.record(miguel, decision());
    const r = await capture.apply(miguel, x({ items: [
      item({ type: 'view', content: 'Mine.', relation: 'updates', related_id: v.id }),
      item({ content: 'New verdict.', relation: 'updates', related_id: d.id }),
    ] }));
    expect(r.recorded).toHaveLength(2);
    expect(r.recorded).not.toContain(v.id);
    expect(r.recorded).not.toContain(d.id);
    expect((await store.getEntry(v.id))?.content).toBe('Joao view.');
    expect((await store.getEntry(d.id))?.content).toBe('We use Neon.');
  });

  it('unknown related_id and unknown authors degrade to a new entry by the actor', async () => {
    const p = await memory.record(miguel, decision({ type: 'principle' }));
    const r = await capture.apply(miguel, x({ items: [
      item({ relation: 'supersedes', related_id: 'not-an-id', authors: ['ana'] }),
      item({ relation: 'supersedes', related_id: '00000000-0000-0000-0000-000000000000' }),
      item({ relation: 'supersedes', related_id: p.id, authors: ['meet'] }),
    ] }));
    expect(r.recorded).toHaveLength(3);
    for (const id of r.recorded) expect((await store.getEntry(id))?.authors).toEqual(['miguel']);
    expect((await store.getEntry(p.id))?.status).toBe('active');
  });

  it('update attaches to the workstream matched by branch hint, else creates one', async () => {
    const r1 = await capture.apply(miguel, x({ branch_hint: 'web-app@feature/login', update }));
    const w = await store.getEntry(r1.workstream!);
    expect(w).toMatchObject({ type: 'workstream', title: 'web-app@feature/login', content: 'Shipped login', sourceRef: 'branch:web-app@feature/login', sourceKind: 'claude_code' });
    expect(await store.getEntry(r1.update!)).toMatchObject({ type: 'update', workstreamId: w!.id, sourceRef: 'claude_code:s1', sourceKind: 'claude_code' });
    const r2 = await capture.apply(miguel, x({ session_ref: 'claude_code:s2', branch_hint: 'web-app@feature/login', update }));
    expect(r2.workstream).toBe(w!.id);
    expect(r2.update).not.toBe(r1.update);
    expect(await store.listEntries({ type: 'workstream' })).toHaveLength(1);
  });

  it('the branch hint never attaches an update to a done workstream', async () => {
    const r1 = await capture.apply(miguel, x({ branch_hint: 'web-app@main', update }));
    await memory.setWorkstreamStatus(miguel, r1.workstream!, 'done');
    const r2 = await capture.apply(miguel, x({ session_ref: 'claude_code:s2', branch_hint: 'web-app@main', update }));
    expect(r2.workstream).not.toBe(r1.workstream);
    expect(await store.getEntry(r2.workstream!)).toMatchObject({ status: 'in_progress', sourceRef: 'branch:web-app@main' });
  });

  it('update with the id of a deleted workstream creates a new workstream', async () => {
    const w = await memory.record(miguel, decision({ type: 'workstream', title: 'Old' }));
    await memory.remove(miguel, w.id);
    const r = await capture.apply(miguel, x({ update: { ...update, workstream_id: w.id, workstream_title: 'Login' } }));
    expect(r.workstream).not.toBe(w.id);
    expect(await store.getEntry(r.workstream!)).toMatchObject({ title: 'Login', sourceRef: null });
  });

  it('apply is all-or-nothing on unexpected errors', async () => {
    let calls = 0;
    const wrap = (s: Store): Store => {
      const w = Object.create(s) as Store;
      w.insertEntry = async (e) => { if (++calls === 2) throw new Error('boom'); return s.insertEntry(e); };
      w.transaction = (fn) => s.transaction((tx) => fn(wrap(tx)));
      return w;
    };
    await expect(new Capture(wrap(store)).apply(miguel, x({ items: [item({ title: 'A' }), item({ title: 'B' })] })))
      .rejects.toThrow('boom');
    expect(await store.listEntries({})).toEqual([]);
  });

  it('system actor cannot apply', async () => {
    await expect(capture.apply(meet, x({ items: [item()] }))).rejects.toThrow('A system actor cannot perform this action.');
  });
});

describe('Capture.answerPending', () => {
  const ask = async (who: Person = miguel) =>
    (await capture.apply(who, x({ items: [item({ certainty: 'medium', type: 'principle' })] }))).pending[0]!.id;

  it('answerPending record records the candidate and stores a company correction', async () => {
    const id = await ask();
    const { pending, entry } = await capture.answerPending(miguel, id, 'record');
    expect(pending).toMatchObject({ status: 'answered', answer: 'record' });
    expect(entry).toMatchObject({ type: 'principle', title: 'Use Neon', sourceKind: 'claude_code', sourceRef: 'claude_code:s1', authors: ['miguel'] });
    expect(await store.listCorrections('miguel', 10)).toMatchObject([{ verdict: 'company', candidate: { type: 'principle', title: 'Use Neon' } }]);
  });

  it('answerPending record with a type records it as that type; personal ignores it', async () => {
    const { entry } = await capture.answerPending(miguel, await ask(), 'record', 'decision');
    expect(entry).toMatchObject({ type: 'decision', title: 'Use Neon' });
    expect(await store.listCorrections('miguel', 10)).toMatchObject([{ verdict: 'company', candidate: { type: 'decision' } }]);
    await capture.answerPending(miguel, await ask(), 'personal', 'decision');
    expect((await store.listCorrections('miguel', 10))[0]).toMatchObject({ verdict: 'personal', candidate: { type: 'principle' } });
  });

  it('answerPending personal stores a correction and records nothing', async () => {
    const id = await ask();
    expect((await capture.answerPending(miguel, id, 'personal')).entry).toBeNull();
    expect(await store.listEntries({})).toEqual([]);
    const [c] = await store.listCorrections('miguel', 10);
    expect(c).toMatchObject({ verdict: 'personal' });
    expect(c!.candidate).toEqual({ type: 'principle', title: 'Use Neon', area: 'infra', content: '' });
    expect(await store.listPending('miguel')).toEqual([]);
  });

  it("answerPending rejects other people's and already answered questions", async () => {
    const id = await ask();
    await expect(capture.answerPending(joao, id, 'skip')).rejects.toThrow(`Pending question not found: ${id}`);
    await expect(capture.answerPending(miguel, 'nope', 'skip')).rejects.toThrow('Pending question not found: nope');
    await capture.answerPending(miguel, id, 'skip');
    const err = await capture.answerPending(miguel, id, 'record').catch((e) => e);
    expect(err).toBeInstanceOf(MemoryError);
    expect(err.message).toBe('This question was already answered.');
    expect(await store.listCorrections('miguel', 10)).toMatchObject([{ verdict: 'not_worth_recording' }]);
    expect(await store.listEntries({})).toEqual([]);
  });
});

describe('Capture.context', () => {
  it('context lists entries, open workstreams, own corrections and people without system', async () => {
    const v = await memory.record(miguel, decision({ type: 'view', content: `line one\n\n  line two ${'x'.repeat(300)}` }));
    await memory.record(miguel, decision({ type: 'principle', title: 'Gone' })).then((e) => memory.remove(miguel, e.id));
    const w = await capture.apply(miguel, x({ branch_hint: 'web-app@main', update }));
    const done = await memory.record(miguel, decision({ type: 'workstream', title: 'Done' }));
    await memory.setWorkstreamStatus(miguel, done.id, 'done');
    await capture.answerPending(miguel, (await capture.apply(miguel, x({ items: [item({ certainty: 'medium' })] }))).pending[0]!.id, 'personal');
    await capture.answerPending(joao, (await capture.apply(joao, x({ items: [item({ certainty: 'medium' })] }))).pending[0]!.id, 'skip');

    const c = await capture.context(miguel);
    expect(c.person).toBe('miguel');
    expect(c.people).toEqual([{ id: 'joao', name: 'Joao' }, { id: 'miguel', name: 'Miguel' }]);
    expect(c.entries).toEqual([{ id: v.id, type: 'view', status: 'active', area: 'infra', title: 'Use Neon',
      content: `line one line two ${'x'.repeat(182)}`, authors: ['miguel'] }]);
    expect(c.workstreams).toEqual([{ id: w.workstream, status: 'in_progress', title: 'web-app@main', branch: 'web-app@main' }]);
    expect(c.corrections).toEqual([{ verdict: 'personal', type: 'decision', title: 'Use Neon' }]);
  });

  it('many newer updates and workstreams do not push decisions out of the context', async () => {
    const d = await memory.record(miguel, decision());
    const w = await memory.record(miguel, decision({ type: 'workstream', title: 'Busy' }));
    for (let i = 0; i < 100; i++) await memory.record(miguel, { ...update, type: 'update', workstreamId: w.id });
    expect((await capture.context(miguel)).entries.map((e) => e.id)).toEqual([d.id]);
  });

  it('system actor cannot read the context', async () => {
    await expect(capture.context(meet)).rejects.toBeInstanceOf(MemoryError);
  });
});

describe('Capture.forgetSession', () => {
  it('removes what the session added, restores what it superseded, skips its pending questions', async () => {
    const mine = await memory.record(miguel, decision({ title: 'Use Postgres' }));
    const team = await memory.record(miguel, decision({ title: 'Use Neon', authors: ['miguel', 'joao'] }));
    const r = await capture.apply(miguel, x({ items: [
      item({ title: 'Use SQLite', relation: 'supersedes', related_id: mine.id }),
      item({ title: 'Use Supabase', relation: 'supersedes', related_id: team.id }),
      item({ type: 'view', title: 'Seats win' }),
      item({ certainty: 'medium', title: 'Maybe' }),
    ], update }));
    const other = await capture.apply(miguel, x({ session_ref: 'claude_code:s2', items: [item({ title: 'Kept' })] }));
    await store.insertPending({ personId: 'miguel', candidate: item(), question: 'Other?', sourceRef: 'claude_code:s2' });

    expect(await capture.forgetSession(miguel, 'claude_code:s1')).toEqual({ removed: 4, kept: 0, pending: 1 });
    expect((await store.getEntry(mine.id))!.status).toBe('active');
    expect((await store.getEntry(team.id))!.status).toBe('active');
    expect((await store.listEntries({ limit: 50 })).map((e) => e.title).sort()).toEqual(['Kept', 'Shipped login', 'Use Neon', 'Use Postgres']);
    expect((await store.listPending('miguel')).map((p) => p.question)).toEqual(['Other?']);
    expect(other.recorded).toHaveLength(1);
  });

  it('only touches entries the actor recorded, and keeps one it cannot remove', async () => {
    const r = await capture.apply(miguel, x({ items: [item({ title: 'Use Neon', authors: ['miguel', 'joao'] })] }));
    await capture.apply(joao, x({ items: [item({ title: 'Joao only' })] }));
    await memory.proposeRevision(joao, r.recorded[0]!, { title: 'Use Supabase', content: 'Cheaper.', justification: 'Cost.' });
    expect(await capture.forgetSession(miguel, 'claude_code:s1')).toEqual({ removed: 0, kept: 1, pending: 0 });
    expect((await store.listEntries({ type: 'decision' })).map((e) => e.title).sort()).toEqual(['Joao only', 'Use Neon']);
  });
});
