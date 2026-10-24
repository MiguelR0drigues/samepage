# SamePage Easy Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teammate joins SamePage from one team-wide link by pasting one message into Claude; the only manual step is approving the Claude login; the client updates itself.

**Architecture:** The Worker gets a `JOIN_CODE` secret, a public `/join/<code>` page and `POST /join`, and tokens move to their own table so one person can have one token per computer. The installer (`integrations/claude-code/setup.mjs`) learns `--join/--name/--same-person/--login`, runs without a TTY, and opens a separate terminal window for `claude setup-token`. The build also emits `public/client.json`, which a detached `update.mjs` applies at most once a day from the session-start hook.

**Tech Stack:** Cloudflare Workers + Hono, Drizzle + Postgres (Neon; PGlite in tests), Vitest, dependency-free Node 22 ESM for the client.

**Spec:** `docs/superpowers/specs/2026-10-24-samepage-easy-setup-design.md`

## Global Constraints

- Free tiers only; the Worker never calls AI models.
- Client stays dependency-free Node ≥ 22 ESM with JSDoc types, like the rest of `integrations/claude-code/`.
- All code, CLI output, page copy and agent-facing text in English.
- No SamePage or Claude token is ever printed by the installer or written into a Claude conversation; errors never include command lines (they can hold tokens).
- The join code may appear in the conversation (it is shared with the team).
- Person id = slug of the name: NFD, accents stripped, lowercase, runs of non-`[a-z0-9]` → `-`, trimmed of `-`. Names match when slugs match. Name 1–80 chars after trim.
- `person:rotate` keeps its meaning: every machine of that person is cut off.
- The worktree has unrelated uncommitted changes (LICENSE, root README.md, `license` fields in both package.json files) from another session: never commit, revert or overwrite them; work in a separate worktree branch.

## Review Focus

- `client.json` with a path that escapes `~/.samepage` (`../x`, `/etc/x`, `C:\x`) → the whole update is refused, nothing written (test in Task 5).
- Update fetch fails or returns 500/invalid JSON → install unchanged, one line in `capture.log` (test in Task 5).
- Name made only of symbols or emoji (`"🙂"`, `"--"`) → `POST /join` 400 `name needs letters or digits`, nobody created (test in Task 2).
- Names that differ only by case/accents (`"joão"` vs `"Joao"`) → same person: 409 (test in Task 2).
- Worker without `JOIN_CODE` set → `GET /join/x` 404 and `POST /join` 403, nobody created (test in Task 2).

---

### Task 1: Several tokens per person

**Files:**
- Modify: `src/storage/postgres/schema.ts`, `src/storage/postgres/store.ts`, `src/storage/store.ts`, `src/domain/types.ts` (Snapshot), `scripts/rotate-token.ts`
- Create: migration via `npm run db:generate` (then hand-edit, see Step 3)
- Test: `tests/storage/postgres-store.test.ts`, `tests/scripts/rotate-token.test.ts`, `tests/http/app.test.ts`

**Interfaces:**
- Produces (Store):
  - `addPerson(p, tokenHash)` unchanged signature (inserts the person and one token).
  - `addToken(personId: string, tokenHash: string): Promise<void>`
  - `replaceTokens(personId: string, tokenHash: string): Promise<Person | null>` — replaces `setTokenHash` (delete all, insert one; null if unknown person).
  - `findPersonByTokenHash(hash)` unchanged signature, now via the tokens table.
  - `findPersonById(id: string): Promise<Person | null>`
- Snapshot `version: 2`: `people` rows lose `tokenHash`; new `tokens: { personId: string; tokenHash: string; createdAt: Date }[]`. `importAll` also accepts version 1 (moves each `people[].tokenHash` into `tokens`).

- [ ] **Step 1: Failing tests**
  - store: `a person can hold two tokens and both authenticate` (addPerson h1, addToken h2 → both `findPersonByTokenHash` return the person).
  - store: `replaceTokens drops every old token` (h1, h2 → replaceTokens h3 → h1/h2 null, h3 person; unknown id → null).
  - store: `export v2 carries tokens and imports back`; `imports a v1 snapshot with people[].tokenHash` (token authenticates after import).
  - rotate-token: existing test updated to `replaceTokens`; second token stops working too.
