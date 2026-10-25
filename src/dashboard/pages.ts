import { html } from 'hono/html';
import type { Change, Entry, EntryType, Person } from '../domain/types';
import {
  ago, areaTag, avatar, avatarOf, avatars, consensus, daysAgo, entryHref, icon, layout, nameOf, names, sides, status, statusLabel,
  tally, typeLabel, typeTile, when, type Search, type Viewer,
} from './html';

const SHOWN = 50;
const DONE_SHOWN = 6;

type Motion = { proposal: Entry; target: Entry | null };

const link = (e: Entry | null) => e && !e.deletedAt ? html`<a href="${entryHref(e)}">${e.title}</a>` : html`(deleted)`;
const mine = (me: Person, p: Entry) => p.authors.includes(me.id) || p.recordedBy === me.id;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const has = (q: string, ...texts: (string | null)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q.toLowerCase()));
const qs = (o: Record<string, string>) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
  return s ? `?${s}` : '';
};

// proposeRevision stores the justification after the proposed text.
const JUSTIFICATION = '\n\nJustification: ';
const splitProposal = (content: string) => {
  const at = content.lastIndexOf(JUSTIFICATION);
  return at < 0 ? { text: content, why: '' } : { text: content.slice(0, at), why: content.slice(at + JUSTIFICATION.length) };
};

// A proposal awaiting (or past) a verdict: what it changes, side by side. `back` is where Accept/Reject return to.
const motion = (me: Person, people: Person[], { proposal: p, target }: Motion, back: string) => {
  const { text, why } = splitProposal(p.content);
  const live = target && !target.deletedAt ? target : null;
  return html`<article class="card motion"><header>${typeTile('proposal')}<div>
<h3><a href="${entryHref(p)}">${p.title}</a></h3>
<div class="revises">Revises: ${link(target)}</div>
<div class="meta">${avatars(people, p.authors)} by ${names(people, p.authors)} · ${when(p.createdAt)} ${areaTag(p.area)}${p.status !== 'open' ? html` ${status(p.status)}` : ''}</div></div></header>
<div class="compare"><div><h4>Current verdict</h4><p class="pre">${live ? live.content : 'No longer available.'}</p></div>
<div class="new"><h4>Proposed</h4><p class="pre">${text}</p></div></div>
${why && html`<p class="why"><b>Why:</b> ${why}</p>`}
<footer>${p.status !== 'open' ? html`<p class="waiting">${p.resolutionNote ? `Reason: ${p.resolutionNote}` : `${statusLabel(p.status)} with no reason given.`}</p>`
  : mine(me, p) ? html`<p class="waiting">${icon('clock')}Waiting for another team member — you cannot close your own proposal.</p>`
  : html`<form method="post" action="/dashboard/proposals/${p.id}/accept"><input type="hidden" name="back" value="${back}"><button class="hot">${icon('check')}Accept</button></form>
<details class="reject"><summary class="btn">${icon('x')}Reject…</summary><form method="post" action="/dashboard/proposals/${p.id}/reject">
<input type="hidden" name="back" value="${back}"><input name="reason" aria-label="Reason" placeholder="Reason (optional)"><button>Reject</button></form></details>`}</footer>
</article>`;
};

const empty = (text: string) => html`<p class="empty">${icon('check')}${text}</p>`;

const changeItem = (people: Person[], { kind, entry: e }: Change) => {
  const byId = (kind === 'new' ? e.recordedBy : kind === 'changed' ? e.updatedBy : e.deletedBy) ?? e.recordedBy;
  const by = nameOf(people, byId);
  const at = kind === 'removed' ? e.deletedAt ?? e.updatedAt : kind === 'changed' ? e.updatedAt : e.createdAt;
  // A deleted entry never shows its title or content.
  return kind === 'removed'
    ? html`<li class="item">${typeTile(e.type)}<div class="body"><span class="mut">${by} removed a ${e.type}</span><div class="meta">${when(at)}</div></div>
<span class="kind removed">Removed</span></li>`
    : html`<li class="item">${typeTile(e.type)}<div class="body"><a class="title" href="${entryHref(e)}">${e.title}</a>
<div class="meta">${avatarOf(people, byId)} by ${by} · <span class="type t-${e.type}">${typeLabel(e.type)}</span> ${areaTag(e.area)} · ${when(at)}</div></div>
${kind === 'changed' ? html`<span class="kind">Changed</span>` : ''}</li>`;
};

