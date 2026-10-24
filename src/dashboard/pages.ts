import { html } from 'hono/html';
import type { Change, Entry, EntryStatus, Person } from '../domain/types';
import { day, entryHref, layout, nameOf, pill } from './html';

const SHOWN = 50;
const KIND_TONE = { new: 'ok', changed: 'acc', removed: 'mut' } as const;
const STATUS_TONE: Partial<Record<EntryStatus, 'ok' | 'acc' | 'warn' | 'mut'>> = {
  active: 'ok', under_review: 'warn', open: 'warn', superseded: 'mut', in_progress: 'acc', blocked: 'warn', done: 'ok',
};

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

type History = { before: (Entry | null)[]; after: Entry[]; proposals: Entry[] };

const link = (e: Entry | null) => e && !e.deletedAt ? html`<a href="${entryHref(e)}">${e.title}</a>` : html`(deleted)`;
const statusPill = (e: Entry) => pill(e.status, STATUS_TONE[e.status] ?? 'mut');
const names = (people: Person[], ids: string[]) => ids.map((id) => nameOf(people, id)).join(', ');

const proposalCard = (me: Person, people: Person[], p: Entry, target: Entry | null) => html`
<div class="row"><h3><a href="${entryHref(p)}">${p.title}</a></h3>
<div class="mut">by ${names(people, p.authors)} · ${day(p.createdAt)}</div>
<div class="pre">${p.content}</div><div class="mut">Revises: ${link(target)}</div>
${p.status !== 'open' ? '' : p.authors.includes(me.id) || p.recordedBy === me.id
  ? html`<p class="mut">Waiting for another team member — you cannot close your own proposal.</p>`
  : html`<div><form class="inl" method="post" action="/dashboard/proposals/${p.id}/accept"><button>Accept</button></form>
<form class="inl" method="post" action="/dashboard/proposals/${p.id}/reject"><input name="reason" placeholder="Reason (optional)"><button>Reject</button></form></div>`}</div>`;

export const proposalsPage = (d: { person: Person; people: Person[]; items: { proposal: Entry; target: Entry | null }[] }) =>
  layout({ title: 'Proposals', active: 'proposals', person: d.person, body: html`
<div class="t">Open proposals</div>
${d.items.length ? d.items.map((i) => proposalCard(d.person, d.people, i.proposal, i.target)) : html`<p class="mut">No open proposals.</p>`}` });

const decisionBody = (people: Person[], e: Entry, h: History) => html`
<div class="mut">${e.area} · ${e.sourceKind} · ${day(e.createdAt)}</div>
<h2>${e.title}</h2>
<p>${statusPill(e)} ${e.consensus && pill(e.consensus, e.consensus === 'unanimous' ? 'ok' : 'warn')}</p>
${e.question && html`<div class="t">Question</div><div class="pre">${e.question}</div>`}
${e.positions?.length ? html`<div class="t">Positions</div><div class="cols">${e.positions.map((p) => html`<div class="row">
<b>${nameOf(people, p.person)}</b> · ${p.position}${p.arguments && html`<div class="mut pre">${p.arguments}</div>`}</div>`)}</div>` : ''}
<div class="t">Verdict</div><div class="pre">${e.content}</div>
${e.consensus && e.consensus !== 'unanimous' && e.consensusReason && html`<p class="mut">Why we went ahead without full consensus: ${e.consensusReason}</p>`}
<div class="t">History</div>
${h.before.map((b) => html`<div class="row">Supersedes: ${link(b)}</div>`)}
${h.after.map((a) => html`<div class="row">Superseded by: ${link(a)}</div>`)}
${h.proposals.map((p) => html`<div class="row">Revision proposal: ${link(p)} ${statusPill(p)}</div>`)}
${h.before.length + h.after.length + h.proposals.length ? '' : html`<p class="mut">No history.</p>`}`;

const otherBody = (people: Person[], e: Entry) => html`
<h2>${e.title}</h2>
<p>${pill(e.type, 'acc')} ${statusPill(e)}</p>
<div class="pre">${e.content}</div>
<p class="mut">by ${names(people, e.authors)} · ${day(e.createdAt)}</p>
${e.workstreamId && html`<p><a href="/dashboard/workstreams/${e.workstreamId}">Workstream</a></p>`}`;

export const entryPage = (d: { person: Person; people: Person[]; entry: Entry; target: Entry | null; history: History }) => {
  const e = d.entry;
  const body = e.type === 'decision' ? decisionBody(d.people, e, d.history)
    : e.type === 'proposal' ? proposalCard(d.person, d.people, e, d.target)
    : otherBody(d.people, e);
  return layout({ title: e.title, active: e.type === 'proposal' ? 'proposals' : null, person: d.person, body });
};

