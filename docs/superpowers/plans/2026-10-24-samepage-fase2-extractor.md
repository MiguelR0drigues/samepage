# SamePage Phase 2 (Automatic Capture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code sessions in the folders a person chose are captured automatically. A local extractor (`claude -p` with Haiku, on the person's own subscription) turns the conversation into a few entries, pending questions and one progress update. Only those extracted items reach the server. Setup stays one command.

**Architecture:** Two halves.
- **Server (the existing Worker).** Pending questions and corrections become two new tables. A `Capture` service applies the extractor's output with one fixed policy: certainty decides record, pending or ignore, and related entries are merged or superseded. It is exposed as `GET /extractor/context` and `POST /extractor/apply`, plus two new MCP tools (`pending`, `answer_pending`) and a "Pending for you" summary section.
- **Client (a small dependency-free Node package, `integrations/claude-code/`).** It installs user-level hooks. The hooks do cheap, deterministic work: folder check, `/private` and `/forget`, and counters. They hand real work to a detached `extract.mjs` process, which reads the transcript locally, calls `claude -p`, and posts only the result. The package is served as a tarball by the Worker, so the one setup command is `npx -y <url>/samepage-setup.tgz <token>`.

**Tech Stack:** Existing (TypeScript, Hono, MCP SDK v2, Drizzle, Zod v4, Vitest + PGlite, Wrangler). Client: plain Node ≥ 22 ESM (`.mjs`), no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-collabdb-design.md`, sections 5.3, 6.3, 6.4, 6.6, 7, and 8 item 2. Conventions follow `docs/superpowers/plans/2026-10-24-collabdb-fase1-nucleo.md`.

## Verified before planning (spec section 11, Claude Code 2.1.310 on this machine)

- Hook stdin always has `session_id`, `transcript_path` and `cwd`:
  - `SessionStart` adds `source`;
  - `UserPromptSubmit` adds `prompt`;
  - `SessionEnd` adds `reason`.
- **`SessionEnd` hooks share a 1.5 s budget.** The extractor must run as a detached process (`spawn(..., { detached: true, stdio: 'ignore' }).unref()`). Tested: the child outlives the hook and the `claude` process.
- **Recursion is real.** A `claude -p` child fires SessionStart, UserPromptSubmit and SessionEnd hooks. `--settings '{"disableAllHooks":true}'` suppresses them (tested; CLI settings take precedence over user settings). The env guard `SAMEPAGE_EXTRACTOR=1` is a second layer.
- **Auth.**
  - Hooks inherit the desktop app's environment (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, …). A `claude -p` child started with that environment fails: "OAuth session expired and could not be refreshed".
  - The child must run with `CLAUDE*`/`ANTHROPIC_*` variables stripped, using the CLI's own stored login. Stripping `ANTHROPIC_API_KEY` also keeps it on the subscription.
  - On this machine `claude auth status` reports `loggedIn: false`; the CLI's `~/.claude/.credentials.json` holds a stub the desktop app writes (no refresh token), and a `claude auth login` by the user did not stick.
  - **Decision (user):** use `claude setup-token`. It is a long-lived token for the person's subscription, made for headless use. The installer has the person run it, stores the token in `~/.samepage/config.json` as `claudeToken` (never printed) and passes it only to the extractor's `claude -p` child as `CLAUDE_CODE_OAUTH_TOKEN`. This is independent of the desktop app's login.
- `UserPromptSubmit` receives an unknown `/private` as `prompt: "/private"` in `-p` mode. `{"decision":"block","reason":…}` stops it before any model call. Still to confirm in the desktop app: Task 8 checks it, with a fallback.
- Exec-form hooks work with spaces in paths: `{"type":"command","command":"<node>","args":["C:\\Users\\Miguel Rodrigues\\…\\hook.mjs","stop"]}`.
- The hook env has `CLAUDE_CODE_EXECPATH`, the absolute path of the running Claude binary. The extractor prefers it, so it works for desktop-only users.
- Transcript lines (`.jsonl`) carry `type`, `isSidechain`, `isMeta`, `cwd`, `gitBranch` and `message.content`:
  - content is a string, or blocks of type `text`, `thinking`, `tool_use` or `tool_result`;
  - in the parent folder `C:\PROJECTS\Scooli`, `gitBranch` is `HEAD`, so the real repo comes from the tool_use paths;
  - project folders exist under both `C--PROJECTS-Scooli` and `c--PROJECTS-Scooli`, so drive-letter case varies.
- **Still unverified (CLI not logged in):** the field that carries `--json-schema` output. Task 5 Step 1 checks it.

## Global Constraints

- Everything in English: code, identifiers, tool names, messages, docs, commits. Entry titles and content are written **in the language of the conversation**: they are the team's data, not product text.
- Free tiers only. The MCP server never calls AI models. `claude -p` runs only on the person's machine, on their subscription.
- **The conversation never leaves the machine.** Only extracted items, the session id and a branch hint like `web-app@feature/x` are sent. `/extractor/context` takes no conversation text.
- Extractor values (constants in `integrations/claude-code/lib/limits.mjs`):

| Constant | Value |
|---|---|
| `MID_SESSION_EVERY` | 40 new text messages |
| `MIN_USER_MESSAGES` | 3 |
| `MIN_CHARS` | 1500 |
| `MAX_EXCERPT_CHARS` | 24000 (newest messages kept) |
| `MAX_MESSAGE_CHARS` | 2000 |
| `DEFAULT_DAILY_LIMIT` | 20 passes per person per local day |
| `SWEEP_IDLE_MS` | 2 h (env `SAMEPAGE_SWEEP_IDLE_MS` overrides, for testing) |
| `SWEEP_MAX_AGE_MS` | 3 days |
| `CLAUDE_TIMEOUT_MS` | 180000 |
| `LOCK_STALE_MS` | 10 min |
| `MAX_ITEMS` | 5 per pass |
| `MAX_PENDING` | 2 per pass |

- `claude -p` flags, exactly: `-p --model haiku --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence --settings {"disableAllHooks":true} --output-format json --json-schema <schema> --system-prompt-file <file>`. The prompt goes on stdin; cwd is `~/.samepage/work`; the env is sanitized, plus `SAMEPAGE_EXTRACTOR=1`.
- **Hooks must never break or slow a session.** Every hook exits 0. It writes stdout only for the `/private` and `/forget` blocks and the pending notice. Real work is detached.
- **Privacy commands, deterministic, checked before anything is processed:**
  - `/private`: the whole session is never processed;
  - `/forget`: everything up to now that was not yet captured is dropped.
- State lives under `~/.samepage/` (override: env `SAMEPAGE_HOME`). Claude settings live under `CLAUDE_CONFIG_DIR ?? ~/.claude`.
- Keep edits to `src/mcp/server.ts` and `src/http/app.ts` small: the Phase 1.5 branch also changes them, and it also adds migration `0002`. Before the PR: rebase on `origin/main`. If `main` already has a `0002`, delete ours and run `npm run db:generate` again.
- Production (Neon migration, `wrangler deploy`): only after the user says yes. Never print `.env.local` or tokens.

## Review Focus

1. **Path matching on Windows.** `c:\PROJECTS\Scooli\web-app` is inside the folder `C:\PROJECTS\Scooli`; `C:\PROJECTS\ScooliOld` is not. Mixed `/` and `\` separators match too. Test in Task 4.
2. **Sessions that never end.** Desktop sessions can stay open for days without SessionEnd. Two passes can also start at once (Stop and SessionEnd). Expected: the SessionStart sweep captures idle sessions, and a per-session lock means only one pass runs. Tests in Task 5.
3. **`claude -p` fails** (not logged in, timeout, non-JSON output, wrong shape). Nothing is sent, state does not advance (the next pass retries), and one line goes to `~/.samepage/capture.log`. Test in Task 5.
4. **Hook input is broken or the environment is missing** (bad stdin, no config, cwd outside company folders, `SAMEPAGE_EXTRACTOR=1`). The hook exits 0 with no output, writes no state and spawns nothing. Test in Task 6.
5. **The model's output is wrong.** Examples: an unknown `related_id` or author, a `workstream_id` of a deleted entry, `supersedes` aimed at a principle, more than 5 items. The server degrades: treat the item as new, drop unknown authors, create the workstream, cap the items. It never returns 500, and nothing is half-applied. Test in Task 2.

---

## File Structure

```
src/domain/types.ts                 + Candidate, Pending, Correction (+ Snapshot fields)
src/storage/store.ts                + 6 Store methods
src/storage/postgres/schema.ts      + pending, corrections tables (+ migration 0002)
src/storage/postgres/store.ts       implementations, export/import
src/service/memory.ts               remove() gains an optional correction reason
src/service/capture.ts              NEW: context, apply, answerPending
src/service/summary.ts              + "Pending for you"
src/http/extractor.ts               NEW: /extractor/context, /extractor/apply
src/http/app.ts                     one line: mount /extractor
src/mcp/server.ts                   + pending, answer_pending; delete_entry reason; 2 instruction lines
integrations/claude-code/package.json   name samepage-setup, bin samepage-setup -> setup.mjs
integrations/claude-code/setup.mjs      installer / uninstaller
integrations/claude-code/hook.mjs       hook entry (stdin -> handleHook -> stdout/spawn)
integrations/claude-code/extract.mjs    detached pass entry
integrations/claude-code/lib/limits.mjs, paths.mjs, folders.mjs, state.mjs, transcript.mjs, claude.mjs, policy.mjs, pass.mjs, handle-hook.mjs, settings.mjs
scripts/build-setup.mjs             npm pack -> public/samepage-setup.tgz
scripts/add-person.ts               setupCommand prints the npx command
wrangler.toml                       [assets] directory = "./public"
tests/service/capture.test.ts, tests/integrations/*.test.ts, tests/integrations/fixtures/fake-claude.mjs
```

---

### Task 1: Pending questions and corrections in the data layer

**Files:**
- Modify: `src/domain/types.ts`, `src/storage/store.ts`, `src/storage/postgres/schema.ts`, `src/storage/postgres/store.ts`; generate `src/storage/postgres/migrations/0002_*.sql` with `npm run db:generate`
- Test: `tests/storage/postgres-store.test.ts`, `tests/storage/schema.test.ts`

**Interfaces:**
- Produces, in `src/domain/types.ts`:

```ts
export type CandidateType = 'decision' | 'principle' | 'view' | 'exploration';
export interface Candidate { type: CandidateType; title: string; content: string; area: string; authors?: string[]; question?: string }
export type PendingAnswer = 'record' | 'personal' | 'skip';
export interface Pending {
  id: string; personId: string; candidate: Candidate; question: string; sourceRef: string | null;
  status: 'open' | 'answered'; answer: PendingAnswer | null; createdAt: Date; answeredAt: Date | null;
}
export type CorrectionVerdict = 'company' | 'personal' | 'not_worth_recording';
export interface Correction { id: string; personId: string; verdict: CorrectionVerdict; candidate: Candidate; createdAt: Date }
// Snapshot gains: pending?: Pending[]; corrections?: Correction[]   (optional so Phase 1 exports still import)
```

- Produces, in the `Store` interface:

```ts
insertPending(p: Pick<Pending, 'personId' | 'candidate' | 'question' | 'sourceRef'>): Promise<Pending>;
getPending(id: string, opts?: { forUpdate?: boolean }): Promise<Pending | null>;
listPending(personId: string, limit?: number): Promise<Pending[]>;   // open only, oldest first, default 20
answerPending(id: string, answer: PendingAnswer, at: Date): Promise<Pending>;
insertCorrection(c: Pick<Correction, 'personId' | 'verdict' | 'candidate'>): Promise<Correction>;
listCorrections(personId: string, limit: number): Promise<Correction[]>; // newest first
```

- Tables:
  - `pending`: `id uuid pk default random`, `person_id text not null → people.id`, `candidate jsonb not null`, `question text not null`, `source_ref text`, `status text not null default 'open'`, `answer text`, `created_at timestamptz not null default now()`, `answered_at timestamptz`.
  - `corrections`: `id uuid pk default random`, `person_id text not null → people.id`, `verdict text not null`, `candidate jsonb not null`, `created_at timestamptz not null default now()`.
- `exportAll` includes both arrays. `importAll` inserts `s.pending ?? []` and `s.corrections ?? []`. The "not empty" check also counts both tables.

- [ ] **Step 1: Write the failing tests.**
  - `schema.test`: the table list also contains `pending` and `corrections`.
  - `postgres-store.test`:
    - `pending: insert, list open oldest first, answer`. After `answerPending(id, 'record', now)` the status is `answered`, the answer is `record`, `answeredAt` is `now`, and `listPending` no longer returns it. `listPending('joao')` does not return miguel's.
    - `corrections: newest first, per person, limited`.
    - `exportAll and importAll round-trip` (existing test) now also holds a pending and a correction.
    - `importAll accepts a snapshot without pending/corrections`.
- [ ] **Step 2:** Run `npx vitest run tests/storage`. Expected: FAIL.
- [ ] **Step 3:** Implement the types, schema, `npm run db:generate` and the store methods.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: pending questions and corrections tables`.

---

### Task 2: `Capture` service (the one capture policy)

**Files:**
- Create: `src/service/capture.ts`
- Modify: `src/service/memory.ts` (`remove` gains `reason`)
- Test: `tests/service/capture.test.ts`, `tests/service/memory.test.ts`

**Interfaces:**
- Consumes: `Memory`, the Task 1 Store methods.
- Produces, in `src/service/capture.ts` (wire format in snake_case, the same as the MCP params):

```ts
export interface ExtractedItem extends Candidate {
  certainty: 'high' | 'medium' | 'low'; relation: 'new' | 'updates' | 'supersedes'; related_id?: string; ask?: string;
}
export interface SessionUpdate { title: string; content: string; area: string; workstream_id?: string; workstream_title?: string }
export interface Extraction { session_ref: string; branch_hint?: string; items: ExtractedItem[]; update?: SessionUpdate | null }
export interface CaptureResult { recorded: string[]; proposals: string[]; pending: string[]; ignored: number; update: string | null; workstream: string | null }
export interface ExtractorContext {
  person: string; people: { id: string; name: string }[];
  entries: { id: string; type: EntryType; status: EntryStatus; area: string; title: string; content: string; authors: string[] }[];
  workstreams: { id: string; status: EntryStatus; title: string; branch: string | null }[];
  corrections: { verdict: CorrectionVerdict; type: CandidateType; title: string }[];
}
export class Capture {
  constructor(store: Store);
  context(actor: Person): Promise<ExtractorContext>;
  apply(actor: Person, x: Extraction): Promise<CaptureResult>;
  answerPending(actor: Person, id: string, answer: PendingAnswer): Promise<{ pending: Pending; entry: Entry | null }>;
}
```

- `Memory.remove(actor, id, reason?: 'personal' | 'not_worth_recording')`. If `reason` is given, the entry's `sourceKind` is `claude_code`, and its type is a `CandidateType`, it also inserts a correction `{ personId: actor.id, verdict: reason, candidate: { type, title, content, area } }` in the same transaction.

**Rules:**
- System actors are rejected (`A system actor cannot perform this action.`). `actor` is the token's person.
- `context`:
  - `entries`: the newest 40 non-deleted entries with a `CandidateType` and status `active` or `under_review`. Take them from `listEntries({ limit: 100 })` and filter in code. `content` is flattened and cut to 200 characters.
  - `workstreams`: up to 20 workstreams not `done`. `branch` is `sourceRef` without the `branch:` prefix, or `null`.
  - `corrections`: the actor's last 10.
  - `people`: humans only.
- `apply` runs inside **one** `store.transaction` with `new Memory(tx)`, so a retry after an error never duplicates. Each item's `MemoryError` is caught (the item counts as `ignored`); any other error propagates.
  - The first `MAX_ITEMS = 5` items are considered; the rest count as ignored. `low` → ignored.
  - `medium` → `insertPending`, at most `MAX_PENDING = 2`; further medium items are ignored.
    - The question is `ask` or `Should "<title>" be recorded as a <type> for the team?`.
    - `sourceRef` is `session_ref`.
  - `high`: authors = unique `[actor.id, ...authors that are valid human ids]`; unknown ids are dropped silently. `sourceKind: 'claude_code'`, `sourceRef: session_ref`.
    - `supersedes`, when `related_id` is an active, non-deleted `decision` and the item's type is `decision`: `memory.supersede`. The result goes to `recorded` or `proposals` according to the outcome.
    - `updates`, when `related_id` is a non-deleted entry of the same type, not a `decision`, with the actor among its authors: `memory.correctText(actor, id, { title, content })`. Its id goes to `recorded`.
    - Anything else, including a bad `related_id`: `memory.record`.
  - `update`, when present:
    - The workstream is the first of:
      1. `workstream_id`, if it is a non-deleted workstream;
      2. a non-deleted workstream whose `sourceRef === 'branch:' + branch_hint`;
      3. a new workstream, recorded with `title: workstream_title ?? branch_hint ?? update.title`, `content: update.title`, `area`, `sourceRef: branch_hint ? 'branch:' + branch_hint : null`, `sourceKind: 'claude_code'`.
    - Then `record` an update with `workstreamId`, `sourceRef: session_ref` and the same `sourceKind`.
- `answerPending`, in a transaction with `getPending(id, { forUpdate: true })`:
  - missing, or another person's → `MemoryError('Pending question not found: <id>')`;
  - already answered → `MemoryError('This question was already answered.')`;
  - `record` → `memory.record` with the candidate (`sourceKind 'claude_code'`, `sourceRef` from the pending row), and correction `company`;
  - `personal` → correction `personal`;
  - `skip` → correction `not_worth_recording`;
  - then `answerPending`.

- [ ] **Step 1: Write the failing tests** (`capture.test.ts`; people `miguel`, `joao`, system `meet`; `x = { session_ref: 'claude_code:s1', ... }`):
  - `high new item is recorded with source claude_code and the session ref`;
  - `low items are ignored and medium items become pending for the actor (max 2)`: 3 medium → 2 pending, ignored 1;
  - `more than 5 items: the rest are ignored`;
  - `supersedes on a team decision creates a proposal`: old decision with authors `[miguel, joao]`, item with only miguel → `proposals` has 1, old is `under_review`;
  - `updates merges into the actor's own view`: content replaced, same id;
  - `updates on someone else's entry or a decision records a new entry instead`;
  - `unknown related_id and unknown authors degrade to a new entry by the actor`: authors `['miguel']`;
  - `update attaches to the workstream matched by branch hint, else creates one`: second apply with the same `branch_hint` reuses the workstream;
  - `update with the id of a deleted workstream creates a new workstream`;
  - `apply is all-or-nothing on unexpected errors`: a store wrapper whose `insertEntry` throws `Error` on its second call → `apply` rejects and `listEntries` is empty;
  - `answerPending record records the candidate and stores a company correction`;
  - `answerPending personal stores a correction and records nothing`;
  - `answerPending rejects other people's and already answered questions`;
  - `context lists entries, open workstreams, own corrections and people without system`;
  - `system actor cannot apply`.
  - In `memory.test`: `removing an auto-captured entry with a reason stores a correction`, and `a reason on an explicit entry stores nothing`.
- [ ] **Step 2:** Run `npx vitest run tests/service`. Expected: FAIL.
- [ ] **Step 3:** Implement `Capture` and the `remove` reason.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: capture policy service`.

---

### Task 3: HTTP routes, MCP tools and the "Pending for you" summary

**Files:**
- Create: `src/http/extractor.ts`
- Modify: `src/http/app.ts` (import plus one `app.route` line after the auth middleware), `src/mcp/server.ts`, `src/service/summary.ts`
- Test: `tests/http/app.test.ts`, `tests/service/summary.test.ts`

**Interfaces:**
- Consumes: `Capture` (Task 2).
- `extractorRoutes()`:
  - a `Hono<{ Variables: { person: Person; store: Store } }>` mounted at `/extractor`;
  - `GET /context` → `capture.context(person)` as JSON;
  - `POST /apply` → Zod-validates `Extraction`, then `capture.apply` returns `CaptureResult` as JSON. The Zod schema caps `items` at 20 and strings at 4000 characters. Invalid body → `400 {"error": <first issue message>}`. `MemoryError` → `400 {"error": message}`.
- MCP:
  - `pending`: no input. Description: `List SamePage's open questions for you: things it captured automatically but was unsure about.` It lists `[<id>] <question>` and, on the next line, `  <type>: <title> — <content up to 200>`, or `No pending questions.`
  - `answer_pending`: `id`, `answer: z.enum(['record','personal','skip']).describe('record = about the company, save it; personal = personal, never save; skip = about the company but not worth saving')`. Description: `Answer one of SamePage's pending questions.` Returns `Recorded <entry id>` or `Noted: not recorded.`
  - `delete_entry` gains `reason: z.enum(['personal','not_worth_recording']).optional().describe('Only for entries SamePage captured automatically (source: claude_code): why it was wrong; this teaches the capture')`.
  - The tool-list test expects 14 tools.
- Exact lines appended to `INSTRUCTIONS`:

```
- SamePage also captures automatically from these conversations (source: claude_code). If the user says such an entry was personal or not worth recording, delete it with delete_entry and that reason. The user can type /private to skip the whole conversation, or /forget to drop what was said since the last capture.
- If the summary lists "Pending for you", ask those questions briefly at a natural moment (not in the middle of a task) and pass each answer to answer_pending.
```

- Summary: a section `Pending for you`, added **last** in the `sections` array, so it is trimmed last. Lines: `- [<id>] <question>` from `listPending(person.id, 3)`.

- [ ] **Step 1: Write the failing tests:**
  - `/extractor/context requires a token and returns people and entries`;
  - `/extractor/apply records a high item and returns ids`;
  - `/extractor/apply rejects a malformed body with 400`;
  - MCP: `lists the 14 tools`; `pending then answer_pending records the candidate` (seed a pending with `store.insertPending`);
  - `delete_entry with reason stores a correction`;
  - summary: `shows pending questions for the person only`.
- [ ] **Step 2:** Run `npx vitest run tests/http tests/service/summary.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: extractor endpoints, pending tools and summary section`.

---

### Task 4: Client library — folders, state and transcript reading

**Files:**
- Create: `integrations/claude-code/lib/limits.mjs`, `lib/paths.mjs`, `lib/folders.mjs`, `lib/state.mjs`, `lib/transcript.mjs`; `integrations/claude-code/package.json` (`{"name":"samepage-setup","version":"0.2.0","type":"module","bin":{"samepage-setup":"setup.mjs"},"files":["*.mjs","lib"],"engines":{"node":">=22"}}`)
- Delete: nothing (`README.md` is rewritten in Task 7)
- Test: `tests/integrations/folders.test.ts`, `tests/integrations/state.test.ts`, `tests/integrations/transcript.test.ts`

**Interfaces** (plain JS, with JSDoc types on exports):
- `limits.mjs`: the constants from Global Constraints, as named exports.
- `paths.mjs`: `samepageHome(env = process.env): string`, `claudeDir(env = process.env): string`.
- `folders.mjs`: `isCompanyFolder(cwd: string, folders: string[], platform = process.platform): boolean`.
  - It uses `path.win32` on `win32` and `path.posix` otherwise, with `resolve` + `normalize`.
  - Comparison is case-insensitive on `win32` and `darwin`.
  - True when the path equals a folder or starts with `folder + sep`.
- `state.mjs` (all paths under `home`):
  - `readConfig(home): Config | null`, with `Config = { url, token, folders: string[], dailyLimit: number, claudePath: string | null, claudeToken: string | null }`;
  - `loadSession(home, id): SessionState`, with `SessionState = { transcriptPath: string|null, cwd: string|null, lastActivity: number, processedLine: number, processedAt: number, skipUntilLine: number, private: boolean, notes: string[], notice: string|null }`; defaults to zeros, null, false and `[]`;
  - `saveSession(home, id, s)`, which writes to `sessions/<id>.json` atomically (write a temp file, then rename);
  - `listSessions(home): string[]`;
  - `takeLock(home, id, now = Date.now()): (() => void) | null`. It creates `locks/<id>` with `flag: 'wx'`. A lock older than `LOCK_STALE_MS` is replaced. It returns a release function, or `null` if the lock is held;
  - `usageToday(home, now): number` and `addUsage(home, now)`, keyed on local `YYYY-MM-DD` in `usage.json`;
  - `log(home, line)`, which appends `<ISO time> <line>\n` to `capture.log`. **Never conversation text.**
- `transcript.mjs`:
  - `readTranscript(file: string, fromLine: number): { messages: { role: 'user' | 'agent'; text: string }[]; endLine: number; userCount: number; chars: number; paths: string[]; gitBranch: string | null; cwd: string | null }`
    - it reads only lines `>= fromLine`;
    - a last line that fails to parse is a partial write: it is not counted, and `endLine` stops before it;
    - kept, as `user`: lines of `type 'user'` that are not `isMeta` or `isSidechain`, with string content or `text` blocks (`tool_result` is never kept);
    - kept, as `agent`: lines of `type 'assistant'` that are not `isSidechain`, their `text` blocks only (not `thinking` or `tool_use`);
    - `<system-reminder>…</system-reminder>` is stripped. Texts that then start with `<command-` or `<local-command` are dropped, as are empty texts and the exact prompts `/private` and `/forget`;
    - `paths` collects `file_path`, `path` and `notebook_path` from `tool_use` inputs.
  - `branchHint(cwd: string | null, paths: string[], gitBranch: string | null): string | null`
    - It takes the most frequent first segment of `paths` relative to `cwd`. If `<cwd>/<segment>/.git` exists, the result is `<segment>@<branch>`, where the branch comes from `git -C <dir> rev-parse --abbrev-ref HEAD` (`execFileSync`, 2 s timeout, errors caught).
    - Otherwise, if `gitBranch` is set and is not `HEAD`: `<basename(cwd)>@<gitBranch>`. Otherwise `basename(cwd)` or `null`.
  - `buildExcerpt(messages, maxChars = MAX_EXCERPT_CHARS, maxMessage = MAX_MESSAGE_CHARS): string`: one `[user] …` or `[agent] …` line per message, each cut to `maxMessage`, keeping the newest messages that fit in `maxChars`.

- [ ] **Step 1: Write the failing tests:**
  - folders (both platforms passed explicitly):
    - `c:\PROJECTS\Scooli\web-app` in `C:\PROJECTS\Scooli` → true;
    - `C:/PROJECTS/Scooli` in `C:\PROJECTS\Scooli` → true;
    - `C:\PROJECTS\ScooliOld` → false;
    - darwin `/Users/a/scooli/x` in `/Users/a/Scooli` → true;
    - linux, the same → false;
    - empty folders → false;
  - state:
    - save/load round trip, with defaults for an unknown id;
    - `takeLock` returns null while held, works again after release, and replaces a stale lock (pass `now` + 11 min);
    - usage resets on a new day.
  - transcript (fixture written in the test, with a `user` string, a `user` tool_result, `assistant` thinking+text+tool_use with `file_path`, an `isMeta` user, a sidechain, a `<command-name>` user, a `<system-reminder>` inside a user text, `/private`, and a truncated last line):
    - `messages` are only the real texts, in order;
    - `endLine` excludes the truncated line;
    - `fromLine` skips earlier lines;
    - `paths` has the file;
  - `buildExcerpt` keeps the newest messages within `maxChars`;
  - `branchHint`: a temp dir with `web-app/.git` (made with `git init` in the test) and paths under it → `web-app@<branch>`; with no repo and `gitBranch 'HEAD'` → the basename.
- [ ] **Step 2:** Run `npx vitest run tests/integrations`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/integrations`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: capture client — folders, state, transcript`.

---

### Task 5: Extraction pass — `claude -p`, policy prompt, sweep

**Files:**
- Create: `integrations/claude-code/lib/claude.mjs`, `lib/policy.mjs`, `lib/pass.mjs`, `integrations/claude-code/extract.mjs`, `tests/integrations/fixtures/fake-claude.mjs`
- Test: `tests/integrations/claude.test.ts`, `tests/integrations/pass.test.ts`

**Interfaces:**
- `claude.mjs`:
  - `sanitizeEnv(env): Record<string,string>`: removes keys matching `/^(CLAUDE|ANTHROPIC_)/` except `CLAUDE_CONFIG_DIR`, then adds `SAMEPAGE_EXTRACTOR=1`, and `CLAUDE_CODE_OAUTH_TOKEN=<config.claudeToken>` when the token is set: `sanitizeEnv(env, claudeToken?)`.
  - `claudeCommand(env, config): string[]`: `[env.CLAUDE_CODE_EXECPATH]` when it exists and its basename starts with `claude`; else `[config.claudePath ?? 'claude']`.
  - `runClaude({ command, prompt, systemPromptFile, schema, cwd, env, timeoutMs = CLAUDE_TIMEOUT_MS }): Promise<unknown>`:
    - spawns `command[0]` with `[...command.slice(1), ...the exact flags in Global Constraints]`, `windowsHide`, and `shell` only when the binary ends in `.cmd`;
    - writes `prompt` to stdin;
    - after `timeoutMs` it kills the child and rejects;
    - it parses stdout as JSON. `is_error` → reject with `result`. Otherwise it returns the schema output field (name confirmed in Step 1), falling back to `JSON.parse(result)`.
- `policy.mjs`:
  - `SYSTEM_PROMPT` (exact text below) and `OUTPUT_SCHEMA`;
  - `buildPrompt({ context, excerpt, branchHint, notes, wantUpdate }): string`.

```
You extract team memory for SamePage from an excerpt of one person's conversation with their coding agent. Reply with JSON matching the schema, nothing else.

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
- ask (medium only): one short question to the person, for example: Was "X" a team decision worth sharing?
Titles and content: short, self-contained, in the language of the conversation. Content: at most 3 sentences.
Corrections are this person's past answers about what to record: follow them.

progress: one line on what the person worked on in this excerpt, for later passes of this session.
update (only when the prompt says a session update is needed, otherwise null): what was done and the next step, 1-3 plain, friendly sentences for teammates. No hours, no counts, no judgement of productivity. Use workstream_id of an existing workstream that matches; otherwise give workstream_title, a short name for this piece of work. null if the session was not company work.
```

  - `OUTPUT_SCHEMA`:
    - an object with required `items`, `progress` and `update`;
    - `items`: an array (`maxItems 5`) of objects with required `type` (enum of `CandidateType`), `title`, `content`, `area`, `certainty` and `relation`, plus optional `related_id`, `authors` (string[]), `question` and `ask`;
    - `progress`: a string;
    - `update`: `anyOf [null, { title, content, area required; workstream_id?, workstream_title? }]`.
  - `buildPrompt` writes these sections, in this order, each omitted when empty:
    - `# You extract for: <person>`;
    - `# Team` (`id: name`);
    - `# Existing entries` (`id | type | status | area | title — content`);
    - `# Workstreams` (`id | status | title | branch`);
    - `# Corrections from this person` (`verdict: type — title`);
    - `# Branch hint: <hint>`;
    - `# Session update: needed` or `# Session update: not needed`;
    - `# Progress earlier in this session` (notes);
    - `# Excerpt`, followed by the excerpt.
- `pass.mjs`: `runPass(id: string, mode: 'mid' | 'final', deps): Promise<'skipped' | 'done' | 'failed'>`, with `deps = { home, config, env, fetch, runClaude, now }`. The order is fixed:
  1. `takeLock`. If it is held → `skipped`. The lock is always released.
  2. `loadSession`. If `private` → `skipped`.
  3. `readTranscript(transcriptPath, max(processedLine, skipUntilLine))`. If there are no messages → `skipped`.
  4. In `mid` mode with fewer than `MID_SESSION_EVERY` messages → `skipped`.
  5. Too small (`userCount < MIN_USER_MESSAGES` or `chars < MIN_CHARS`): in `final` mode with no `notes`, set `processedLine = endLine` and `processedAt = now`, then → `done` with no model call. Otherwise → `skipped`.
  6. `usageToday >= config.dailyLimit` → log `daily limit reached` → `skipped`. Otherwise `addUsage`.
  7. `GET <url>/extractor/context` with the bearer token. Any failure → log → `failed`, with state unchanged.
  8. `runClaude` with `buildPrompt({..., wantUpdate: mode === 'final'})` and `SYSTEM_PROMPT` written to `<home>/work/policy.md`. Failure or a missing `items` array → log → `failed`.
  9. `POST <url>/extractor/apply`, with `{ session_ref: 'claude_code:' + id, branch_hint, items, update: mode === 'final' ? out.update : null }`. A non-2xx response → `failed`.
  10. Save `processedLine = endLine`, `processedAt = now`, and `notes` with `out.progress` appended (last 10 kept). In `mid` mode with pending ids, also save `notice = 'SamePage has a question for you (answer with answer_pending): [<id>] <question>'`; the questions come from `out.items` with medium certainty, in order. Log `<id8> <mode>: recorded N, proposals N, pending N, update yes|no` and return `done`.
- `extract.mjs`:
  - CLI `node extract.mjs <session_id> <mid|final>`, or `node extract.mjs --sweep <current_session_id>`;
  - the sweep runs `final` for each session other than the current one where `lastActivity > processedAt`, `now - lastActivity >= SWEEP_IDLE_MS` and `now - lastActivity <= SWEEP_MAX_AGE_MS`, one at a time;
  - it exits silently if `SAMEPAGE_EXTRACTOR` is set or the config is missing;
  - all errors are caught and logged.
- `fake-claude.mjs` (test fixture): reads stdin and prints the contents of the file named by env `FAKE_CLAUDE_OUT`. With `FAKE_CLAUDE_EXIT=1` it exits 1. It appends its argv and env `SAMEPAGE_EXTRACTOR` to `FAKE_CLAUDE_LOG`.

- [ ] **Step 1: Verify `claude -p` structured output (needs the token from the user's `claude setup-token`, read from a file without printing it).** In the scratchpad, run:

```
echo "We decided with Joao to price per seat." | node -e "<spawn claude with sanitizeEnv and the exact flags; print stdout>"
```

  Use a minimal schema `{"type":"object","properties":{"ok":{"type":"string"}},"required":["ok"]}`. Expected: JSON with `is_error: false` and the schema output in a named field (expected `structured_output`); record the field name in `claude.mjs`. If authentication fails with the sanitized env plus `CLAUDE_CODE_OAUTH_TOKEN`, stop and report.
- [ ] **Step 2: Write the failing tests:**
  - `sanitizeEnv strips CLAUDECODE, CLAUDE_CODE_*, ANTHROPIC_API_KEY, keeps PATH and CLAUDE_CONFIG_DIR, adds SAMEPAGE_EXTRACTOR and CLAUDE_CODE_OAUTH_TOKEN when given`;
  - `runClaude passes the exact flags and returns the structured output` (fake-claude via `command: [process.execPath, fixture]`; the log shows `--settings {"disableAllHooks":true}`, `--model haiku`, and `SAMEPAGE_EXTRACTOR=1`);
  - `runClaude rejects on is_error, non-JSON and timeout` (a fixture mode that sleeps forever; `timeoutMs: 500`);
  - pass, with a fake `fetch` that records calls and a temp `home`:
    - `mid pass below 40 messages does nothing`;
    - `final pass sends only items and update, never excerpt text` (assert the apply body has no excerpt string from the fixture transcript);
    - `state advances only after a successful apply`;
    - `private session is never processed`;
    - `skipUntilLine drops earlier messages`;
    - `daily limit stops the pass`;
    - `held lock skips`;
    - `tiny final session is marked done without calling claude`;
    - `context or claude failure logs and leaves state unchanged`;
    - `mid pass with medium items stores a notice`;
  - sweep: `sweep runs final only for idle, unprocessed, recent sessions and never the current one`.
- [ ] **Step 3:** Run `npx vitest run tests/integrations`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `npx vitest run tests/integrations`. Expected: PASS.
- [ ] **Step 6:** Commit `feat: local extraction pass with claude -p`.

---

### Task 6: Hooks — events, privacy commands, recursion guard

**Files:**
- Create: `integrations/claude-code/lib/handle-hook.mjs`, `integrations/claude-code/hook.mjs`
- Test: `tests/integrations/hook.test.ts`

**Interfaces:**
- `handleHook(event: 'session-start' | 'prompt' | 'stop' | 'session-end', input: object, deps: { home, env, now }): { stdout?: string; spawn?: string[] }` performs these checks, in this order:
  1. `env.SAMEPAGE_EXTRACTOR` is set, or there is no config, or `input.session_id`/`input.cwd` is missing, or `!isCompanyFolder(input.cwd, config.folders)` → `{}` (no state written).
  2. Touch the session state: `transcriptPath`, `cwd`, `lastActivity = now`.
  3. Then, by event:
     - `prompt`, with `prompt.trim()` exactly:
       - `/private` → set `private: true` and return `stdout = {"decision":"block","reason":"SamePage: this conversation will not be captured."}`;
       - `/forget` → set `skipUntilLine` = the current line count of the transcript (0 if missing) and return `stdout = {"decision":"block","reason":"SamePage: everything so far that was not captured yet will be skipped."}`;
       - otherwise, if `notice` is set → return `stdout = {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":<notice>}}` and clear the notice.
     - `stop` → if the session is not private and `readTranscript(...).messages.length >= MID_SESSION_EVERY` (from `max(processedLine, skipUntilLine)`), return `spawn = [<extract.mjs>, id, 'mid']`.
     - `session-end` → `spawn = [<extract.mjs>, id, 'final']` (unless private).
     - `session-start` → `spawn = [<extract.mjs>, '--sweep', id]`.
- `hook.mjs <event>` reads stdin (5 s cap) and parses JSON; any failure → exit 0. It calls `handleHook` and writes `stdout`. For `spawn`, it runs `spawn(process.execPath, spawn, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref()`. Everything is in a try/catch that exits 0.

- [ ] **Step 1: Write the failing tests:**
  - `outside company folders: no output, no state, no spawn`;
  - `SAMEPAGE_EXTRACTOR set: nothing happens`;
  - `no config: nothing happens`;
  - `/private blocks and marks the session private, and later session-end spawns nothing`;
  - `/forget blocks and sets skipUntilLine to the transcript length`;
  - `a notice is injected once as additionalContext`;
  - `stop spawns a mid pass only at 40 new messages`;
  - `session-end spawns a final pass`; `session-start spawns a sweep with the current id`;
  - `hook.mjs exits 0 with no output on malformed stdin` (spawn the real file with `SAMEPAGE_HOME` set to a temp dir).
- [ ] **Step 2:** Run `npx vitest run tests/integrations/hook.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: capture hooks with privacy commands`.

---

### Task 7: One-command installer, distribution and docs

**Files:**
- Create: `integrations/claude-code/lib/settings.mjs`, `integrations/claude-code/setup.mjs`, `scripts/build-setup.mjs`
- Modify: `scripts/add-person.ts` (`setupCommand`), `scripts/rotate-token.ts` if it prints the command, `package.json` (scripts `build:setup`, `deploy` = `npm run build:setup && wrangler deploy`), `wrangler.toml` (`[assets] directory = "./public"`), `.gitignore` (`public/`), `integrations/claude-code/README.md`
- Test: `tests/integrations/settings.test.ts`, `tests/scripts/add-person.test.ts`

**Interfaces:**
- `settings.mjs`:
  - `mergeHooks(settings: object, nodePath: string, hookPath: string): object`
    - It first removes any previous SamePage handler, identified by `args[0]` ending in `hook.mjs` inside a `.samepage` directory, on either separator.
    - It then appends one matcher group per event: `SessionStart` → `session-start`, `UserPromptSubmit` → `prompt`, `Stop` → `stop`, `SessionEnd` → `session-end`.
    - Each handler is `{ "type": "command", "command": nodePath, "args": [hookPath, <event>], "timeout": 10 }`. `Stop` and `SessionStart` also get `"async": true`.
    - Other hooks and keys are untouched.
  - `removeHooks(settings): object`: removes the same handlers and drops events left empty.
- `setup.mjs` — `samepage-setup <token> [--url <url>] [--folders "<a>;<b>"] [--uninstall]`. The default URL is `https://samepage.scooli.workers.dev`. Steps, in order; any failure prints one clear line and exits 1:
  1. The Node version must be ≥ 22.
  2. Find `claude` with `where` (win32) or `command -v`. If missing: `Install Claude Code first: https://code.claude.com/docs`.
  3. `GET <url>/summary` with the token must return 200. Otherwise: `This token was rejected by <url>.`
  4. Folders come from `--folders`, or an interactive question: `Which folders hold company work? Capture runs only there (separate several with ;) [<cwd>]:`. Each must exist; store them resolved.
  5. Copy `hook.mjs`, `extract.mjs` and `lib/` to `<home>`. Write `<home>/config.json` `{ url, token, folders, dailyLimit: 20, claudePath, claudeToken }`, with mode `0o600` off Windows.
  6. Read `<claudeDir>/settings.json` (missing → `{}`; invalid JSON → abort without writing). On the first install, back it up to `settings.json.samepage-backup`. Write `mergeHooks(settings, process.execPath, <home>/hook.mjs)`.
  7. Run `claude mcp remove samepage -s user` (failure ignored), then `claude mcp add --scope user --transport http samepage <url>/mcp --header "Authorization: Bearer <token>"`. Use `execFileSync` with an args array and no shell (a `.cmd` binary needs `shell: true`).
  8. Unless `config.json` already has a `claudeToken`, print `Capture uses your own Claude subscription. Claude will now create a long-lived token for it (setup-token):` and run `claude setup-token` with `stdio: 'inherit'`. Then ask, with the input hidden: `Paste the token it printed (starts with sk-ant-):`. Store it as `claudeToken` (this step runs before writing `config.json`, so the order is 1-4, 8, 5-7, 9). An empty answer means: warn `Capture stays off until you run setup again.` and store `null`. `--claude-token <t>` skips the prompt, for re-runs and tests.
  9. Print: `SamePage is set up. Capture runs in: <folders>. Type /private in a session to skip it, /forget to drop what was not captured yet. Undo: npx -y <url>/samepage-setup.tgz --uninstall`.
  - `--uninstall`: `removeHooks`, then `claude mcp remove samepage -s user`, then delete `<home>`.
- `scripts/build-setup.mjs`: runs `npm pack ./integrations/claude-code --pack-destination public` and renames the result to `public/samepage-setup.tgz`.
- `setupCommand(token, url)`: returns `npx -y ${url}/samepage-setup.tgz ${token}`.
- README:
  - replace "Join" with the single command and what it does (MCP, hooks, folders, login);
  - add a "What gets captured" section: the high bar, the pending questions, `/private` and `/forget`, deleting with a reason, "the conversation never leaves your machine; only extracted entries are sent";
  - add the `~/.samepage/capture.log` location and how to change `folders` or `dailyLimit` in `config.json`;
  - keep the Hosting and Deploy sections, with `npm run deploy` now building the tarball.

- [ ] **Step 1: Write the failing tests:**
  - `mergeHooks adds the four events and keeps unrelated hooks`;
  - `mergeHooks twice does not duplicate`;
  - `mergeHooks replaces an old SamePage hook with a different path`;
  - `removeHooks leaves unrelated hooks and drops empty events`;
  - `add-person.test`: `setupCommand` is `npx -y https://x/samepage-setup.tgz <token>`.
- [ ] **Step 2:** Run `npx vitest run tests/integrations/settings.test.ts tests/scripts`. Expected: FAIL.
- [ ] **Step 3:** Implement `settings.mjs`, `setup.mjs`, the build script, `setupCommand`, the config changes and the README.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Local tarball check.**
  - Run `npm run build:setup`, then serve `public/` with `npx -y http-server public -p 8787`.
  - Run `npx -y http://localhost:8787/samepage-setup.tgz --help`. Expected: the usage line prints.
  - If npx refuses a tarball URL as the command, switch `setupCommand` to `npx -y --package=<url>/samepage-setup.tgz samepage-setup <token>`, re-check, and update the test.
- [ ] **Step 6:** Commit `feat: one-command installer for capture`.

---

### Task 8: Deploy, real end-to-end check on this machine, PR

**Files:**
- Modify: `integrations/claude-code/README.md` (anything found during the check)

- [ ] **Step 1:** Run `git fetch && git rebase origin/main`. If `main` gained a migration `0002`, delete ours and run `npm run db:generate` again. Resolve conflicts in `server.ts` and `app.ts`. Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 2 (ask the user first):** apply the new migration to Neon. In PowerShell, load `DATABASE_URL` (the direct string) from `.env.local` without printing it, then run `npm run db:migrate`. Expected: tables `pending` and `corrections` created, other data untouched.
- [ ] **Step 3 (ask the user first):** run `npm run deploy`. Expected:
  - `curl.exe https://samepage.scooli.workers.dev/health` → `ok`;
  - `curl.exe -I https://samepage.scooli.workers.dev/samepage-setup.tgz` → 200;
  - `/extractor/context` without a token → 401.
- [ ] **Step 4:** Run the user's own setup command for real: `npx -y https://samepage.scooli.workers.dev/samepage-setup.tgz <their token>`. The user pastes it, so the token never goes through this session. Use `--folders "C:\PROJECTS\Scooli"`. Expected:
  - `~/.claude/settings.json` has the four hooks;
  - `claude mcp list` shows `samepage`;
  - `config.json` has a `claudeToken`, and the extractor's first pass authenticates with it.
- [ ] **Step 5:** The user opens a new desktop session in `C:\PROJECTS\Scooli` and holds a short real conversation with a clear company decision (≥ 3 messages, ≥ 1500 characters). They then end the session (archive or close it).
  - Expected within ~1 minute: `~/.samepage/capture.log` shows `final: recorded ≥1 … update yes`.
  - `search_context` finds the entry with `source: claude_code`.
  - `list_workstreams` shows the workstream with the update.
  - **If SessionEnd does not fire in the desktop app**, opening any new session triggers the sweep once the old one is idle. For the check, temporarily set `SWEEP_IDLE_MS` to 1 minute through an env override, or wait the 2 hours. Record which path worked in the README.
- [ ] **Step 6:** In a session in `C:\PROJECTS\Scooli`, type `/private`. Expected: the block message appears and no model reply is billed; after the session, the log shows no pass for it. **If the desktop app swallows unknown slash commands**, add user-level command files `~/.claude/commands/private.md` and `forget.md` (installed by `setup.mjs`, body `Reply only: OK.`). Then make `handleHook` also match the expanded prompt, and the transcript reader treat `<command-name>/private</command-name>` the same way. Add tests, then re-check.
- [ ] **Step 7:** A session outside the folders (e.g. `C:\PROJECTS\personal-portfolio`) leaves no state file under `~/.samepage/sessions/`.
- [ ] **Step 8:** Clean up the check: delete the test entries with `delete_entry` (reason `not_worth_recording` only if they really were). Remove the experiment transcripts this work created in `~/.claude/projects` (the scratchpad `exp` folder).
- [ ] **Step 9:** Commit any README fixes. Push the branch and open a PR to `main` (do not merge). The body covers what was verified, the user-visible behaviour, the production steps already done, and the known limits (Haiku quality, sweep delay for desktop sessions).