// Changes grouped by day, newest first: "today", "yesterday", "3 days ago", then "Earlier".
const byDay = (people: Person[], changes: Change[]) => {
  const at = (c: Change) => c.kind === 'removed' ? c.entry.deletedAt ?? c.entry.updatedAt : c.kind === 'changed' ? c.entry.updatedAt : c.entry.createdAt;
  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    const d = at(c);
    const key = daysAgo(d) < 7 ? ago(d) : 'Earlier';
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return html`<ul class="feed">${[...groups].map(([label, rows]) => html`<li class="day">${label}</li>${rows.map((c) => changeItem(people, c))}`)}</ul>`;
};

const decisionRow = (people: Person[], e: Entry) => html`<li><div class="body"><a class="title" href="${entryHref(e)}">${e.title}</a>
<div class="tags">${status(e.status)}${tally(people, e)}<span class="meta">${when(e.createdAt)}</span></div></div></li>`;

const owns = (p: Person) => (e: Entry) => e.recordedBy === p.id || e.authors.includes(p.id);

export const homePage = (d: Viewer & Search & {
  changes: Change[]; since: Date; results: Entry[] | null; timeline: Entry[]; motions: Motion[]; workstreams: Entry[]; activeDecisions: number;
}) => {
  const forMe = d.motions.filter((m) => !mine(d.person, m.proposal));
  const waiting = d.motions.filter((m) => mine(d.person, m.proposal));
  const shown = d.changes.slice(0, SHOWN);
  const blocked = d.workstreams.filter((w) => w.status === 'blocked');
  const humans = d.people.filter((p) => !p.isSystem);
  const kinds = [...new Set(d.changes.map((c) => c.entry.type))].map((t: EntryType) =>
    plural(d.changes.filter((c) => c.entry.type === t).length, t)).join(' · ');
  const headline = forMe.length ? `${plural(forMe.length, 'proposal needs', 'proposals need')} your verdict` : 'Nothing needs your verdict';
  return layout({ title: 'Home', active: 'home', viewer: d, search: d, body: html`
<div class="head"><div><h1>Welcome back, ${d.person.name.split(/\s+/)[0]}</h1>
<p class="sub">${headline} · ${d.changes.length ? plural(d.changes.length, 'change') : 'no changes'} by others since your last visit, ${ago(d.since)}.</p></div></div>
${d.results && html`<section class="card panel results" style="margin-bottom:28px"><h2 class="sh">${icon('search')}Search results <span class="n">${d.results.length}</span></h2>
${d.results.length ? html`<ul class="list">${d.results.map((e) => html`<li>${typeTile(e.type)}<div class="body"><a class="title" href="${entryHref(e)}">${e.title}</a>
<div class="tags"><span class="type t-${e.type}">${typeLabel(e.type)}</span>${areaTag(e.area)}${status(e.status)}<span class="meta">${when(e.createdAt)}</span></div></div></li>`)}</ul>`
  : html`<p class="mut">No results. Try fewer words, or another area.</p>`}</section>`}
<div class="focus">
<a class="card tile ${forMe.length ? 'hot' : ''}" href="#verdict"><div class="row"><span class="tic t-proposal">${icon('proposal')}</span><b>${forMe.length}</b></div>
<span class="l">Needs your verdict</span><small>${forMe[0]?.proposal.title ?? 'Nothing waiting on you.'}</small></a>
<a class="card tile" href="#new"><div class="row"><span class="tic t-new">${icon('bell')}</span><b>${d.changes.length}</b></div>
<span class="l">New since your visit</span><small>${kinds || 'You are caught up.'}</small></a>
<a class="card tile" href="/dashboard/team"><div class="row"><span class="tic t-blocked">${icon('alert')}</span><b>${blocked.length}</b></div>
<span class="l">Blocked workstreams</span><small>${blocked.length ? blocked.map((w) => w.title).join(', ') : 'Nothing is blocked.'}</small></a>
<a class="card tile" href="#timeline"><div class="row"><span class="tic t-decision">${icon('decision')}</span><b>${d.activeDecisions}</b></div>
<span class="l">Active decisions</span><small>${d.activeDecisions ? `Across ${plural(new Set(d.timeline.filter((e) => e.status === 'active').map((e) => e.area)).size, 'area')}` : 'No active decisions yet.'}</small></a>
</div>
<div class="split"><div>
<section class="sec" id="verdict"><h2 class="sh ${forMe.length ? 'hot' : ''}">Needs your verdict <span class="n">${forMe.length}</span></h2>
${forMe.length ? forMe.map((m) => motion(d.person, d.people, m, '/dashboard'))
  : empty('No open proposals from others. When someone proposes changing a decision, it lands here for you to accept or reject.')}
${waiting.length ? html`<div class="card panel" style="margin-top:14px"><h2>${icon('clock')}Your proposals, waiting on a teammate</h2><ul class="list">${waiting.map(({ proposal: p, target }) =>
  html`<li><div class="body"><a class="title" href="${entryHref(p)}">${p.title}</a><div class="meta">Revises: ${link(target)} · ${when(p.createdAt)}</div></div></li>`)}</ul></div>` : ''}
</section>
<section class="sec" id="new"><h2 class="sh">What's new since your last visit <span class="n">${d.changes.length}</span></h2>
${shown.length ? html`<div class="card">${byDay(d.people, shown)}</div>` : empty("Nothing new. You're caught up.")}
${d.changes.length > SHOWN && html`<p class="mut" style="margin-top:10px">…and ${d.changes.length - SHOWN} more</p>`}
</section></div>
<aside class="sec">
<section class="card panel"><h2>${icon('team')}Team now</h2><ul class="list">${humans.map((p) => {
    const open = d.workstreams.filter(owns(p)).filter((w) => w.status !== 'done');
    const now = open.find((w) => w.status === 'blocked') ?? open[0];
    return html`<li>${avatar(p)}<div class="body"><div class="title">${p.name}</div>
<div class="meta">${now ? html`<a href="${entryHref(now)}">${now.title}</a> ${status(now.status)}` : 'Nothing in progress.'}</div></div></li>`;
  })}</ul></section>
<section class="card panel" id="timeline"><h2>${icon('decision')}Decision timeline</h2>
${d.timeline.length ? html`<ul class="list">${d.timeline.map((e) => decisionRow(d.people, e))}</ul>`
  : html`<p class="mut">No decisions yet. Ask your agent to record one.</p>`}</section>
</aside></div>` });
};

