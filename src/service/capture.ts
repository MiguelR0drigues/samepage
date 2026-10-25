import type { Candidate, CandidateType, CorrectionVerdict, Entry, EntryStatus, EntryType, Pending, PendingAnswer, Person } from '../domain/types';
import type { Store } from '../storage/store';
import { assertHuman, CANDIDATE_TYPES, Memory, MemoryError, type RecordInput } from './memory';
import { changeLine, flat, MAX_CHANGES } from './summary';

export const MAX_ITEMS = 5;
export const MAX_PENDING = 2;

export interface ExtractedItem extends Candidate {
  certainty: 'high' | 'medium' | 'low'; relation: 'new' | 'updates' | 'supersedes'; related_id?: string; ask?: string;
}
export interface SessionUpdate { title: string; content: string; area: string; workstream_id?: string; workstream_title?: string }
export interface Extraction { session_ref: string; branch_hint?: string; items: ExtractedItem[]; update?: SessionUpdate | null }
export interface CaptureResult { recorded: string[]; proposals: string[]; pending: { id: string; question: string }[]; ignored: number; update: string | null; workstream: string | null }
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
          const related = await find(tx, related_id);
          // A decision here is inferred from talk, never stated: its author confirms the wording first, whatever the certainty.
          if (certainty === 'medium' || item.type === 'decision') {
            const replaces = relation === 'supersedes' && item.type === 'decision' && related?.type === 'decision' && related.status === 'active' ? related.id : undefined;
            const q = ask?.trim() || (item.type === 'decision'
              ? `Did the team decide this: "${flat(item.content, 200)}"?`
              : `Should "${item.title}" be recorded as a ${item.type} for the team?`);
            // read later and outside the conversation: it must name its subject and origin
            const question = flat(`${q} — ${item.type}: "${item.title}" (from ${x.branch_hint ?? 'a Claude Code session'}, ${new Date().toISOString().slice(0, 10)})`, 400);
            const pending = await tx.insertPending({ personId: actor.id, candidate: replaces ? { ...candidate, replaces } : candidate, question, sourceRef: x.session_ref });
            r.pending.push({ id: pending.id, question });
            continue;
          }
          const input: RecordInput = { ...candidate, sourceKind: 'claude_code', sourceRef: x.session_ref };
          if (relation === 'updates' && related?.type === item.type && related.authors.includes(actor.id)) {
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

  // Mid-session: what teammates changed that an agent may be acting on. Workstream progress and views can wait for the next session.
  async changes(actor: Person, since: Date): Promise<string[]> {
    assertHuman(actor);
    return (await this.store.changesSince(since, actor.id))
      .filter((c) => ['decision', 'principle', 'proposal'].includes(c.entry.type))
      .slice(0, MAX_CHANGES).map(changeLine);
  }

  // /off-record: undoes what this person's session added and blanks its text. Text corrections it made to older entries
  // ('updates') stay. shortcut: questions already answered 'record' keep their text in pending/corrections (no session link there); add one if that matters.
  async forgetSession(actor: Person, sessionRef: string): Promise<{ removed: number; kept: number; pending: number }> {
    assertHuman(actor);
    return this.store.transaction(async (tx) => {
      const memory = new Memory(tx);
      const r = { removed: 0, kept: 0, pending: 0 };
      // newest first, so a replacement goes before the entry it replaced
      for (const e of await tx.listEntries({ sourceRef: sessionRef, limit: 100 })) {
        if (e.recordedBy !== actor.id) continue;
        try {
          await memory.remove(actor, e.id);
        } catch (err) {
          if (!(err instanceof MemoryError)) throw err;
          r.kept++; // e.g. a decision someone else has an open proposal on
          continue;
        }
        r.removed++;
        // off the record means the text goes too, not just out of sight (exports keep deleted rows)
        await tx.updateEntry(e.id, { title: '', content: '', question: null, positions: null, consensusReason: null }, actor.id);
        const old = await find(tx, e.supersedesId);
        if (old?.status === 'superseded') await tx.updateEntry(old.id, { status: 'active' }, actor.id);
      }
      for (const p of await tx.listPending(actor.id, 100)) {
        if (p.sourceRef !== sessionRef) continue;
        await tx.discardPending(p.id, new Date());
        r.pending++;
      }
      return r;
    });
  }

  async answerPending(actor: Person, id: string, answer: PendingAnswer, type?: CandidateType): Promise<{ pending: Pending; entry: Entry | null }> {
    assertHuman(actor);
    return this.store.transaction(async (tx) => {
      const p = UUID.test(id) ? await tx.getPending(id, { forUpdate: true }) : null;
      if (!p || p.personId !== actor.id) throw new MemoryError(`Pending question not found: ${id}`);
      if (p.status !== 'open') throw new MemoryError('This question was already answered.');
      const candidate = answer === 'record' && type ? { ...p.candidate, type } : p.candidate;
      let entry: Entry | null = null;
      if (answer === 'record') {
        const { replaces, ...fields } = candidate;
        const input: RecordInput = { ...fields, sourceKind: 'claude_code', sourceRef: p.sourceRef ?? undefined };
        // the decision it replaces may have changed while the question waited: then it is recorded on its own
        const old = fields.type === 'decision' ? await find(tx, replaces) : null;
        entry = old?.type === 'decision' && old.status === 'active'
          ? (await new Memory(tx).supersede(actor, old.id, input)).entry
          : await new Memory(tx).record(actor, input);
      }
      const { title, area } = candidate;
      await tx.insertCorrection({ personId: actor.id, verdict: VERDICT[answer],
        candidate: answer === 'personal' ? { type: candidate.type, title, area, content: '' } : candidate });
      return { pending: await tx.answerPending(id, answer, new Date()), entry };
    });
  }
}
