import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Entry, Person } from '../domain/types';
import { Capture } from '../service/capture';
import { Memory, MemoryError, type RecordInput } from '../service/memory';
import { flat } from '../service/summary';
import type { Store } from '../storage/store';
import { formatEntry } from './format';

const INSTRUCTIONS = `Shared team memory: decisions, personal views, principles and explorations about the company.
- These samepage tools are the team memory. When the user explicitly asks, in any language, to record or save something about the company, product or team for everyone ("regista", "guarda", "anota"), use record — not local files. When they ask what the team decided or thinks, use search_context.
- Record only when explicitly asked; never on your own initiative. Personal preferences about how this user works (style, tools, habits) belong in your own memory, not here.
- If it is unclear whether something is for the team or personal, or which type it is (decision needs a team verdict; principle = stable truth; view = one person's opinion; exploration = no conclusion), ask before recording.
- After recording, say in one line what was saved and as which type, so the user can correct or delete it.
- Before relevant work (architecture, product, marketing, positioning, roadmap), use search_context.
- If your suggestion contradicts a recorded decision: still give the suggestion, but warn and present the facts — your suggestion and why, the recorded decision it contradicts, and its context (when, who, positions, arguments, consensus). Then always ask what to do. If the person decides to go against the decision, use propose_revision.
- When told to record something ("record this", "we decided X with Y"), use record; use list_team to get the author ids.
- Never record personal matters or anything not about the company.
- Exploration = an idea discussed without a conclusion; do not record it as a decision.
- SamePage also captures automatically from these conversations (source: claude_code). If the user says such an entry was personal or not worth recording, delete it with delete_entry and that reason. The user can type /private to skip the whole conversation, or /forget to drop what was said since the last capture.
- If the summary lists "Pending for you", ask those questions briefly at a natural moment (not in the middle of a task) and pass each answer to answer_pending.`;

const limit = z.number().int().min(1).max(20).default(5).describe('Max results (1-20)');
const id = z.string().describe('Entry id');

const recordFields = {
  type: z.enum(['decision', 'view', 'principle', 'exploration', 'update', 'workstream']),
  title: z.string(),
  content: z.string(),
  area: z.string(),
  authors: z.array(z.string()).optional().describe('Author person ids (default: you); see list_team'),
  question: z.string().optional(),
  positions: z.array(z.object({ person: z.string(), position: z.string(), arguments: z.string().optional() })).optional(),
  consensus: z.enum(['unanimous', 'majority', 'no_consensus']).optional(),
  consensus_reason: z.string().optional(),
  source: z.enum(['meet', 'claude_code', 'explicit']).optional(),
  source_ref: z.string().optional(),
  workstream_id: z.string().optional().describe('Required for type update: the workstream it belongs to; see list_workstreams'),
};
type RecordArgs = z.infer<z.ZodObject<typeof recordFields>>;

const toRecordInput = (a: RecordArgs): RecordInput => ({
  type: a.type, title: a.title, content: a.content, area: a.area, authors: a.authors, question: a.question,
  positions: a.positions, consensus: a.consensus, consensusReason: a.consensus_reason,
  sourceKind: a.source, sourceRef: a.source_ref, workstreamId: a.workstream_id,
});

// Rule violations go back to the agent as tool errors; anything else is a real failure and propagates.
async function run(fn: () => Promise<string>) {
  try {
    return { content: [{ type: 'text' as const, text: await fn() }] };
  } catch (e) {
    if (e instanceof MemoryError) return { isError: true, content: [{ type: 'text' as const, text: e.message }] };
    throw e;
  }
}

const list = (entries: Entry[]) => (entries.length ? entries.map(formatEntry).join('\n\n') : 'No results.');

