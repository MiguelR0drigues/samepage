# SamePage: easy setup — design

## Why

SamePage is new; so far only Miguel has installed it. For the team to adopt it, setup must never be the objection. Today joining takes six steps, three of them painful:

1. The admin runs `person:add` with the database URL and sends a token privately; the newcomer waits.
2. The newcomer needs Node 22+ and the `claude` CLI on PATH (desktop-app-only people may have neither).
3. They paste an `npx` command into a terminal.
4. They type company folder paths, `;`-separated.
5. `claude setup-token`: browser login, then paste a long hidden token.
6. Open a new session.

And every client change means re-running `npx` with a token they may no longer have.

The team is mixed: some live in the Claude Code terminal, some only use the Claude desktop app and rarely open a terminal. Both must find it easy.

## Goals

- **One link for the whole team.** The admin shares a single join link (e.g. in the team chat). No per-person tokens to create or send.
- **Setup by pasting one message into Claude** (desktop app Code tab or terminal). Claude runs the installer, installs Node if missing, asks the person's name and confirms the company folder. A terminal one-liner remains for people who prefer it.
- **The only manual step is approving the Claude login once** (needed for capture, see Constraints). No copying or pasting tokens through the chat.
- **Updates arrive by themselves.** Nobody re-runs setup after a client change.

## Non-goals

- Per-person approval of joiners (explicitly traded away: anyone with the link can join as a new person).
- A dashboard UI for managing members.
- Supporting tools other than Claude Code.
- Reusing the desktop app's login for capture (checked: it is not usable, see Constraints).

## Anti-goals

- A setup that technically works but asks the newcomer anything they need to look up (paths, tokens, commands).
- Tokens (SamePage or Claude) ending up in a Claude conversation transcript.
- An update mechanism that can break a working install or a user's `settings.json`.

## Constraints

- Free tiers only (Cloudflare Workers + Neon); the Worker never calls AI models.
- Capture runs `claude -p` locally on the person's own subscription. Checked on 2026-10-24 on Windows with the desktop app: with the `CLAUDE*`/`ANTHROPIC_*` env stripped, both the desktop's bundled `claude.exe` and the CLI report `loggedIn: false` and `-p` fails with "OAuth session expired". The desktop app refreshes its own login and does not expose it. So a long-lived token from `claude setup-token` stays necessary. Also checked: `claude setup-token` with piped stdio prints nothing (it needs a real terminal).
- Hooks run Node; Node 22+ remains a requirement.
- Privacy rules from the extractor phase stay as they are (the conversation never leaves the machine, `/private`, `/forget`).

## Decided (with Miguel)

- Team-wide join link, rotatable by the admin. Existing members are unaffected by rotation.
- Joining is done by pasting a message into Claude; terminal one-liner as the alternative.
- Updates are automatic.
- **Joining with a name that already exists attaches to that person** (second computer, reinstall after uninstall). Accepted trade-off: anyone with the link could join as an existing teammate by typing their name.
- **Different people with the same name must be able to pick a distinct registered name** at join time (e.g. "Ana Silva (Marketing)").

## The design

### 1. Join link (server)

- New Worker secret `JOIN_CODE` (long random value, set with `wrangler secret put JOIN_CODE`). Rotating it kills the old link.
- `GET /join/<code>`: a small HTML page (no sign-in). Wrong code → 404. It shows:
  - the message to paste into Claude, with a copy button (see §3);
  - below it, "Prefer the terminal?" with `npx -y <url>/samepage-setup.tgz --join <code>`;
  - one line on what gets installed and how to undo it.
- `POST /join` with `{ code, name, existing?: boolean }`. Wrong code → 403. Never creates or attaches to a system person.
  - The person id is a slug of the name (`"Ana Silva"` → `ana-silva`; lowercase, accents stripped). Two names match when their slugs match.
  - No match → creates the person, returns `{ id, name, token, created: true }`.
  - Match and `existing` not set → 409 `{ id, name }`: the installer asks "A member named Ana Silva already exists. Is that you?" (see §2).
  - Match and `existing: true` → issues an **additional** token for that person and returns `{ id, name, token, created: false }`. Their other computers keep working.
