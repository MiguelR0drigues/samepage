import { html } from 'hono/html';
import type { Change, Entry, EntryStatus, Person } from '../domain/types';
import { day, entryHref, layout, nameOf, pill } from './html';

const SHOWN = 50;
const KIND_TONE = { new: 'ok', changed: 'acc', removed: 'mut' } as const;
const STATUS_TONE: Partial<Record<EntryStatus, 'ok' | 'warn' | 'mut'>> = { active: 'ok', under_review: 'warn', superseded: 'mut' };

const changeRow = (people: Person[], { kind, entry: e }: Change) => {
  const by = nameOf(people, (kind === 'new' ? e.recordedBy : kind === 'changed' ? e.updatedBy : e.deletedBy) ?? e.recordedBy);
  // A deleted entry never shows its title or content.
  const what = kind === 'removed'
    ? html`removed: ${e.type} <span class="mut">· by ${by}</span>`
    : html`<a href="${entryHref(e)}">${e.title}</a> <span class="mut">· ${e.type} · ${e.area} · by ${by}</span>`;
  return html`<div class="row">${pill(kind, KIND_TONE[kind])} ${what}</div>`;
};

export const homePage = (d: { person: Person; people: Person[]; changes: Change[]; q: string; results: Entry[] | null; timeline: Entry[] }) =>
  layout({ title: 'Home', active: 'home', person: d.person, body: html`
<form class="search" action="/dashboard" method="get">
<input name="q" value="${d.q}" placeholder="Search decisions, views, principles"><button>Search</button></form>
${d.results && html`<div class="t">Search results</div>
${d.results.length ? d.results.map((e) => html`<div class="row"><a href="${entryHref(e)}">${e.title}</a>
<span class="mut">· ${e.type} · ${e.area}</span></div>`) : html`<p class="mut">No results.</p>`}`}
<div class="t">What's new since your last visit</div>
${d.changes.length ? d.changes.slice(0, SHOWN).map((c) => changeRow(d.people, c)) : html`<p class="mut">Nothing new.</p>`}
${d.changes.length > SHOWN && html`<p class="mut">…and ${d.changes.length - SHOWN} more</p>`}
<div class="t">Timeline</div>
<div class="tl">${d.timeline.length ? d.timeline.map((e) => html`<div><span class="mut">${day(e.createdAt)}</span> · <a href="${entryHref(e)}">${e.title}</a>
${pill(e.status, STATUS_TONE[e.status] ?? 'mut')}</div>`) : html`<span class="mut">No decisions yet.</span>`}</div>` });