export function buildMcpServer(store: Store, actor: Person, summary: string | undefined, openDashboard: () => Promise<string>): McpServer {
  const memory = new Memory(store);
  const instructions = summary ? `${INSTRUCTIONS}\n\n${summary}` : INSTRUCTIONS;
  const server = new McpServer({ name: 'samepage', version: '0.1.0' }, { instructions });

  server.registerTool('search_context', {
    description: 'Search the shared team memory (SamePage): what the team decided, thinks or follows (decisions, views, principles, explorations).',
    inputSchema: z.object({ query: z.string(), area: z.string().optional(), limit }),
  }, (a) => run(async () => list(await store.search(a.query, { area: a.area, limit: a.limit }))));

  server.registerTool('list_decisions', {
    description: 'List recorded decisions, newest first.',
    inputSchema: z.object({
      area: z.string().optional(),
      status: z.enum(['active', 'superseded', 'under_review']).default('active'),
      limit,
    }),
  }, (a) => run(async () => list(await store.listEntries({ type: 'decision', status: a.status, area: a.area, limit: a.limit }))));

  server.registerTool('list_team', { description: 'List the team members (ids to use as authors).' },
    () => run(async () => (await store.listPeople()).filter((p) => !p.isSystem).map((p) => `${p.id}: ${p.name}`).join('\n')));

  server.registerTool('record', {
    description: 'Save to the shared team memory (SamePage) — use when asked to record/save/remember something about the company: a decision, view, principle, exploration, workstream (a tracked piece of work) or update (a progress note on a workstream).',
    inputSchema: z.object(recordFields),
  }, (a) => run(async () => `Recorded ${(await memory.record(actor, toRecordInput(a))).id}`));

  server.registerTool('list_workstreams', {
    description: 'List workstreams (tracked pieces of work), newest first.',
    inputSchema: z.object({ status: z.enum(['in_progress', 'blocked', 'done']).optional(), limit }),
  }, (a) => run(async () => list(await store.listEntries({ type: 'workstream', status: a.status, limit: a.limit }))));

  server.registerTool('set_workstream_status', {
    description: 'Set a workstream to in_progress, blocked or done. Any team member can.',
    inputSchema: z.object({ id, status: z.enum(['in_progress', 'blocked', 'done']) }),
  }, (a) => run(async () => {
    await memory.setWorkstreamStatus(actor, a.id, a.status);
    return `Workstream ${a.id} is ${a.status}`;
  }));

  server.registerTool('rename_workstream', {
    description: 'Rename a workstream. Any team member can.',
    inputSchema: z.object({ id, title: z.string() }),
  }, (a) => run(async () => {
    await memory.renameWorkstream(actor, a.id, a.title);
    return `Renamed workstream ${a.id}`;
  }));

  server.registerTool('merge_workstreams', {
    description: 'Merge one workstream into another: moves all its updates and marks it done. Any team member can.',
    inputSchema: z.object({ from_id: id, into_id: id }),
  }, (a) => run(async () => {
    await memory.mergeWorkstream(actor, a.from_id, a.into_id);
    return `Merged ${a.from_id} into ${a.into_id}`;
  }));

  server.registerTool('correct_text', {
    description: 'Fix the text of an entry you authored. A decision verdict (content) cannot be edited.',
    inputSchema: z.object({
      id, title: z.string().optional(), question: z.string().optional(), positions: recordFields.positions,
      consensus_reason: z.string().optional(), content: z.string().optional(),
    }),
  }, ({ id, consensus_reason, ...patch }) => run(async () => {
    await memory.correctText(actor, id, { ...patch, consensusReason: consensus_reason });
    return `Corrected ${id}`;
  }));

  server.registerTool('delete_entry', {
    description: 'Delete an entry you authored.',
    inputSchema: z.object({
      id,
      reason: z.enum(['personal', 'not_worth_recording']).optional()
        .describe('Only for entries SamePage captured automatically (source: claude_code): why it was wrong; this teaches the capture'),
    }),
  }, (a) => run(async () => {
    await memory.remove(actor, a.id, a.reason);
    return `Deleted ${a.id}`;
  }));

  server.registerTool('pending', {
    description: "List SamePage's open questions for you: things it captured automatically but was unsure about.",
  }, () => run(async () => {
    const open = await store.listPending(actor.id);
    return open.length
      ? open.map((p) => `[${p.id}] ${flat(p.question, 300)}\n  ${p.candidate.type}: ${p.candidate.title} — ${flat(p.candidate.content, 200)}`).join('\n')
      : 'No pending questions.';
  }));

  server.registerTool('answer_pending', {
    description: "Answer one of SamePage's pending questions.",
    inputSchema: z.object({
      id,
      answer: z.enum(['record', 'personal', 'skip']).describe('record = about the company, save it; personal = personal, never save; skip = about the company but not worth saving'),
      type: z.enum(['decision', 'principle', 'view', 'exploration']).optional().describe('Only with answer record: record it as this type instead, e.g. decision when the user says the team agreed'),
    }),
  }, (a) => run(async () => {
    const { entry } = await new Capture(store).answerPending(actor, a.id, a.answer, a.type);
    return entry ? `Recorded ${entry.id}` : 'Noted: not recorded.';
  }));

  server.registerTool('supersede_decision', {
    description: 'Replace an active decision with a new one. With a single author who is not the original sole author, this creates a proposal instead.',
    inputSchema: z.object({ old_id: z.string().describe('Id of the decision being replaced'), ...recordFields }),
  }, ({ old_id, ...rest }) => run(async () => {
    const { entry, outcome } = await memory.supersede(actor, old_id, toRecordInput(rest));
    return outcome === 'superseded'
      ? `Superseded ${old_id} with ${entry.id}`
      : `Created proposal ${entry.id} for ${old_id}; another author must accept it`;
  }));

  server.registerTool('propose_revision', {
    description: 'Propose revising a decision. Another author must accept it.',
    inputSchema: z.object({ decision_id: z.string(), title: z.string(), suggestion: z.string(), justification: z.string() }),
  }, (a) => run(async () => {
    const p = await memory.proposeRevision(actor, a.decision_id, { title: a.title, content: a.suggestion, justification: a.justification });
    return `Created proposal ${p.id}`;
  }));

  server.registerTool('accept_proposal', {
    description: 'Accept an open proposal (not your own): it becomes the active decision.',
    inputSchema: z.object({ id }),
  }, (a) => run(async () => `Accepted: ${(await memory.acceptProposal(actor, a.id)).id} is now an active decision`));

  server.registerTool('reject_proposal', {
    description: 'Reject an open proposal (not your own); the decision stays active.',
    inputSchema: z.object({ id, reason: z.string().optional() }),
  }, (a) => run(async () => `Rejected ${(await memory.rejectProposal(actor, a.id, a.reason)).id}`));

  server.registerTool('open_dashboard', {
    description: 'Open the SamePage web dashboard: returns a one-time sign-in link for the user (valid 10 minutes). Show the link to the user.',
  }, () => run(async () => `Open this link to sign in to the SamePage dashboard (works once, valid 10 minutes): ${await openDashboard()}`));

  return server;
}