- [ ] **Step 2: Run** `npx vitest run tests/storage tests/scripts` → FAIL.
- [ ] **Step 3: Implement.** Schema: table `person_tokens` (`person_id` text FK → people.id, `token_hash` text unique not null, `created_at` timestamptz default now), drop `people.token_hash`. Run `npm run db:generate`, then edit the generated SQL so it creates the table, runs `INSERT INTO "person_tokens" ("person_id","token_hash") SELECT "id","token_hash" FROM "people";`, and only then drops the column. Store methods per Interfaces; `addPerson` inserts both rows in one transaction. Rename `setTokenHash` → `replaceTokens` in Store, store and `rotate-token.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat: several tokens per person`

### Task 2: Join link on the Worker

**Files:**
- Create: `src/http/join.ts`, `scripts/join-new.mjs`, `tests/http/join.test.ts`
- Modify: `src/http/app.ts` (Env gets `JOIN_CODE?: string`; mount join routes before the bearer middleware), `package.json` (script `"join:new": "node scripts/join-new.mjs"`)

**Interfaces:**
- Consumes: `addPerson`, `addToken`, `findPersonById` (Task 1); `newToken` from `scripts/add-person.ts` must move to a Worker-safe place: export `newToken()` from `src/http/join.ts` using `crypto.getRandomValues` (32 bytes hex) and have `scripts/add-person.ts` import it.
- Produces:
  - `slugify(name: string): string` (exported from `src/http/join.ts`).
  - `GET /join/:code` → 200 HTML, or 404 when `JOIN_CODE` is unset or differs.
  - `POST /join` JSON `{ code: string, name: string, existing?: boolean }` →
    - 403 `{ error: 'invalid join code' }` (also when `JOIN_CODE` unset)
    - 400 `{ error: 'name needs letters or digits' }` / `{ error: 'name is too long' }`
    - 201 `{ id, name, token, created: true }` new person
    - 409 `{ id, name }` slug taken and `existing` not true
    - 200 `{ id, name, token, created: false }` with `existing: true` (adds a token)
    - slug of a system person: 409 as usual without `existing`; with `existing: true` → 403 `{ error: 'cannot join as this member' }` (never attach to it).
  - `pasteMessage(origin: string, code: string): string` — the message in spec §3, with `--join <code>`; adds: on Windows, if `npx` is not found right after installing Node, use `"C:\Program Files\nodejs\npx.cmd"`.
- [ ] **Step 1: Failing tests** (`tests/http/join.test.ts`, env `{ JOIN_CODE: 'c0de' }` passed to `app.request`):
  - `slugify`: `"Ana Silva"`→`ana-silva`, `"  João  Ñ "`→`joao-n`, `"🙂"`→`""`.
  - GET right code → 200, body contains `pasteMessage('http://t', 'c0de')` and `npx -y http://t/samepage-setup.tgz --join c0de`; wrong code → 404; no `JOIN_CODE` → 404.
  - POST new → 201, token authenticates `/summary`; same slug `"ana SILVA"` → 409; `"Joao"` after `"João"` → 409; `existing: true` → 200, both tokens authenticate.
  - POST wrong code / unset → 403, `listPeople()` unchanged; `"🙂"` → 400; 81 chars → 400; `existing: true` on the system person → 403.