type History = { before: (Entry | null)[]; after: Entry[]; proposals: Entry[] };

export const proposalsPage = (d: Viewer & { items: Motion[]; rejected: Motion[]; tab: 'open' | 'rejected'; q: string; area: string }) => {
  const pick = (list: Motion[]) => list.filter(({ proposal: p }) => (!d.area || p.area === d.area) && has(d.q, p.title, p.content));
  const list = pick(d.tab === 'open' ? d.items : d.rejected)
    .sort((a, b) => Number(mine(d.person, a.proposal)) - Number(mine(d.person, b.proposal)));
  const areas = [...new Set([...d.items, ...d.rejected].map((m) => m.proposal.area))].sort();
  const tab = (key: 'open' | 'rejected', label: string, n: number) =>
    html`<a href="/dashboard/proposals${qs({ tab: key === 'open' ? '' : key, q: d.q, area: d.area })}"${key === d.tab ? html` class="on" aria-current="page"` : ''}>${label} <span class="n">${n}</span></a>`;
  return layout({ title: 'Proposals', active: 'proposals', viewer: d, body: html`
<div class="head"><div><h1>Proposals</h1><p class="sub">A team decision only changes when someone other than the proposer accepts.</p></div></div>
<div class="filters"><nav class="tabs" aria-label="Proposal status">${tab('open', 'Open', d.items.length)}${tab('rejected', 'Rejected', d.rejected.length)}</nav>
<form class="sgroup" action="/dashboard/proposals" method="get">${d.tab === 'rejected' ? html`<input type="hidden" name="tab" value="rejected">` : ''}${icon('search')}
<input name="q" value="${d.q}" aria-label="Filter proposals" placeholder="Filter by words">
<select name="area" aria-label="Area"><option value="">All areas</option>${areas.map((a) => html`<option value="${a}" ${a === d.area ? 'selected' : ''}>${a}</option>`)}</select>
<button class="go">Filter</button></form></div>
${list.length ? list.map((i) => motion(d.person, d.people, i, '/dashboard/proposals'))
  : d.q || d.area ? empty('No proposals match these filters.')
  : empty(d.tab === 'open' ? 'No open proposals.' : 'No rejected proposals yet.')}` });
};

