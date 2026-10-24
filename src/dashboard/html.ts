import { html, raw } from 'hono/html';
import type { Entry, Person } from '../domain/types';

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--soft:#f1f0ec;--line:#e2e0d9;--tx:#1f1f1d;--mut:#6b6a65;--ok:#e6f3dc;--okt:#2f5a0f;--acc:#e6f1fb;--acct:#0c447c;--warn:#faeeda;--warnt:#633806}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1e;--soft:#262625;--line:#3a3936;--tx:#ecebe6;--mut:#a3a29c;--ok:#27500a;--okt:#c0dd97;--acc:#0c447c;--acct:#b5d4f4;--warn:#633806;--warnt:#fac775}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 system-ui,sans-serif;padding:16px}
a{color:inherit}
.sp{max-width:960px;margin:auto;display:grid;grid-template-columns:180px minmax(0,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.nav{background:var(--soft);padding:14px 8px;display:flex;flex-direction:column;gap:2px}
.nav a{padding:8px 12px;border-radius:8px;color:var(--mut);text-decoration:none}
.nav a.on{background:var(--card);color:var(--tx);font-weight:500}
.nav .brand{font-weight:500;padding:4px 12px 12px}.nav .me{margin-top:auto;padding:12px 12px 0;color:var(--mut)}
.main{padding:20px 22px;background:var(--card);min-height:520px;overflow-wrap:anywhere}
.row{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;display:inline-block}
.ok{background:var(--ok);color:var(--okt)}.acc{background:var(--acc);color:var(--acct)}.warn{background:var(--warn);color:var(--warnt)}.mut{color:var(--mut)}
.pill.mut{background:var(--soft)}
input,select,button{font:inherit;color:var(--tx);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
.search{display:flex;gap:8px;margin-bottom:14px}.search input{flex:1;min-width:0}
.tl{border-left:2px solid var(--line);padding-left:12px;line-height:2}
.t{font-weight:500;margin:14px 0 8px}h3{margin:0 0 6px;font-weight:500}
.pre{white-space:pre-wrap}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}.cols .row{margin:0}
form.inl{display:inline-flex;gap:8px;margin:0 8px 0 0}
.nav .me form{margin:4px 0 0}.nav button.out{border:0;background:none;padding:0;color:var(--mut);text-decoration:underline;cursor:pointer}
@media (max-width:640px){.sp{grid-template-columns:1fr}.nav{flex-direction:row;flex-wrap:wrap;align-items:center}.nav .brand{padding:4px 12px}.nav .me{margin:0 0 0 auto;padding:0 12px}}
`;

const NAV = [['home', '/dashboard', 'Home'], ['proposals', '/dashboard/proposals', 'Proposals'],
  ['views', '/dashboard/views', 'Who thinks what'], ['team', '/dashboard/team', 'Team']] as const;

const head = (title: string) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${raw(CSS)}</style></head>`;

// Who is looking, plus what the nav needs on every page.
export type Viewer = { person: Person; people: Person[]; openProposals: number };

export const layout = (o: { title: string; active: 'home' | 'proposals' | 'views' | 'team' | null; viewer: Viewer; body: unknown }) =>
  html`${head(`${o.title} · SamePage`)}
<body><div class="sp">
<nav class="nav"><div class="brand">SamePage</div>
${NAV.map(([key, href, label]) => html`<a href="${href}" class="${key === o.active ? 'on' : ''}">${label}${
  key === 'proposals' && o.viewer.openProposals ? html` <span class="pill warn">${o.viewer.openProposals}</span>` : ''}</a>`)}
<div class="me">${o.viewer.person.name}
<form method="post" action="/dashboard/logout"><button class="out">Sign out</button></form></div></nav>
<main class="main">${o.body}</main>
</div></body></html>`;

// Bare page for errors: it must work without a signed-in person.
export const message = async (status: number, text: string, back?: { href: string; label: string }): Promise<Response> =>
  new Response(await html`${head('SamePage')}<body><div class="sp" style="display:block"><main class="main"><p>${text}</p>
${back && html`<p><a href="${back.href}">${back.label}</a></p>`}</main></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

export const entryHref = (e: Entry) => `/dashboard/${e.type === 'workstream' ? 'workstreams' : 'entries'}/${e.id}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const nameOf = (people: Person[], id: string) => people.find((p) => p.id === id)?.name ?? id;
export const pill = (text: string, tone: 'ok' | 'acc' | 'warn' | 'mut') => html`<span class="pill ${tone}">${text}</span>`;