- **Several tokens per person.** Today `people.token_hash` holds one token. Move tokens to their own table (`person_id`, `token_hash` unique, `created_at`), migrating existing hashes. Auth looks up the token there. `person:add` creates one token; `person:rotate` deletes all of the person's tokens and creates one (so it still means "cut off every machine"). `db:export` / `db:import` carry the tokens (the export format gets a version bump or a backward-compatible field — builder's call).
- `npm run join:link` prints the current link (needs `JOIN_CODE` in env, or reads it from the same place the deploy steps put it — builder's call). `person:add` / `person:rotate` stay for the admin.

### 2. Installer (`integrations/claude-code/setup.mjs`)

New invocation: `samepage-setup --join <code> [--name "<name>"] [--folders "<a>;<b>"]`. The existing `samepage-setup <token>` form keeps working (re-runs, rotations).

- It must run **without a terminal** (Claude runs it as a tool call, no TTY). With `--name` and `--folders` given it never prompts. With a TTY and missing values it prompts, offering defaults.
- **Already set up on this machine:** if `~/.samepage/config.json` holds a token the server accepts, `--join` skips the join and reuses it (re-runs to change folders, half-finished installs). The token from a successful join is written to config straight away, before later steps that can fail, so a retry never joins twice.
- **Name:** `--name`, else prompt. With `--join`, it calls `POST /join` and uses the returned token.
- **Name already taken:** on a 409 the installer stops with one clear line, readable by a person or by Claude: "A member named Ana Silva already exists. If that is you (another computer), run again with `--same-person`. If not, run again with a different `--name`, e.g. "Ana Silva (Marketing)"." In a TTY it asks the same as a yes/no question, and on "no" asks for another name. `--same-person` sends `existing: true`.
- **Folders:** `--folders`, else default to the current folder (Claude runs it from where the person works; in a TTY the prompt shows the current folder as the default, Enter accepts). The existing guards stay (not the home folder, not a drive root, must exist).
- **Claude binary:** prefer `CLAUDE_CODE_EXECPATH` when it points at an existing `claude*` binary (desktop-app users without the CLI), else `claude` on PATH as today.
- **Claude login (capture token):** if no `claudeToken` is stored:
  - with a TTY: as today, but the installer should try to capture the token automatically from `setup-token`'s output so nothing is pasted; fallback is today's hidden paste.
  - without a TTY: the installer opens **a new terminal window** that runs a small login helper (`login.mjs`, shipped in the package): it runs `claude setup-token` in that window and saves the token into `~/.samepage/config.json` itself (auto-capture if possible, otherwise a hidden paste inside that window). The installer prints one line for Claude to relay: "A window opened to approve your Claude login; capture turns on as soon as you approve." It does not wait for it.
  - Windows: `start` a `cmd` window; macOS: `osascript` → Terminal; Linux: try `x-terminal-emulator`, else print the command to run.
- Everything else (MCP registration, hooks, `~/.samepage` files, backup of `settings.json`) works as today.
- Final output is short and readable by a person or by Claude: what was set up, the folder, how to undo.

### 3. The message people paste into Claude

Shown on the join page, filled with the real URL and code. Draft (wording is the builder's call; it must stay short):

> Set up SamePage (our team memory) for me. Ask me my name and confirm that this folder holds company work. Check that Node 22 or newer is installed and install the LTS if it is not (winget on Windows, Homebrew on macOS). Then run: `npx -y <url>/samepage-setup.tgz --join <code> --name "<my name>" --folders "<this folder>"`. If it says that name already exists, ask me whether that is me; if yes run it again with `--same-person`, if not ask me for a different name. Tell me in one line what it did, and remind me to open a new session.

The SamePage token is created by the installer and written straight to config; it never appears in the conversation. The join code does, which is fine: it is already shared with the team.

### 4. Capture-off reminder

If `claudeToken` is missing (the person closed the login window), the prompt hook adds a one-time-per-session note: "SamePage capture is off until you approve the Claude login: run `npx -y <url>/samepage-setup.tgz --login`" (`--login` = just the login step). Only in company folders, like every other hook output.

### 5. Automatic updates

- `npm run build:setup` also writes `public/client.json`: `{ version, files: { "<relative path>": "<content>" } }` with every file of the package. `version` is a hash of the file contents, so maintainers no longer bump it by hand (the tarball `package.json` version should also follow it, so `npx` never reuses a stale cached tarball).
- On `session-start`, at most once per 24 h, the hook spawns a detached `update.mjs`: it fetches `<url>/client.json`; if the version differs from `~/.samepage/version`, it writes the files into `~/.samepage` (each via temp file + rename), re-applies `mergeHooks` to `settings.json` (idempotent), then writes `version` last. Any failure leaves the install as it was and writes one line to `capture.log`.
- It never touches `config.json` or session state.
- Existing installs (only Miguel's) don't have the updater yet: re-run setup once.
- Shipping: every `npm run deploy` publishes the current client to the whole team within 24 h. No separate publish step: deploy is already deliberate and Miguel is the only maintainer (Claude's call).
- `update.mjs` and `login.mjs` are copied into `~/.samepage` like the other client files, so nothing runs from the npx cache.

## Left to the builder

- Exact page design and copy of `/join`, the paste message wording, output wording.
- How `join:link` gets the code.
- Whether `setup-token` output can be captured without a paste (spike it; fall back to the paste inside the login window).
- Where the "last update check" timestamp lives.
- Changing a registered name after joining is out of scope; the choice happens at join (Claude's reading of the request).
- Tests: join route (new / 409 / `existing` / wrong code / system person), multi-token auth and rotate, `parseArgs` for the new flags, non-TTY install path with flags, updater (newer / same / failing fetch / partial write), reminder note. Then a real end-to-end on Windows: paste the message into the desktop app's Code tab from a fresh `~/.samepage`.
