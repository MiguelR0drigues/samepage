import type { Candidate, CandidateType, CorrectionVerdict, Entry, EntryStatus, EntryType, Pending, PendingAnswer, Person } from '../domain/types';
import type { Store } from '../storage/store';
import { assertHuman, CANDIDATE_TYPES, Memory, MemoryError, type RecordInput } from './memory';
import { flat } from './summary';

export const MAX_ITEMS = 5;
export const MAX_PENDING = 2;

export interface ExtractedItem extends Candidate {
  certainty: 'high' | 'medium' | 'low'; relation: 'new' | 'updates' | 'supersedes'; related_id?: string; ask?: string;
}
export interface SessionUpdate { title: string; content: string; area: string; workstream_id?: string; workstream_title?: string }
export interface Extraction { session_ref: string; branch_hint?: string; items: ExtractedItem[]; update?: SessionUpdate | null }
export interface CaptureResult { recorded: string[]; proposals: string[]; pending: string[]; ignored: number; update: string | null; workstream: string | null }
export interface ExtractorContext {
  person: string; people: { id: string; name: string }[];
  entries: { id: string; type: EntryType; status: EntryStatus; area: string; title: string; content: string; authors: string[] }[];
  workstreams: { id: string; status: EntryStatus; title: string; branch: string | null }[];
  corrections: { verdict: CorrectionVerdict; type: CandidateType; title: string }[];
}

const VERDICT: Record<PendingAnswer, CorrectionVerdict> = { record: 'company', personal: 'personal', skip: 'not_worth_recording' };
// Ids come from model output: a malformed one would be a Postgres error, not "not found".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function find(store: Store, id?: string | null): Promise<Entry | null> {
  const e = id && UUID.test(id) ? await store.getEntry(id) : null;
  return e && !e.deletedAt ? e : null;
}

export class Capture {
  constructor(private store: Store) {}

  async context(actor: Person): Promise<ExtractorContext> {
    assertHuman(actor);
    // Per type, so newer updates and workstreams cannot crowd the rest out. Sequential: the Worker has few connections.
    const candidates: Entry[] = [];
    for (const type of CANDIDATE_TYPES) candidates.push(...await this.store.listEntries({ type, limit: 40 }));
    const entries = candidates.filter((e) => e.status === 'active' || e.status === 'under_review')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 40);
    const workstreams = (await this.store.listEntries({ type: 'workstream', limit: 100 }))
      .filter((w) => w.status !== 'done').slice(0, 20);
    return {
      person: actor.id,
      people: (await this.store.listPeople()).filter((p) => !p.isSystem).map(({ id, name }) => ({ id, name })),
      entries: entries.map(({ id, type, status, area, title, content, authors }) => ({ id, type, status, area, title, content: flat(content, 200), authors })),
      workstreams: workstreams.map(({ id, status, title, sourceRef }) => ({ id, status, title, branch: sourceRef?.replace(/^branch:/, '') ?? null })),
      corrections: (await this.store.listCorrections(actor.id, 10)).map(({ verdict, candidate }) => ({ verdict, type: candidate.type, title: candidate.title })),
    };
  }

  // One transaction: a retry after an error never duplicates what was already applied.
  async apply(actor: Person, x: Extraction): Promise<CaptureResult> {
    assertHuman(actor);
    return this.store.transaction(async (tx) => {
      const memory = new Memory(tx);
      const humans = (await tx.listPeople()).filter((p) => !p.isSystem).map((p) => p.id);
      const r: CaptureResult = { recorded: [], proposals: [], pending: [], ignored: Math.max(0, x.items.length - MAX_ITEMS), update: null, workstream: null };
      for (const { certainty, relation, related_id, ask, ...item } of x.items.slice(0, MAX_ITEMS)) {
        if (certainty === 'low' || (certainty === 'medium' && r.pending.length >= MAX_PENDING)) { r.ignored++; continue; }
        const candidate: Candidate = { ...item, authors: [...new Set([actor.id, ...(item.authors ?? []).filter((a) => humans.includes(a))])] };
        try {
          if (certainty === 'medium') {
            const question = ask ?? `Should "${item.title}" be recorded as a ${item.type} for the team?`;
            r.pending.push((await tx.insertPending({ personId: actor.id, candidate, question, sourceRef: x.session_ref })).id);
            continue;
          }
          const input: RecordInput = { ...candidate, sourceKind: 'claude_code', sourceRef: x.session_ref };
          const related = await find(tx, related_id);
          if (relation === 'supersedes' && item.type === 'decision' && related?.type === 'decision' && related.status === 'active') {
            const { entry, outcome } = await memory.supersede(actor, related.id, input);
            (outcome === 'proposal' ? r.proposals : r.recorded).push(entry.id);
          } else if (relation === 'updates' && related?.type === item.type && related.type !== 'decision' && related.authors.includes(actor.id)) {
            r.recorded.push((await memory.correctText(actor, related.id, { title: item.title, content: item.content })).id);
          } else {
            r.recorded.push((await memory.record(actor, input)).id);
          }
        } catch (e) {
          if (!(e instanceof MemoryError)) throw e;
          r.ignored++;
        }
      }
      if (x.update) {
        const u = x.update;
        const branch = x.branch_hint ? `branch:${x.branch_hint}` : null;
        const byId = await find(tx, u.workstream_id);
        // shortcut: matches only the newest 100 workstreams, add a sourceRef filter to listEntries if teams outgrow that.
        const w = (byId?.type === 'workstream' ? byId : null)
          ?? (branch ? (await tx.listEntries({ type: 'workstream', limit: 100 })).find((e) => e.sourceRef === branch && e.status !== 'done') : null)
          ?? await memory.record(actor, { type: 'workstream', title: u.workstream_title ?? x.branch_hint ?? u.title, content: u.title,
            area: u.area, sourceRef: branch ?? undefined, sourceKind: 'claude_code' });
        const entry = await memory.record(actor, { type: 'update', title: u.title, content: u.content, area: u.area,
          workstreamId: w.id, sourceRef: x.session_ref, sourceKind: 'claude_code' });
        r.update = entry.id;
        r.workstream = w.id;
      }
      return r;
    });
  }

  async answerPending(actor: Person, id: string, answer: PendingAnswer): Promise<{ pending: Pending; entry: Entry | null }> {
    assertHuman(actor);
    return this.store.transaction(async (tx) => {
      const p = UUID.test(id) ? await tx.getPending(id, { forUpdate: true }) : null;
      if (!p || p.personId !== actor.id) throw new MemoryError(`Pending question not found: ${id}`);
      if (p.status !== 'open') throw new MemoryError('This question was already answered.');
      const entry = answer === 'record'
        ? await new Memory(tx).record(actor, { ...p.candidate, sourceKind: 'claude_code', sourceRef: p.sourceRef ?? undefined })
        : null;
      const { type, title, area } = p.candidate;
      await tx.insertCorrection({ personId: actor.id, verdict: VERDICT[answer],
        candidate: answer === 'personal' ? { type, title, area, content: '' } : p.candidate });
      return { pending: await tx.answerPending(id, answer, new Date()), entry };
    });
  }
}