export const viewsPage = (d: { person: Person; people: Person[]; views: Entry[]; decisions: Entry[] }) => {
  const humans = d.people.filter((p) => !p.isSystem);
  const live = d.decisions.filter((e) => e.status === 'active' || e.status === 'under_review');
  const areas = [...new Set(d.views.map((v) => v.area))].sort();
  return layout({ title: 'Who thinks what', active: 'views', person: d.person, body: html`
${areas.length ? areas.map((area) => {
    const current = live.filter((e) => e.area === area);
    return html`<h2>${area}</h2>
<div class="cols">${humans.map((p) => {
      const mine = d.views.filter((v) => v.area === area && v.authors.includes(p.id));
      return html`<div class="row"><b>${p.name}</b>${mine.length ? mine.map((v) => html`
<div class="t"><a href="${entryHref(v)}">${v.title}</a> <span class="mut">· ${day(v.createdAt)}</span></div><div class="pre">${v.content}</div>`)
        : html`<p class="mut">No view recorded yet.</p>`}</div>`;
    })}</div>
${current.length ? html`<div class="t">Current decisions</div>${current.map((e) => html`<div><a href="${entryHref(e)}">${e.title}</a></div>`)}` : ''}`;
  }) : html`<p class="mut">No views recorded yet.</p>`}` });
};

const wsLink = (w: Entry) => html`<a href="${entryHref(w)}">${w.title}</a>`;

export const teamPage = (d: { person: Person; people: Person[]; workstreams: Entry[]; updates: Entry[]; recent: Entry[] }) => {
  const byId = new Map(d.workstreams.map((w) => [w.id, w]));
  // Updates are newest first, so the first one found is the latest; progress updates never touch the workstream's own updatedAt.
  const wsRow = (w: Entry) => html`<div class="row">${wsLink(w)} ${statusPill(w)}
<span class="mut">· ${day(d.updates.find((u) => u.workstreamId === w.id)?.createdAt ?? w.createdAt)}</span></div>`;
  return layout({ title: 'Team', active: 'team', person: d.person, body: html`${d.people.filter((p) => !p.isSystem).map((p) => {
    const own = (e: Entry) => e.recordedBy === p.id || e.authors.includes(p.id);
    const mine = d.workstreams.filter(own);
    const open = mine.filter((w) => w.status !== 'done');
    const done = mine.filter((w) => w.status === 'done');
    const blocked = mine.filter((w) => w.status === 'blocked');
    const current = d.updates.filter(own).map((u) => byId.get(u.workstreamId ?? '')).find((w) => w && w.status !== 'done') ?? open[0];
    const last = d.recent.find(own);
    return html`<div class="row"><h3>${p.name}</h3>
<div><b>Working on:</b> ${current ? wsLink(current) : html`<span class="mut">Nothing in progress.</span>`}</div>
<div><b>Last activity:</b> ${last ? html`<a href="${entryHref(last)}">${last.title}</a> <span class="mut">· ${day(last.createdAt)}</span>`
  : html`<span class="mut">No activity yet.</span>`}</div>
${blocked.length ? html`<div><b>Blocked:</b> ${blocked.map((w) => html`${wsLink(w)} `)}</div>` : ''}
${open.length || done.length ? html`<div class="t">Workstreams</div>${open.map(wsRow)}
${done.length ? html`<details><summary>Done (${done.length})</summary>${done.map(wsRow)}</details>` : ''}` : ''}</div>`;
  })}` });
};

export const workstreamPage = (d: { person: Person; people: Person[]; workstream: Entry; updates: Entry[]; others: Entry[] }) => {
  const w = d.workstream;
  const act = `/dashboard/workstreams/${w.id}`;
  return layout({ title: w.title, active: 'team', person: d.person, body: html`
<h2>${w.title}</h2>
<p>${statusPill(w)}</p>
<div class="pre">${w.content}</div>
${w.resolutionNote && html`<p class="mut">${w.resolutionNote}</p>`}
<div class="t">Progress</div>
<div class="tl">${d.updates.length ? d.updates.map((u) => html`<div><span class="mut">${day(u.createdAt)}</span> · <a href="${entryHref(u)}">${u.title}</a>
<span class="mut">· by ${names(d.people, u.authors)}</span><div class="pre">${u.content}</div></div>`) : html`<span class="mut">No updates yet.</span>`}</div>
<div class="t">Manage</div>
<form class="inl" method="post" action="${act}/rename"><input name="title" value="${w.title}" required><button>Rename</button></form>
<form class="inl" method="post" action="${act}/status"><select name="status">
${(['in_progress', 'blocked', 'done'] as const).map((s) => html`<option value="${s}" ${s === w.status ? 'selected' : ''}>${s}</option>`)}
</select><button>Set status</button></form>
${d.others.length ? html`<form class="inl" method="post" action="${act}/merge" onsubmit="return confirm('Move all updates and close this workstream?')">
<select name="into">${d.others.map((o) => html`<option value="${o.id}">${o.title}</option>`)}</select><button>Merge into</button></form>` : ''}` });
};