- [ ] **Step 2: Run** `npx vitest run tests/http/join.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/http/join.ts` as a Hono sub-app taking `getStore`. Page: plain HTML (inline CSS, no JS frameworks), heading "Join SamePage", the paste message in a `<pre>` with a copy button (`navigator.clipboard.writeText`), then "Prefer the terminal?" with the npx line, then "Installs: the SamePage connection for Claude Code, capture hooks, files in ~/.samepage. Undo any time: `npx -y <origin>/samepage-setup.tgz --uninstall`." Headers `Cache-Control: no-store`, `X-Robots-Tag: noindex`.
- [ ] **Step 4: Implement** `scripts/join-new.mjs`: generates a 24-byte hex code, pipes it to `npx wrangler secret put JOIN_CODE` (stdin), prints `Team join link (share it with the team; running this again replaces it): <SAMEPAGE_URL or https://samepage.scooli.workers.dev>/join/<code>`. No test (thin wrapper over wrangler).
- [ ] **Step 5: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `feat: team join link and POST /join`

### Task 3: Installer joins without a terminal

**Files:**
- Create: `integrations/claude-code/lib/prompt.mjs` (move `ask`, `askHidden` out of setup.mjs; add `askYesNo(q: string): Promise<boolean>`)
- Modify: `integrations/claude-code/setup.mjs`, `integrations/claude-code/lib/state.mjs`
- Test: `tests/integrations/setup.test.ts`

**Interfaces:**
- Consumes: `POST /join` contract (Task 2).
- Produces:
  - `parseArgs` adds `join: string | null`, `name: string | null`, `samePerson: boolean`, `login: boolean`. A positional token and `--join` together → Fail `Use either a token or --join, not both.`
  - `findClaude(env = process.env, lookup = which, platform = process.platform): string | null` — `CLAUDE_CODE_EXECPATH` first when its basename starts with `claude` (case-insensitive) and the file exists; else today's PATH lookup.
  - `joinTeam(url: string, code: string, name: string, existing: boolean, fetchFn = fetch): Promise<{ token: string, name: string } | { taken: string }>` — Fail with the server's `error` on 400/403, `Could not reach <url>.` on network error.
  - `tokenAccepted(url: string, token: string, fetchFn = fetch): Promise<boolean>` (GET `/summary` → 200).
  - `setClaudeToken(home: string, token: string): void` in state.mjs (rewrites config keeping every other field).
  - `TAKEN = (name) => \`A member named ${name} already exists. If that is you (another computer), run again with --same-person. If not, run again with a different --name, e.g. "${name} (Marketing)".\``
- Install order: Node check → claude binary → folders → token → **write config** → copy files → hooks → MCP → login (Task 4) → final line.
  - Folders: `--folders`, else TTY prompt `Which folders hold company work? Capture runs only there (separate several with ;) [<cwd>]: ` (Enter = cwd), else `process.cwd()`. Existing `parseFolders` guards apply.
  - Token: positional token; else stored config token if `tokenAccepted`; else `--join` (name from `--name`, else TTY prompt `Your name: `, else Fail `--name is required when there is no terminal.`). On `{ taken }`: TTY → `askYesNo("A member named X already exists. Is that you? (y/n) ")`, yes → retry with existing, no → ask a new name and retry; no TTY → Fail `TAKEN(taken)`. Neither token nor join → Fail USAGE.
  - Config is written right after the token is known (with `claudeToken` kept from any previous config), so a retry after a later failure reuses it.
- [ ] **Step 1: Failing tests**: parseArgs new flags and the token+join conflict; `findClaude` prefers an existing `CLAUDE_CODE_EXECPATH`, ignores one that is missing or not `claude*`; `joinTeam` with a fake fetch returns `{token,name}` on 201/200, `{taken}` on 409, throws the server error on 400/403; `setClaudeToken` keeps `url`, `token`, `folders`, `dailyLimit`.
- [ ] **Step 2: Run** `npx vitest run tests/integrations/setup.test.ts tests/integrations/state.test.ts` → FAIL.
- [ ] **Step 3: Implement** per Interfaces; `install()` wiring as listed.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Manual check**: `wrangler dev` with `JOIN_CODE=dev` in `.dev.vars`, `npm run build:setup`, then from a temp folder with `SAMEPAGE_HOME` and `CLAUDE_CONFIG_DIR` pointed at scratch dirs: `node integrations/claude-code/setup.mjs --url http://localhost:8787 --join dev --name "Test Person" --claude-token x < /dev/null` → prints the final line, config has a token, a second run with the same name and no token in config prints `TAKEN`, and with `--same-person` succeeds.
- [ ] **Step 6: Commit** `feat: installer joins with the team code, no terminal needed`

