import type { Entry, Person } from '../domain/types';
import type { Store } from '../storage/store';

const MAX_CHARS = 2000;
const flat = (s: string, max = Infinity) => s.replace(/\s+/g, ' ').trim().slice(0, max).trim();
const short = (e: Entry) => e.id.slice(0, 8);

export async function sessionSummary(store: Store, person: Person, now: Date): Promise<string> {
  const principles = await store.listEntries({ type: 'principle', status: 'active' });
  // A decision with an open revision proposal is still in force.
  const decisions = (await Promise.all((['active', 'under_review'] as const).map((status) =>
    store.listEntries({ type: 'decision', status, limit: 5 }))))
    .flat().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 5);
  const changes = person.lastSeenAt ? (await store.changesSince(person.lastSeenAt, person.id)).slice(0, 8) : [];
  const proposals = await store.listEntries({ type: 'proposal', status: 'open', limit: 5 });

  const proposalLines = await Promise.all(proposals.map(async (p) => {
    const target = p.targetId ? await store.getEntry(p.targetId) : null;
    return `- [${short(p)}] ${flat(p.title)} → revises "${flat(target?.title ?? 'unknown decision')}"`;
  }));

  const sections: [string, string[]][] = [
    ['Principles', principles.map((e) => `- ${flat(e.title)}: ${flat(e.content, 200)}`)],
    ['Recent decisions', decisions.map((e) => `- [${short(e)}] ${flat(e.title)} (${e.area}, ${e.createdAt.toISOString().slice(0, 10)})`)],
    ['New since your last session', changes.map((c) => {
      const by = c.kind === 'removed' ? c.entry.deletedBy : c.kind === 'new' ? c.entry.recordedBy : c.entry.updatedBy;
      return `- ${c.kind}: ${flat(c.entry.title)} (by ${by})`;
    })],
    ['Open proposals', proposalLines],
  ];

  const render = () => [
    '# Team memory (SamePage)',
    ...sections.flatMap(([title, items]) => (items.length ? [`## ${title}`, ...items] : [])),
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
