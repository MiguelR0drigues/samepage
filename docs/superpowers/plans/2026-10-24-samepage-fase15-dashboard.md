# SamePage Phase 1.5 (Web Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A light, server-rendered web dashboard on the same Worker, opened with a one-time link from the MCP tool `open_dashboard`, that shows what's new, decisions, proposals, who-thinks-what and team activity, and lets people close proposals and tidy workstreams.

**Architecture:** A Hono sub-app mounted at `/dashboard` **before** the bearer-token middleware (same pattern as `/health`). Auth is a signed one-time link (HS256 JWT, 10 min, nonce stored on `people`) traded for a signed 30-day session cookie. Routes load data through `Store`, write only through `Memory`, and render HTML with Hono's escaping `html` helper. No client JS beyond two inline one-liners.

**Tech Stack:** existing (Hono 4.13, Drizzle, PGlite, Vitest). Uses only Hono built-ins: `hono/jwt`, `hono/cookie`, `hono/csrf`, `hono/html`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-24-collabdb-design.md`, section 8 item 1.5 (screens, login), 5 (data), 6.7 (proposal rules). Layout reference: `docs/mockups/dashboard.html` (its text is Portuguese; the product UI is English). Conventions: `docs/superpowers/plans/2026-10-24-collabdb-fase1-nucleo.md`.

## Global Constraints

- Everything in the product is **English**: UI text, code, errors, commit messages.
- Free tiers only. Workers free plan: **10 ms CPU per request**. Server-rendered HTML, no framework, no client bundle; at most ~8 sequential queries per page.
- **Read-only**, except: accept/reject proposals (via `Memory.acceptProposal/rejectProposal`, unchanged rules), and workstream rename / merge / status (via `Memory`, any human team member).
- Only `src/storage/postgres/` imports Drizzle. Dashboard code talks to `Store` and `Memory`.
- Secret: `DASHBOARD_SECRET` (Worker secret; `.dev.vars` locally). Missing secret → `open_dashboard` returns the tool error `The dashboard is not configured on this server.`
- Link: one-time, **10 minutes** (`LINK_TTL_S = 600`). Session cookie: **30 days** (`SESSION_TTL_S = 2592000`), name `sp_session`, `HttpOnly; Secure; SameSite=Lax; Path=/dashboard`.
- **Two independent "what's new" cursors.** The MCP summary reads/advances only `people.last_seen_at`; the dashboard reads/advances only `people.dashboard_seen_at`. Neither surface ever touches the other's cursor. Rule for the dashboard: a *visit* starts when you open Home without a live `sp_visit` cookie (30 min sliding); at visit start, Home shows changes since `dashboard_seen_at` (first ever visit: last 7 days), stores that cutoff in `sp_visit`, and sets `dashboard_seen_at = now`. Refreshes within the visit reuse the cookie's cutoff. Bias: may repeat an item across visits, never misses one.
- Deleted entries never show a title or content in the dashboard (same rule as the summary): "removed" changes show type and who; a deleted entry's page is 404; a deleted link in a history chain shows `(deleted)`.
- Keep edits to `src/mcp/server.ts` and `src/http/app.ts` small (a parallel Phase 2 branch touches them). Rebase on `main` before the PR.
- Production changes (Neon migration, `wrangler secret put`, `wrangler deploy`) only after the user says yes. Never print `.env.local` contents.

## Review Focus

1. **A replayed or forwarded link** (pasted twice, opened by someone else later): works once, within 10 minutes, and only as a link (a link token is not a session and vice versa). Tests in Task 3.
2. **A cross-site form POST** (another site posting to `/dashboard/proposals/:id/accept` with the victim's cookie): refused with 403 by `csrf()`; `SameSite=Lax` is the second layer. Test in Task 5.
3. **Agent-written text containing HTML** (`<script>` in a title, content or position): rendered escaped on every screen. Test in Task 4 (Home) and Task 5 (decision page positions).
4. **Malformed or unknown ids in URLs** (`/dashboard/entries/abc`, a deleted id, a workstream id on the entries route): 404 page, never a 500 from Postgres' uuid parser. Tests in Tasks 5 and 6.
5. **Cursor interference**: opening the dashboard must not eat the MCP summary's "New since your last session", and vice versa. Test in Task 4.

---

## File Structure

```
src/domain/types.ts            Person gains dashboardSeenAt
src/storage/store.ts           EntryFilter gains link filters; 4 new Store methods
src/storage/postgres/schema.ts people gains dashboard_seen_at, dashboard_nonce (+ generated migration 0002)
src/storage/postgres/store.ts  implementations
src/service/memory.ts          renameWorkstream, mergeWorkstream
src/dashboard/auth.ts          issueLink, redeemLink, sessionToken, readSession
src/dashboard/html.ts          layout, CSS (from the mockup), small render helpers
src/dashboard/pages.ts         one render function per screen (pure: data in, HTML out)
src/dashboard/routes.ts        dashboardRoutes(getStore): Hono sub-app (auth guard, loaders, POST actions)
src/mcp/server.ts              open_dashboard tool (buildMcpServer gains one parameter)
src/http/app.ts                Env.DASHBOARD_SECRET; mount /dashboard; pass openDashboard closure
tests/storage/postgres-store.test.ts, tests/service/memory.test.ts, tests/http/app.test.ts
tests/dashboard/auth.test.ts, tests/dashboard/routes.test.ts
tests/dashboard/helpers.ts     signIn() and request helpers shared by route tests
```

---

### Task 1: Store support (cursor, nonce, link filters, moving updates)

**Files:**
- Modify: `src/domain/types.ts`, `src/storage/store.ts`, `src/storage/postgres/schema.ts`, `src/storage/postgres/store.ts`; generate `src/storage/postgres/migrations/0002_*.sql` with `npm run db:generate`
- Fix any `Person` literals the new field breaks (typecheck finds them)
- Test: `tests/storage/postgres-store.test.ts`

**Interfaces:**
- `Person` gains `dashboardSeenAt: Date | null`. Columns: `dashboard_seen_at timestamptz null`, `dashboard_nonce text null`. `toPerson` strips `tokenHash` **and** `dashboardNonce` (the nonce never leaves the store except in `exportAll`, which keeps raw rows).
- `EntryFilter` gains `workstreamId?: string; supersedesId?: string; targetId?: string` (equality filters in `listEntries`).
- New `Store` methods:

```ts
touchDashboardSeen(personId: string, at: Date): Promise<void>;
setDashboardNonce(personId: string, nonce: string): Promise<void>;
// Atomic: clears the nonce only if it matches (UPDATE ... WHERE id = $1 AND dashboard_nonce = $2 RETURNING). False if it did not match.
consumeDashboardNonce(personId: string, nonce: string): Promise<boolean>;
// One UPDATE of entries.workstream_id; does not touch updatedAt/updatedBy, so moved updates do not flood "what's new". Returns rows moved.
moveUpdates(fromWorkstreamId: string, toWorkstreamId: string): Promise<number>;
```

- [ ] **Step 1: Write the failing tests** (existing `beforeEach` people `miguel`, `joao`):
  - `touchDashboardSeen sets dashboardSeenAt and leaves lastSeenAt alone` → after `touchDashboardSeen('miguel', t)`, person has `dashboardSeenAt` equal to `t` and `lastSeenAt === null`; `touchLastSeen` leaves `dashboardSeenAt` alone.
  - `a dashboard nonce is consumed once` → `setDashboardNonce('miguel','n1')`; `consumeDashboardNonce('miguel','n1')` is `true`, again `false`; `consumeDashboardNonce('miguel','other')` is `false`; `consumeDashboardNonce('joao','n1')` is `false`. `listPeople()` objects have no `dashboardNonce` key.
  - `listEntries filters by workstreamId, supersedesId and targetId` → one entry per link field; each filter returns only its entry.
  - `moveUpdates reassigns updates without touching updatedAt` → two updates on workstream A, one on B; `moveUpdates(A, B)` returns `2`; both now have `workstreamId === B` and unchanged `updatedAt`/`updatedBy`; `changesSince(beforeMove, 'joao')` is empty.
  - The existing export/import round-trip test still passes (new columns included).
- [ ] **Step 2:** Run `npx vitest run tests/storage/postgres-store.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement: schema columns, `npm run db:generate` (creates `0002_*.sql` with two `ADD COLUMN`s), the four methods, the filters.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: store support for the dashboard (cursor, nonce, link filters, moveUpdates)`.

---

### Task 2: `Memory` workstream rename and merge

**Files:**
- Modify: `src/service/memory.ts`
- Test: `tests/service/memory.test.ts`

**Interfaces:**
- Consumes: `Store.moveUpdates`, `EntryFilter.workstreamId` (Task 1).
- Produces:

```ts
renameWorkstream(actor: Person, id: string, title: string): Promise<Entry>;
// Moves every update of `fromId` to `intoId`, then sets `fromId` to status 'done' with resolutionNote `Merged into ${intoId}`. Returns the target workstream.
mergeWorkstream(actor: Person, fromId: string, intoId: string): Promise<Entry>;
```

- Rules (both): any human (`assertHuman`; not only authors); inside one transaction; the workstream(s) loaded `forUpdate`, must be non-deleted `workstream` entries else `MemoryError('Entry not found: <id>')`. Rename: trimmed title, empty → `MemoryError('A title is required.')`. Merge: `fromId === intoId` → `MemoryError('A workstream cannot be merged into itself.')`; lock the two rows in sorted-id order (avoids a deadlock when two people merge A→B and B→A at once).

- [ ] **Step 1: Write the failing tests** (`describe('Memory workstreams')`):
  - `any team member can rename a workstream` → joao renames miguel's workstream to `'  Launch v2 '` → title `'Launch v2'`, `updatedBy === 'joao'`; `'   '` → `'A title is required.'`; meet (system) → MemoryError; a decision id → `'Entry not found'`.
  - `merge moves the updates and closes the source` → workstreams A (2 updates) and B (1 update); `mergeWorkstream(joao, A, B)` returns B; `listEntries({type:'update', workstreamId: B})` has 3; A has `status 'done'` and `resolutionNote === \`Merged into ${B}\``.
  - `merge refuses itself, deleted and non-workstream targets` → `(A, A)` → `'cannot be merged into itself'`; deleted B → `'Entry not found'`; a decision as target → `'Entry not found'`; nothing changed (A still has its 2 updates and status `in_progress`).