### Task 4: Claude login in its own window, and the capture-off note

**Files:**
- Create: `integrations/claude-code/login.mjs`
- Modify: `integrations/claude-code/setup.mjs`, `integrations/claude-code/lib/handle-hook.mjs`, `integrations/claude-code/lib/state.mjs` (SessionState gets `loginNoticed: boolean`, default false)
- Test: `tests/integrations/hook.test.ts`, `tests/integrations/setup.test.ts`

**Interfaces:**
- Consumes: `setClaudeToken`, `askHidden` (Task 3).
- Produces:
  - `login.mjs`: `node login.mjs` reads config from `samepageHome()`, runs `claude setup-token` (binary from config `claudePath`, else `findClaude()`), then stores the token with `setClaudeToken`; ends with `Done. You can close this window.` and waits for Enter when in a TTY. Exports `extractToken(output: string): string | null` (first `sk-ant-oat\S+` match).
  - `loginWindowCommand(platform: string, nodePath: string, loginPath: string): { cmd: string, args: string[] } | null` (exported from setup.mjs): win32 → `cmd.exe /c start "SamePage login" "<node>" "<login>"`; darwin → `osascript -e 'tell application "Terminal" to do script "<quoted node> <quoted login>"'`; linux → `x-terminal-emulator -e <node> <login>`; anything else → null.
  - `LOGIN_NOTE = (url) => \`SamePage capture is off until you approve the Claude login: run npx -y ${url}/samepage-setup.tgz --login\``
- [ ] **Step 1: Spike (no test):** in a real terminal, run `claude setup-token` with stdin inherited and stdout piped through a tee in a tiny script; if the URL/prompts still show and the token appears in the captured text, `login.mjs` captures it with `extractToken` and skips the paste; otherwise it runs with `stdio: 'inherit'` and then `askHidden('Paste the token it printed (starts with sk-ant-):')`. Record the result in a comment in `login.mjs`.
- [ ] **Step 2: Failing tests** (first add `claudeToken: 'x'` to the shared config fixture in `hook.test.ts`, so existing prompt tests keep testing what they test): `extractToken` finds the token inside noisy output and returns null without one; `loginWindowCommand` for each platform (args contain both paths, win32 title is `"SamePage login"`); hook: in a company folder with no `claudeToken`, the first `prompt` returns `additionalContext` equal to `LOGIN_NOTE('http://x')` and the second returns nothing; with `claudeToken` set, nothing; a pending `notice` wins over the login note.
- [ ] **Step 3: Run** `npx vitest run tests/integrations` → FAIL.
- [ ] **Step 4: Implement.** setup.mjs login step (only when no stored `claudeToken` and no `--claude-token`): TTY → run login inline (same code as `login.mjs`, imported); no TTY → spawn `loginWindowCommand(...)` detached (`stdio: 'ignore'`), print `A window opened to approve your Claude login; capture turns on as soon as you approve.`, or when null/spawn fails print `To turn on capture, run in a terminal: npx -y <url>/samepage-setup.tgz --login`. `--login` alone runs only this step (needs an existing config, else Fail `Run setup first.`). handle-hook: in the `prompt` branch, after the `s.notice` case, `else if (!config.claudeToken && !s.loginNoticed)` inject `LOGIN_NOTE(config.url)` and set `patch.loginNoticed = true`.
- [ ] **Step 5: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `feat: Claude login in its own window; note when capture is off`

### Task 5: Automatic client updates

**Files:**
- Create: `integrations/claude-code/update.mjs`, `tests/integrations/update.test.ts`
- Modify: `scripts/build-setup.mjs`, `integrations/claude-code/hook.mjs`, `integrations/claude-code/setup.mjs` (copy every package file; write `~/.samepage/version`), `integrations/claude-code/package.json` (base version `0.3.0`)