const SOURCE = { meet: 'From a meeting', claude_code: 'From an agent session', explicit: 'Recorded directly' } as const;

// The facts about an entry, for the side column.
const details = (people: Person[], e: Entry, extra: [string, string][]) => html`<section class="card panel"><h2>Details</h2><dl class="dl">
<dt>Recorded</dt><dd>${when(e.createdAt)}</dd>
<dt>Area</dt><dd>${areaTag(e.area)}</dd>
${extra.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}
<dt>${e.authors.length === 1 ? 'Author' : 'Authors'}</dt><dd><div class="who-list">${e.authors.map((id) => html`<span>${avatarOf(people, id)}${nameOf(people, id)}</span>`)}</div></dd>
</dl></section>`;

const decisionBody = (people: Person[], e: Entry, h: History) => {
  const s = sides(people, e);
  const total = s.reduce((n, g) => n + g.members.length, 0);
  return html`<article class="entry">
<div class="hero">${typeTile('decision')}<div><h1>${e.title}</h1>
<div class="tags">${status(e.status)}${e.consensus && consensus(e.consensus)}${areaTag(e.area)}</div></div></div>
<div class="split"><div>
${e.question && html`<section><h2 class="sh">Question</h2><div class="card qa"><p class="lead pre">${e.question}</p></div></section>`}
${s.length ? html`<section class="sec"><h2 class="sh">Positions ${tally(people, e)}</h2>
<div class="sides">${s.map((g) => html`<div class="card side ${g.tone}"><header><h3>${g.position}</h3><span class="score">${g.members.length} of ${total}</span></header>
<ul>${g.members.map((m) => html`<li>${avatarOf(people, m.id, '')}<div><b>${m.name}</b>${m.arguments && html`<p class="pre">${m.arguments}</p>`}</div></li>`)}</ul></div>`)}</div></section>` : ''}
<section class="sec"><h2 class="sh">Verdict</h2><div class="card verdict"><p class="pre">${e.content}</p>
${e.consensus && e.consensus !== 'unanimous' && e.consensusReason && html`<p class="note">Why we went ahead without full consensus: ${e.consensusReason}</p>`}</div></section></div>
<aside>${details(people, e, [['Source', SOURCE[e.sourceKind]]])}
<section class="card panel"><h2>${icon('clock')}History</h2>
${h.before.length + h.after.length + h.proposals.length ? html`<ol class="timeline">
${[...h.after].reverse().map((a) => html`<li><div class="label">Superseded by</div><div class="title">${link(a)} ${status(a.status)}</div></li>`)}
${h.proposals.map((p) => html`<li><div class="label">Revision proposal</div><div class="title">${link(p)} ${status(p.status)}</div></li>`)}
<li class="here"><div class="label">This decision</div><div class="title">${e.title}</div></li>
${h.before.map((b) => html`<li><div class="label">Supersedes</div><div class="title">${link(b)}</div></li>`)}</ol>`
  : html`<p class="mut">No history. This is the first version of this decision.</p>`}</section></aside></div></article>`;
};

const otherBody = (people: Person[], e: Entry) => html`<article class="entry">
<div class="hero">${typeTile(e.type)}<div><h1>${e.title}</h1>
<div class="tags"><span class="type t-${e.type}">${typeLabel(e.type)}</span>${status(e.status)}${areaTag(e.area)}</div></div></div>
<div class="split"><div class="card panel"><p class="lead pre">${e.content}</p></div>
<aside>${details(people, e, [])}
${e.workstreamId && html`<a class="btn" href="/dashboard/workstreams/${e.workstreamId}">${icon('workstream')}Open the workstream</a>`}</aside></div></article>`;

export const entryPage = (d: Viewer & { entry: Entry; target: Entry | null; history: History }) => {
  const e = d.entry;
  const body = e.type === 'decision' ? decisionBody(d.people, e, d.history)
    : e.type === 'proposal' ? html`<div class="entry">${motion(d.person, d.people, { proposal: e, target: d.target }, '/dashboard/proposals')}</div>`
    : otherBody(d.people, e);
  return layout({ title: e.title, active: e.type === 'proposal' ? 'proposals' : null, viewer: d, body });
};

