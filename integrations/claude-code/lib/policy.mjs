import { MAX_ITEMS } from './limits.mjs';

export const SYSTEM_PROMPT = `You extract team memory for SamePage from an excerpt of one person's conversation with their coding agent. Reply with JSON matching the schema, nothing else.

The bar is high: prefer recording too little over too much. Most excerpts contain nothing worth recording; then return no items.

Record only things about the company, its product, team or way of working that teammates would want to know later:
- decision: the person (alone or with named teammates) settled a question. It needs a clear verdict.
- principle: a stable truth the team follows (product vision, tone of voice, positioning, engineering rule).
- view: one person's opinion that is not settled.
- exploration: an idea or option discussed without a conclusion.
Never record: personal matters or anything not about the company; routine work steps (fixed a bug, renamed a file, ran tests); suggestions of the agent that the person did not adopt; anything already covered by the existing entries.

For each item:
- certainty: how sure you are that it is about the company AND worth recording. high = clearly both; medium = plausible, you would ask the person; low = doubtful.
- relation: new; updates (refines the person's own existing entry of the same type: give related_id and the full merged content); supersedes (replaces an active decision: give related_id).
- authors: omit for the person alone. Add a teammate id only if the excerpt says that teammate took part.
- ask (medium items and every decision; a decision is only recorded once the person confirms it): one short question to the person that names the subject explicitly; it is read later, outside this conversation, so never write "this" or "isto". For example: Did the team decide to price per seat?
Titles and content: short, self-contained, in the language of the conversation. Content: at most 3 sentences.
Corrections are this person's past answers about what to record: follow them.

progress: one line on what the person worked on in this excerpt, for later passes of this session.
update (only when the prompt says a session update is needed, otherwise null): what was done and the next step, 1-3 plain, friendly sentences for teammates. No hours, no counts, no judgement of productivity. Use workstream_id of an existing workstream that matches; otherwise give workstream_title, a short name for this piece of work. null if the session was not company work.
`;

const str = { type: 'string' };

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'progress', 'update'],
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'content', 'area', 'certainty', 'relation'],
        properties: {
          type: { enum: ['decision', 'principle', 'view', 'exploration'] },
          title: str, content: str, area: str,
          certainty: { enum: ['high', 'medium', 'low'] },
          relation: { enum: ['new', 'updates', 'supersedes'] },
          related_id: str,
          authors: { type: 'array', items: str },
          question: str,
          ask: str,
        },
      },
    },
    progress: str,
    update: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'content', 'area'],
          properties: { title: str, content: str, area: str, workstream_id: str, workstream_title: str },
        },
      ],
    },
  },
};

/** @typedef {{ person: string, people: { id: string, name: string }[], entries: { id: string, type: string, status: string, area: string, title: string, content: string }[], workstreams: { id: string, status: string, title: string, branch: string | null }[], corrections: { verdict: string, type: string, title: string }[] }} ExtractorContext */

/**
 * The user prompt: context sections, then the excerpt. Empty sections are left out.
 * @param {{ context: ExtractorContext, excerpt: string, branchHint: string | null, notes: string[], wantUpdate: boolean }} o
 */
export function buildPrompt({ context: c, excerpt, branchHint, notes, wantUpdate }) {
  const section = (/** @type {string} */ head, /** @type {string[]} */ lines) => (lines.length ? [head, ...lines].join('\n') : '');
  return [
    `# You extract for: ${c.person}`,
    section('# Team', c.people.map((p) => `${p.id}: ${p.name}`)),
    section('# Existing entries', c.entries.map((e) => `${e.id} | ${e.type} | ${e.status} | ${e.area} | ${e.title} — ${e.content}`)),
    section('# Workstreams', c.workstreams.map((w) => `${w.id} | ${w.status} | ${w.title} | ${w.branch ?? ''}`)),
    section('# Corrections from this person', c.corrections.map((x) => `${x.verdict}: ${x.type} — ${x.title}`)),
    branchHint ? `# Branch hint: ${branchHint}` : '',
    `# Session update: ${wantUpdate ? 'needed' : 'not needed'}`,
    section('# Progress earlier in this session', notes),
    `# Excerpt\n${excerpt}`,
  ].filter(Boolean).join('\n\n');
}