**Interfaces:**
- Produces:
  - Build: stage a copy of `integrations/claude-code` in a temp dir; `hash` = first 8 hex chars of sha256 over the sorted `path\0content` of the package files (`*.mjs`, `lib/**`, `package.json` without its version); set the staged `package.json` version to `<base>-<hash>`; `npm pack` the staged copy → `public/samepage-setup.tgz`; write `public/client.json` `{ version, files: { "<posix relative path>": "<utf8 content>" } }` with the same files (staged `package.json` included).
  - `update.mjs`: exports `UPDATE_EVERY_MS = 86_400_000`, `dueForUpdate(home: string, now: number): boolean` (reads `update-check.json` `{ checkedAt }`), and `applyUpdate({ home, settingsFile, nodePath, fetchFn = fetch, now }): Promise<'updated' | 'current' | 'failed'>`. Run as `node update.mjs`, it writes `update-check.json` first, then calls `applyUpdate`.
  - `applyUpdate`: GET `<config.url>/client.json` → validate (version string; every key relative, posix, no `..` segment, not absolute, no drive letter; every value a string) → same as `~/.samepage/version` → `'current'`; else write all files as `<file>.<pid>.tmp`, then rename each into place, then `mergeHooks` on `settingsFile` (via `readJsonObject`), then write `version` last → `'updated'`. Any error → `log(home, 'update failed: <message>')`, temp files removed → `'failed'`. Never touches `config.json`, `sessions/`, `capture.log`.
  - hook.mjs: on `session-start`, when `readConfig(home)` exists and `dueForUpdate(home, Date.now())`, spawn `update.mjs` detached like the extractor (any folder, not only company folders).
- [ ] **Step 1: Failing tests** (`update.test.ts`, temp home, fake fetch):
  - newer version → files written, `version` updated, hooks present in settings, `config.json` byte-identical → `'updated'`.
  - same version → nothing written → `'current'`.
  - fetch throws / 500 / invalid JSON → files unchanged, one `update failed` line in `capture.log` → `'failed'`.
  - files map with `../x`, `/etc/x`, `C:\\x` or `a/../../x` → `'failed'`, nothing written outside or inside home.
  - `dueForUpdate`: no file → true; `checkedAt` 1 h ago → false; 25 h ago → true.
  - build: `node scripts/build-setup.mjs` writes `public/client.json` whose `version` matches the version inside the tarball's `package.json`, and an unchanged tree gives the same version twice.
- [ ] **Step 2: Run** `npx vitest run tests/integrations/update.test.ts` → FAIL.
- [ ] **Step 3: Implement** per Interfaces; setup.mjs copies every package file into home (as `applyUpdate` would) and writes `version` from its own `package.json`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat: client updates itself once a day`

### Task 6: Docs, deploy and end-to-end

**Files:**
- Modify: `integrations/claude-code/README.md` (Join section → the join link + paste message, terminal alternative, `--same-person`, `--login`; Deploy: new step `npm run join:new`, drop the "bump version" note, mention automatic updates and that deploy ships the client to everyone within 24 h; Lost token / remove someone = `person:rotate`); root `README.md` Quick start only if that file is committed by then (it belongs to another session's work otherwise — leave it and mention it in the report).

- [ ] **Step 1:** Update the README as listed.
- [ ] **Step 2:** `npm test && npm run typecheck` → PASS; commit `docs: join link setup`.
- [ ] **Step 3 (with Miguel, after merge):** apply the migration (`npm run db:migrate` with the direct string), `npm run deploy`, `npm run join:new`. Check `curl.exe https://samepage.scooli.workers.dev/join/<code>` → 200 and `/client.json` → 200.
- [ ] **Step 4 (with Miguel):** re-run his setup once (old token form) so his install gets the updater. Then from a fresh `SAMEPAGE_HOME`, paste the join page's message into the desktop app's Code tab: expect Claude to ask the name and confirm the folder, the install to finish, a login window to open, and after approving it `capture.log` to stay free of auth errors on the next session end. `/mcp` shows `samepage` connected in a new session.