export const viewsPage = (d: Viewer & { views: Entry[]; decisions: Entry[]; area: string; q: string }) => {
  const humans = d.people.filter((p) => !p.isSystem);
  const live = d.decisions.filter((e) => e.status === 'active' || e.status === 'under_review');
  const views = d.views.filter((v) => has(d.q, v.title, v.content, v.area));
  // Views are newest first, so first appearance orders areas by latest activity.
  const areas = [...new Set(views.map((v) => v.area))];
  const area = areas.includes(d.area) ? d.area : areas[0];
  const current = live.filter((e) => e.area === area);
  return layout({ title: 'Who thinks what', active: 'views', viewer: d, body: html`
<div class="head"><div><h1>Who thinks what</h1><p class="sub">Each person's views on a topic, side by side, next to what the team decided.</p></div></div>
<div class="filters"><form class="sgroup" action="/dashboard/views" method="get">${icon('search')}
<input name="q" value="${d.q}" aria-label="Filter views" placeholder="Filter views by words"><button class="go">Filter</button></form></div>
${area ? html`<div class="two"><nav class="card areas" aria-label="Areas">${areas.map((a) => html`<a href="/dashboard/views${qs({ area: a, q: d.q })}"${a === area ? html` class="on" aria-current="page"` : ''}>
${a}<span class="n">${views.filter((v) => v.area === a).length}</span></a>`)}</nav>
<section><h2 class="area-h">${area}</h2>
${current.length ? html`<div class="card current">${typeTile('decision')}<div><h3>Current decision${current.length > 1 ? 's' : ''}</h3>
${current.map((e) => html`<div><a href="${entryHref(e)}">${e.title}</a></div>`)}</div></div>` : html`<div style="height:16px"></div>`}
<div class="people">${humans.map((p) => {
    const own = views.filter((v) => v.area === area && v.authors.includes(p.id));
    return html`<div class="card col ${own.length ? '' : 'none'}"><header>${avatar(p)}${p.name}</header>${own.length ? own.map((v) => html`<div class="view">
<a href="${entryHref(v)}">${v.title}</a><div class="meta">${when(v.createdAt)}</div><p class="pre">${v.content}</p></div>`)
      : html`<p class="mut">No view recorded yet.</p>`}</div>`;
  })}</div></section></div>`
  : d.q ? empty('No views match these words.') : empty('No views recorded yet. Ask your agent to record your view on a topic.')}` });
};