- [ ] **Step 2:** Run `npx vitest run tests/service/memory.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the two methods next to `setWorkstreamStatus`, reusing `load` and `assertHuman`.
- [ ] **Step 4:** Run `npx vitest run tests/service/memory.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: rename and merge workstreams in Memory`.

---

### Task 3: Sign-in: `open_dashboard`, one-time link, session cookie, auth guard

**Files:**
- Create: `src/dashboard/auth.ts`, `src/dashboard/routes.ts` (login + guard + a placeholder `GET /` returning the person's name; Task 4 replaces it), `src/dashboard/html.ts` (only a bare `message(status: number, text: string)` page here; Task 4 adds `layout`, CSS and nav), `tests/dashboard/helpers.ts`
- Modify: `src/mcp/server.ts`, `src/http/app.ts`
- Test: `tests/dashboard/auth.test.ts`, `tests/dashboard/routes.test.ts`, `tests/http/app.test.ts` (tool list → 13)

**Interfaces:**
- Consumes: `Store.setDashboardNonce/consumeDashboardNonce` (Task 1).
- Produces, in `src/dashboard/auth.ts` (HS256 via `sign`/`verify` from `hono/jwt`; `verify(token, secret, 'HS256')` throws on bad signature/expiry → return `null`):

```ts
export const LINK_TTL_S = 600;
export const SESSION_TTL_S = 30 * 24 * 3600;
// Payload { sub, kind: 'link', nonce, exp }. Stores a fresh 16-byte hex nonce (so a new link revokes the previous one).
// MemoryError for a system actor or a missing secret ('The dashboard is not configured on this server.').
export function issueLink(store: Store, person: Person, origin: string, secret: string | undefined): Promise<string>; // `${origin}/dashboard/login?t=<jwt>`
export function redeemLink(store: Store, token: string, secret: string): Promise<string | null>; // person id, after consumeDashboardNonce
export function sessionToken(personId: string, secret: string): Promise<string>;               // { sub, kind: 'session', exp }
export function readSession(token: string, secret: string): Promise<string | null>;
```

- `src/dashboard/routes.ts`: `export function dashboardRoutes(getStore: (env: Env) => Store)` returning a `Hono<{ Bindings: Env; Variables: DashVars }>` where `DashVars = { store: Store; memory: Memory; person: Person; people: Person[] }`.
  - Every response gets `Referrer-Policy: no-referrer` (the link carries a token).
  - `GET /login?t=` → `redeemLink`; success: set `sp_session` (attributes in Global Constraints) and `302` to `/dashboard`; failure: `401` message page `This sign-in link has expired or was already used. Ask your agent to open the dashboard again.`
  - Guard (`use('*')` after `/login`): `csrf()` from `hono/csrf` (default: same origin), then `readSession(getCookie('sp_session'))`, then `store.listPeople()` and the matching **non-system** person; else `401` message page `Sign in by asking your agent to open the dashboard (open_dashboard tool).`
  - No secret configured → every dashboard route answers the 401 sign-in page (never throws).
- `src/http/app.ts`: `Env` gains `DASHBOARD_SECRET?: string`. `app.route('/dashboard', dashboardRoutes(getStore))` right after `/health`, before the bearer middleware. The `/mcp` handler passes `() => issueLink(store, person, new URL(c.req.url).origin, c.env.DASHBOARD_SECRET)`.
- `src/mcp/server.ts`: `buildMcpServer(store, actor, summary, openDashboard: () => Promise<string>)`. Tool `open_dashboard`, no input, description `Open the SamePage web dashboard: returns a one-time sign-in link for the user (valid 10 minutes). Show the link to the user.`; returns `Open this link to sign in to the SamePage dashboard (works once, valid 10 minutes): <url>`. Goes through `run()`, so the MemoryErrors above become tool errors.
- `tests/dashboard/helpers.ts`: `ENV = { DATABASE_URL: '', DASHBOARD_SECRET: 'test-secret' }`; `signIn(app, store, personId): Promise<string>` (issues a link, GETs it, returns the `sp_session=...` cookie pair); `get(app, path, cookie)` and `post(app, path, cookie, form: Record<string,string>)` (form-encoded, `Origin: http://localhost`), all passing `ENV`.

