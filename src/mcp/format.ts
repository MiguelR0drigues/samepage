import type { Entry } from '../domain/types';

const MAX_CONTENT = 500;

export function formatEntry(e: Entry): string {
  const lines = [
    `[${e.id}] ${e.type} (${e.status}): ${e.title}`,
    `area: ${e.area} | authors: ${e.authors.join(', ')} | ${e.createdAt.toISOString().slice(0, 10)}`,
  ];
  if (e.question) lines.push(`question: ${e.question}`);
  for (const p of e.positions ?? []) lines.push(`position ${p.person}: ${p.position}${p.arguments ? ` (${p.arguments})` : ''}`);
  if (e.consensus) lines.push(`consensus: ${e.consensus}${e.consensusReason ? ` - ${e.consensusReason}` : ''}`);
  lines.push(e.content.length > MAX_CONTENT ? `${e.content.slice(0, MAX_CONTENT)}...` : e.content);
  return lines.join('\n');
}