export const teamPage = (d: Viewer & { workstreams: Entry[]; updates: Entry[]; recent: Entry[] }) => {
  const byId = new Map(d.workstreams.map((w) => [w.id, w]));
  // Updates are newest first, so the first one found is the latest; progress updates never touch the workstream's own updatedAt.
  const latest = (w: Entry) => d.updates.find((u) => u.workstreamId === w.id)?.createdAt ?? w.createdAt;
  const wsCard = (w: Entry) => {
    const n = d.updates.filter((u) => u.workstreamId === w.id).length;
    return html`<a class="ws" href="${entryHref(w)}"><span class="title">${w.title}</span>
<span class="meta">${avatars(d.people, w.authors)}<span>${plural(n, 'update')} · ${when(latest(w))}</span></span></a>`;
  };
  const lane = (label: string, tone: string, list: Entry[], cap = list.length) => html`<div class="lane"><h3><span class="st ${tone}">${label}</span><span class="n">${list.length}</span></h3>
${list.length ? list.slice(0, cap).map(wsCard) : html`<p class="empty">None.</p>`}
${list.length > cap ? html`<details><summary>Show ${list.length - cap} more</summary>${list.slice(cap).map(wsCard)}</details>` : ''}</div>`;
  const by = (s: string) => d.workstreams.filter((w) => w.status === s);
  return layout({ title: 'Team', active: 'team', viewer: d, body: html`
<div class="head"><div><h1>Team</h1><p class="sub">What each person is working on, and where they are stuck.</p></div></div>
<div class="crew">${d.people.filter((p) => !p.isSystem).map((p) => {
    const own = owns(p);
    const mine = d.workstreams.filter(own);
    const open = mine.filter((w) => w.status !== 'done');
    const blocked = mine.filter((w) => w.status === 'blocked');
    const current = d.updates.filter(own).map((u) => byId.get(u.workstreamId ?? '')).find((w) => w && w.status !== 'done') ?? open[0];
    const last = d.recent.find(own);
    return html`<article class="card person"><header>${avatar(p, 'lg')}<h3>${p.name}</h3></header>
<div class="line"><b>Working on:</b> <span>${current ? html`<a href="${entryHref(current)}">${current.title}</a>` : html`<span class="mut">Nothing in progress.</span>`}</span></div>
<div class="line"><b>Last activity:</b> <span>${last ? html`<a href="${entryHref(last)}">${last.title}</a> <span class="mut">· ${when(last.createdAt)}</span>`
  : html`<span class="mut">No activity yet.</span>`}</span></div>
${blocked.length ? html`<div class="line alert"><b>Blocked:</b> <span>${blocked.map((w) => html`<a href="${entryHref(w)}">${w.title}</a> `)}</span></div>` : ''}
${mine.length ? html`<div class="stats">${[['info', open.length - blocked.length, 'in progress'], ['bad', blocked.length, 'blocked'], ['ok', mine.length - open.length, 'done']]
  .filter(([, n]) => n).map(([tone, n, label]) => html`<span class="st ${tone}">${n} ${label}</span>`)}</div>` : ''}</article>`;
  })}</div>
<section class="sec"><h2 class="sh">Workstreams <span class="n">${d.workstreams.length}</span></h2>
<div class="board">${lane('In progress', 'info', by('in_progress'))}${lane('Blocked', 'bad', by('blocked'))}${lane('Done', 'ok', by('done'), DONE_SHOWN)}</div></section>` });
};

const WS_STATUSES = ['in_progress', 'blocked', 'done'] as const;

export const workstreamPage = (d: Viewer & { workstream: Entry; updates: Entry[]; others: Entry[] }) => {
  const w = d.workstream;
  const act = `/dashboard/workstreams/${w.id}`;
  return layout({ title: w.title, active: 'team', viewer: d, body: html`
<div class="hero">${typeTile('workstream')}<div><h1>${w.title}</h1>
<div class="tags">${status(w.status)}${areaTag(w.area)}<span class="meta">Started ${when(w.createdAt)} · ${avatars(d.people, w.authors)} ${names(d.people, w.authors)}</span></div></div></div>
<div class="split"><div>
<div class="card panel"><p class="lead pre">${w.content}</p>${w.resolutionNote && html`<p class="mut" style="margin-top:10px">${w.resolutionNote}</p>`}</div>
<section class="sec"><h2 class="sh">Progress <span class="n">${d.updates.length}</span></h2>
${d.updates.length ? html`<div class="card panel"><ol class="timeline">${d.updates.map((u, i) => html`<li${i === 0 ? html` class="here"` : ''}>
<div class="label">${when(u.createdAt)}</div><div class="title"><a href="${entryHref(u)}">${u.title}</a></div>
<div class="meta">${avatars(d.people, u.authors)} by ${names(d.people, u.authors)}</div><p class="pre">${u.content}</p></li>`)}</ol></div>`
  : empty('No updates yet. Progress your agent records on this workstream shows up here.')}</section></div>
<aside class="card manage"><h2 class="sh">Manage</h2>
<form method="post" action="${act}/rename"><label for="ws-title">Title</label><div class="row">
<input id="ws-title" name="title" value="${w.title}" required><button>Rename</button></div></form>
<form method="post" action="${act}/status"><label for="ws-status">Status</label><div class="row"><select id="ws-status" name="status">
${WS_STATUSES.map((s) => html`<option value="${s}" ${s === w.status ? 'selected' : ''}>${statusLabel(s)}</option>`)}
</select><button>Set status</button></div></form>
${d.others.length ? html`<form method="post" action="${act}/merge" onsubmit="return confirm('Move all updates and close this workstream?')">
<label for="ws-into">Merge into another workstream</label><div class="row"><select id="ws-into" name="into">${d.others.map((o) => html`<option value="${o.id}">${o.title}</option>`)}</select>
<button>Merge</button></div></form>` : ''}</aside></div>` });
};
