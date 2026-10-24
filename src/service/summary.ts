import type { Person } from '../domain/types';
import type { Store } from '../storage/store';

const MAX_CHARS = 2000;
export const flat = (s: string, max = Infinity) => s.replace(/\s+/g, ' ').trim().slice(0, max).trim();
const MAX_CHANGES = 8;

export async function sessionSummary(store: Store, person: Person, now: Date): Promise<string> {
  const principles = await store.listEntries({ type: 'principle', status: 'active' });
  // A decision with an open revision proposal is still in force.
  const decisions = (await Promise.all((['active', 'under_review'] as const).map((status) =>
    store.listEntries({ type: 'decision', status, limit: 5 }))))
    .flat().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 5);
  const changes = person.lastSeenAt ? await store.changesSince(person.lastSeenAt, person.id) : [];
  const proposals = await store.listEntries({ type: 'proposal', status: 'open', limit: 5 });

  // Sequential: each read takes a pooled connection, and the Worker has few.
  const proposalLines: string[] = [];
  for (const p of proposals) {
    const target = p.targetId ? await store.getEntry(p.targetId) : null;
    proposalLines.push(`- [${p.id}] ${flat(p.title)} → revises "${flat(target?.title ?? 'unknown decision')}"`);
  }

  const pending = await store.listPending(person.id, 3);

  // Third element: how many items exist in total, so "…and N more" stays right as lines get dropped.
  const sections: [string, string[], number?][] = [
    ['Principles', principles.map((e) => `- ${flat(e.title)}: ${flat(e.content, 200)}`)],
    ['Recent decisions', decisions.map((e) => `- [${e.id}] ${flat(e.title)} (${e.area}, ${e.createdAt.toISOString().slice(0, 10)})`)],
    ['New since your last session', changes.slice(0, MAX_CHANGES).map((c) => {
      if (c.kind === 'removed') return `- removed: ${c.entry.type} [${c.entry.id}] (by ${c.entry.deletedBy})`; // no title: it was deleted on purpose
      return `- ${c.kind}: ${flat(c.entry.title)} (by ${c.kind === 'new' ? c.entry.recordedBy : c.entry.updatedBy})`;
    }), changes.length],
    ['Open proposals', proposalLines],
    ['Pending for you', pending.map((p) => `- [${p.id}] ${flat(p.question)}`)],
  ];

  const render = () => [
    '# Team memory (SamePage)',
    ...sections.flatMap(([title, items, total = items.length]) =>
      (items.length ? [`## ${title}`, ...items, ...(total > items.length ? [`- …and ${total - items.length} more changes`] : [])] : [])),
    'Use the samepage tools for details.',
  ].join('\n');

  await store.touchLastSeen(person.id, now);

  // Over budget: drop the last (least important) item, taking from sections in priority order. Header and footer always stay.
  let text = render();
  while (text.length > MAX_CHARS) {
    const section = sections.find(([, items]) => items.length);
    if (!section) break;
    section[1].pop();
    text = render();
  }
  return text;
}
