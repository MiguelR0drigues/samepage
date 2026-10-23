import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Entry, Person } from '../domain/types';
import { Memory, MemoryError, type RecordInput } from '../service/memory';
import type { Store } from '../storage/store';
import { formatEntry } from './format';

const INSTRUCTIONS = `Shared team memory: decisions, personal views, principles and explorations about the company.
- Before relevant work (architecture, product, marketing, positioning, roadmap), use search_context.
- If your suggestion contradicts a recorded decision: still give the suggestion, but warn and present the facts — your suggestion and why, the recorded decision it contradicts, and its context (when, who, positions, arguments, consensus). Then always ask what to do. If the person decides to go against the decision, use propose_revision.
- When told to record something ("record this", "we decided X with Y"), use record; use list_team to get the author ids.
- Never record personal matters or anything not about the company.
- Exploration = an idea discussed without a conclusion; do not record it as a decision.`;

const limit = z.number().int().min(1).max(20).default(5).describe('Max results (1-20)');
const id = z.string().describe('Entry id');

const recordFields = {
  type: z.enum(['decision', 'view', 'principle', 'exploration']),
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
};
type RecordArgs = z.infer<z.ZodObject<typeof recordFields>>;

const toRecordInput = (a: RecordArgs): RecordInput => ({
  type: a.type, title: a.title, content: a.content, area: a.area, authors: a.authors, question: a.question,
  positions: a.positions, consensus: a.consensus, consensusReason: a.consensus_reason,
  sourceKind: a.source, sourceRef: a.source_ref,
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

export function buildMcpServer(store: Store, actor: Person): McpServer {
  const memory = new Memory(store);
  const server = new McpServer({ name: 'samepage', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('search_context', {
    description: 'Search the team memory (decisions, views, principles, explorations).',
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
    description: 'Record a decision, view, principle or exploration.',
    inputSchema: z.object(recordFields),
  }, (a) => run(async () => `Recorded ${(await memory.record(actor, toRecordInput(a))).id}`));

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
    inputSchema: z.object({ id }),
  }, (a) => run(async () => {
    await memory.remove(actor, a.id);
    return `Deleted ${a.id}`;
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

  return server;
}