- [ ] **Step 1: Write the failing tests.**
  - `auth.test.ts`: `a link works once` (redeem → `'miguel'`, again → `null`); `a link expires` (a token you `sign` with `exp` in the past and a nonce you `setDashboardNonce` → `null`); `a new link revokes the previous one`; `a link signed with another secret is refused`; `link and session tokens are not interchangeable` (`readSession(linkToken)` and `redeemLink(sessionToken)` → `null`); `system actors and a missing secret get MemoryError`.
  - `routes.test.ts`: `login sets a 30-day HttpOnly cookie and redirects` (302, `Location: /dashboard`; `set-cookie` contains `sp_session=`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=2592000`, `Path=/dashboard`); `a used link shows the expired page` (401, body contains `expired or was already used`); `without a session, or with a forged one, the dashboard asks you to sign in` (401, body contains `open_dashboard`); `the dashboard does not need a bearer token and /mcp still does`.
  - `app.test.ts`: tool list test expects 13 names including `open_dashboard`; `open_dashboard returns a link that signs you in` (connect with `ENV` passed to `app.request`; text contains `http://t/dashboard/login?t=`; GET that URL → 302); without `DASHBOARD_SECRET` → `isError` with `not configured`.
- [ ] **Step 2:** Run `npx vitest run tests/dashboard tests/http`. Expected: FAIL.
- [ ] **Step 3:** Implement as specified.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: dashboard sign-in via open_dashboard one-time link`.

---

### Task 4: Layout and Home (what's new, search, timeline)

**Files:**
- Modify: `src/dashboard/html.ts`, `src/dashboard/routes.ts`
- Create: `src/dashboard/pages.ts`
- Test: `tests/dashboard/routes.test.ts`

**Interfaces:**
- Consumes: Task 3 guard and helpers; `Store.changesSince`, `search`, `listEntries`, `touchDashboardSeen`.
- Produces, in `html.ts` (everything through `html` from `hono/html`, so interpolations are escaped):
  - `layout(opts: { title: string; active: 'home' | 'proposals' | 'views' | 'team' | null; person: Person; body: unknown }): HtmlEscapedString | Promise<HtmlEscapedString>` — full page, CSS copied from the mockup (light/dark via `prefers-color-scheme`, phone breakpoint), nav links Home / Proposals / Who thinks what / Team, signed-in name at the bottom of the nav.
  - Helpers: `entryHref(e: Entry): string` (`/dashboard/workstreams/:id` for workstreams, else `/dashboard/entries/:id`), `day(d: Date): string` (`YYYY-MM-DD`), `nameOf(people: Person[], id: string): string` (falls back to the id), `pill(text: string, tone: 'ok' | 'acc' | 'warn' | 'mut')`, `message(status: number, text: string)` page.
  - Multi-line content uses a `.pre` class (`white-space: pre-wrap`).
- `pages.ts`: `homePage(d: { person; people; changes: Change[]; q: string; results: Entry[] | null; timeline: Entry[] })`.
- Route `GET /` (Home), visit rule exactly as in Global Constraints: cookie `sp_visit` = cutoff ISO string, `HttpOnly; Path=/dashboard; Max-Age=1800`, re-set on every Home load.
  - What's new: `changesSince(cutoff, me)`; show 50, then `…and N more`. Pills: `new` ok, `changed` acc, `removed` mut. Line: title (linked) · type · area · by name. Removed: `removed: <type> · by <name>`, no title, no link.
  - Search: GET form `q`; when non-empty, `store.search(q, { limit: 20 })` shown as **Search results** above the timeline (`No results.` when empty).
  - Timeline: `listEntries({ type: 'decision', limit: 20 })`, each `day · title (link) · status pill`.

- [ ] **Step 1: Write the failing tests** (`describe('Home')`):
  - `shows what others changed since the last visit, not your own` → joao records "Per-seat pricing", miguel records "Mine"; miguel's Home contains `Per-seat pricing`, not `Mine` in What's new.
  - `a refresh in the same visit keeps what's new; the next visit starts after it` → first Home (keep its `sp_visit` cookie) shows it; second Home with `sp_visit` still shows it; Home without `sp_visit` no longer shows it.
  - `the dashboard and the MCP summary keep separate cursors` → after a Home visit, `lastSeenAt` is still `null` and `/summary` still lists joao's change under `New since your last session`; calling `/summary` leaves `dashboardSeenAt` unchanged.
  - `escapes text written by agents` → title `<script>alert(1)</script>` → body contains `&lt;script&gt;alert(1)&lt;/script&gt;` and not `<script>alert(1)`.
  - `removed entries show no title` → joao deletes his entry → Home shows `removed: decision`, not its title.
  - `search and timeline` → `?q=pricing` shows `Search results` with the entry; timeline lists decisions with their status.
- [ ] **Step 2:** Run `npx vitest run tests/dashboard`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: dashboard layout and Home`.

---

### Task 5: Entry/decision page and Proposals (accept / reject)

**Files:**
- Modify: `src/dashboard/pages.ts`, `src/dashboard/routes.ts`
- Test: `tests/dashboard/routes.test.ts`

**Interfaces:**
- Consumes: `EntryFilter.supersedesId/targetId` (Task 1), `Memory.acceptProposal/rejectProposal`, Task 4 helpers.
- `GET /entries/:id`: id must match `/^[0-9a-f-]{36}$/i` else 404; missing or deleted → 404 `Entry not found.`; a workstream → `302` to its workstream page.
  - **Decision:** area · source · day; title; status pill and consensus pill (`unanimous` ok, `majority` / `no_consensus` warn); **Question**; **Positions** side by side (`nameOf(position.person)` · position, arguments muted); **Verdict** (content); when consensus is `majority` or `no_consensus` and `consensusReason` is set: `Why we went ahead without full consensus: <reason>`; **History**: predecessors by following `supersedesId` with `getEntry` (max 10; deleted → `(deleted)` without title), successors by `listEntries({ supersedesId, limit: 1 })` repeatedly (max 10), and revision proposals `listEntries({ type: 'proposal', targetId: id })` with status pills.
  - **Proposal:** the proposal card below plus `Revises: <target link>`.
  - **Other types:** title, type/status pills, content, authors, day; an update links to its workstream.
- `GET /proposals`: `listEntries({ type: 'proposal', status: 'open', limit: 50 })`, targets loaded sequentially with `getEntry`. Card: title · by names · day; content; `Revises: "<target title>"` (link). If own (`authors.includes(me) || recordedBy === me`, same as `Memory`): `Waiting for another team member — you cannot close your own proposal.` Otherwise two forms: **Accept** (POST `/dashboard/proposals/:id/accept`) and **Reject** with an optional `reason` text input (POST `/dashboard/proposals/:id/reject`). `No open proposals.` when empty.
- POST handlers: bad id → 404; `MemoryError` → `400` message page with the error text and a link back; success → `303` to `/dashboard/proposals`.

- [ ] **Step 1: Write the failing tests:**
  - `decision page shows question, positions by name, verdict and why without consensus` → decision with `positions: [{person:'miguel', position:'per seat', arguments:'<b>predictable</b>'}, {person:'joao', position:'per use'}]`, consensus `majority`, reason `We need a price for the landing page` → body has `Miguel`, `per seat`, `&lt;b&gt;predictable`, `Why we went ahead without full consensus`, the reason.
  - `decision page shows the supersession history both ways` → A superseded by B: A's page links to B; B's page links to A.
  - `unknown, malformed and deleted ids are 404` → `/dashboard/entries/abc`, a random uuid, a deleted entry → 404 each.
  - `proposals: others can accept, the proposer cannot` → joao proposes on a miguel+joao decision; miguel's `/proposals` has `Accept`; joao's has `you cannot close your own proposal`; joao POST accept → 400 containing `You cannot close your own proposal.`; miguel POST accept → 303 and the decision is `superseded`.
  - `reject keeps the decision and stores the reason` → miguel POST reject `reason=Too risky` → decision `active`, proposal `resolutionNote === 'Too risky'`.
  - `cross-site POST is refused` → POST accept with `Origin: https://evil.example` → 403 and the proposal still `open`.
- [ ] **Step 2:** Run `npx vitest run tests/dashboard`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: dashboard decision page and proposals`.

---

### Task 6: Who-thinks-what, Team & activity, workstream page (rename / merge / status)

**Files:**
- Modify: `src/dashboard/pages.ts`, `src/dashboard/routes.ts`, `src/mcp/server.ts`
- Test: `tests/dashboard/routes.test.ts`, `tests/http/app.test.ts`

**Interfaces:**
- Consumes: `Memory.renameWorkstream/mergeWorkstream` (Task 2), `Memory.setWorkstreamStatus`, `EntryFilter.workstreamId` (Task 1).
- Lists below use `limit: 100` with the comment `// shortcut: last 100 only, fine for a small team; paginate if it grows`.
- `GET /views`: `views = listEntries({ type: 'view', limit: 100 })`, `decisions = listEntries({ type: 'decision', limit: 100 })` filtered to `active | under_review`. One section per area that has views (alphabetical): a grid with one column per human person (their views in that area, newest first: title, content, day) or `No view recorded yet.`; under it `Current decisions` for that area (links), if any. `No views recorded yet.` when there are none.
- `GET /team`: `workstreams = listEntries({ type: 'workstream', limit: 100 })`, `updates = listEntries({ type: 'update', limit: 100 })`, `recent = listEntries({ limit: 100 })`. Per human person, a card:
  - **Working on:** the workstream of their latest update whose workstream is not `done`; else their latest non-`done` workstream; else `Nothing in progress.`
  - **Last activity:** first `recent` entry they recorded or authored (title link · day); else `No activity yet.`
  - **Blocked:** their `blocked` workstreams (links), shown only when any.
  - Then **Workstreams**: not-done ones (title link, status pill, day of last update), and done ones inside `<details><summary>Done (N)</summary>`.
- `GET /workstreams/:id` (bad id / not a workstream / deleted → 404): title, status pill, content, `resolutionNote` if set; **Progress** timeline from `listEntries({ type: 'update', workstreamId: id, limit: 100 })` (day · title · by names · content). Three forms:
  - Rename: `title` input prefilled → POST `/dashboard/workstreams/:id/rename`.
  - Status: `<select name="status">` with `in_progress | blocked | done` (current selected) → POST `/status`; any other value → 400.
  - Merge: `<select name="into">` of the other non-done workstreams + `Merge into` button with `onsubmit="return confirm('Move all updates and close this workstream?')"` → POST `/merge`.
  - Success → `303` to the workstream page (merge → the target's page). `MemoryError` → 400 message page.
- **MCP parity** (spec 8 item 1.5, added on `main` in 2d38f3a: the dashboard is optional and everything it does must also be possible through the agent). In `src/mcp/server.ts`, next to `set_workstream_status`:
  - `rename_workstream` (`id`, `title`) → `memory.renameWorkstream`; description `Rename a workstream. Any team member can.`; returns `Renamed workstream <id>`.
  - `merge_workstreams` (`from_id`, `into_id`) → `memory.mergeWorkstream`; description `Merge one workstream into another: moves all its updates and marks it done. Any team member can.`; returns `Merged <from_id> into <into_id>`.
  - The tool-list test in `tests/http/app.test.ts` now expects 15 names.

- [ ] **Step 1: Write the failing tests:**
  - `views side by side per area` → miguel and joao views in `positioning`, only miguel in `pricing`, an active decision in `positioning` → the `positioning` section has both names and the decision; the `pricing` section shows `No view recorded yet.` for joao.
  - `team shows what each person works on, last activity and blockers` → miguel: workstream W1 with an update by miguel; joao: workstream W2 set `blocked` → miguel's card `Working on` W1; joao's card shows W2 under `Blocked`; a done workstream sits under `Done (1)`.
  - `workstream page shows the progress timeline` → two updates appear newest first with author names.
  - `rename, status and merge from the dashboard` → joao renames miguel's W1 (303, new title); sets `done` (status `done`); `status=bogus` → 400; merge W2 into W1 → 303 to W1, W1 shows W2's update, W2 is `done` with `Merged into`; merge W1 into W1 → 400 `cannot be merged into itself`.
  - `bad workstream ids are 404` → `/dashboard/workstreams/abc`, a decision's id.
  - `app.test.ts`: `rename_workstream and merge_workstreams work through MCP` → rename returns `Renamed workstream <id>` and the title changed; merge returns `Merged <a> into <b>` and A's update now belongs to B; merging into itself → `isError` with `cannot be merged into itself`.
- [ ] **Step 2:** Run `npx vitest run tests/dashboard`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: dashboard views, team and workstreams`.

---

### Task 7: Docs, deploy, live verification, PR

**Files:**
- Modify: `integrations/claude-code/README.md` (a "Dashboard" section: ask your agent "open the dashboard"; secret setup command; logout = clear the cookie or rotate the secret), spec untouched.

- [ ] **Step 1:** Rebase on `origin/main` (`git fetch && git rebase origin/main`), resolve conflicts in `server.ts`/`app.ts`, run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 2 (ask the user first):** apply migration `0002` to Neon: PowerShell, from `.env.local` without printing it, `npm run db:migrate`. Expected: two columns added, data untouched.
- [ ] **Step 3 (ask the user first):** generate 32 random bytes hex and pipe it into `npx wrangler secret put DASHBOARD_SECRET` (never echoed or saved), then `npm run deploy`. Expected: `/health` → `ok`.
- [ ] **Step 4:** In Claude Code (after `/mcp` reconnect), call `open_dashboard`; open the link; check each screen shows real data: Home, a decision, Proposals, Who thinks what, Team, a workstream. Second use of the same link shows the expired page.
- [ ] **Step 5:** `npx wrangler tail --format json` while loading each screen; record `cpuTime` per route in the PR. Expected: each ≤ ~10 ms. If a page is over, cut its queries (e.g. drop `recent` on Team) before the PR.
- [ ] **Step 6:** Commit docs, push, open a PR to `main` (do not merge) with the CPU table and the cursor rule.
