# SamePage for Claude Code

## Join (each teammate)

You need Claude Code. Ask the admin for the team link (it looks like `https://samepage.scooli.workers.dev/join/<code>`).

1. Open the link and copy the message on the page.
2. Paste it into Claude: the desktop app's Code tab, or a terminal session.
3. Claude asks your name, confirms that the folder holds company work, installs Node 22 if it is missing, runs the setup and tells you what it did.
4. A window opens to approve your Claude login. Approve it there; capture turns on right after.
5. Open a new session.

Prefer the terminal? With Node 22 or newer and Claude Code installed, run this in any terminal; it asks your name and folders:

```
npx -y https://samepage.scooli.workers.dev/samepage-setup.tgz --join <code>
```

Either way the setup:
- connects the SamePage MCP server to Claude Code (every folder, desktop app included);
- adds the capture hooks to `~/.claude/settings.json` (first install keeps a `settings.json.samepage-backup`);
- copies the capture client to `~/.samepage/` and writes `~/.samepage/config.json`;
- sets up the Claude login that capture needs, so it uses your own Claude subscription (see `--login` below).

Flags (Claude passes them for you, except `--claude-token`; they also work by hand):
- `--name "<name>"`: your name. Required when there is no terminal.
- `--folders "<a>;<b>"`: the folders that hold company work.
- `--same-person`: you already joined from another computer. Use the same name and add this flag; this computer gets its own token and the other one keeps working.
- `--login`: approve the Claude login on its own, without joining again. Use it if you skipped the login window or it did not open. Until it is approved capture is off, and Claude says so once per session.
- `--claude-token <t>`: terminal only. Give the Claude token yourself instead of approving the login. Never paste that token into a chat.
- `--url <url>`: another SamePage server.

Names match by their letters and digits, ignoring accents and case ("ana silva" is "Ana Silva"). If the name is taken, setup stops and says so. Two computers, one person: run again with the same name and `--same-person`. Two people with the same name: run again with a different `--name`, e.g. `"Ana Silva (Marketing)"`. In a terminal it asks instead.

Running the setup again on the same computer keeps your member and your token.

The hooks run the `node` found on your PATH at setup time. Re-run the setup after moving or reinstalling Node.

Open a new session: `/mcp` shows `samepage` connected, and your team summary (principles, recent decisions, what changed since your last session, open proposals) arrives with the server instructions at the start of each session.

Undo everything (hooks, MCP connection, `~/.samepage`): `npx -y https://samepage.scooli.workers.dev/samepage-setup.tgz --uninstall`.

## Updates

Nothing to do. At the start of a session, at most once every 24 hours, the client checks the server for a newer version. If there is one it replaces the files in `~/.samepage/` and refreshes the hooks in `~/.claude/settings.json`; new tools and hooks apply from the next session. `config.json` is never touched. If an update fails, the install stays as it was and `capture.log` gets one `update failed` line.

An install made before automatic updates existed gets them after one more run of the setup.

## What gets captured

Capture runs only in the folders you chose (and their subfolders). When a session ends, or has been idle for a while, a local `claude -p` pass reads the conversation and keeps only what the team would want to know later. The bar is high, so most sessions produce nothing.
- What it finds is sent to SamePage as entries. Anything it is unsure about becomes a pending question, which Claude puts to you on your next prompt.
- **The conversation never leaves your machine; only the extracted entries are sent.**
- Type `/private` in a session and that session is never processed.
- Type `/forget` and everything up to now that was not yet captured is dropped.
- Entries can be deleted with a reason (`delete_entry`).
- The desktop app shows these as "a hook blocked your prompt": that is expected, nothing reached Claude.
- A session keeps the SamePage tools it had when it opened; after an update, start a new session to get new tools.

Files, all under `~/.samepage/` (override with `SAMEPAGE_HOME`):
- `capture.log`: one line per pass or failure, including failed updates (never conversation text); look here when nothing shows up.
- `config.json`: `folders` (where capture runs) and `dailyLimit` (passes per day, default 20) are plain values you can edit; changes apply to the next session. It also holds your tokens, so keep it private.

## Dashboard (optional)

Ask your agent to "open the dashboard". It calls `open_dashboard` and gives you a sign-in link that works once and expires in 10 minutes; opening it keeps you signed in for 30 days in that browser. The dashboard shows what's new since your last visit, decisions with their history, open proposals, who thinks what, and team activity; you can accept or reject proposals and rename, merge or close workstreams. It is never required: everything it does, your agent can do too.

The dashboard's "what's new" and the session summary each keep their own "last seen" time, so reading one does not hide anything from the other.

To sign everyone out, set a new `DASHBOARD_SECRET` (deploy step 4).

## Hosting (free tiers)

SamePage runs on Cloudflare Workers (code) and Neon (Postgres). Limits checked on 2026-10-24; they change, so re-check before relying on them.

**Neon Free** (source: https://neon.com/pricing)
- 100 projects; 1 GB storage per project (20 GB across projects).
- 100 CU-hours of compute per project; compute is suspended until the next billing period if exceeded.
- Compute scales to zero after 5 minutes idle (always on for Free), so the first request after a pause is a bit slower.
- 5 GB egress per project; 6 hours of history retention (not a backup).

**Cloudflare Workers Free** (source: https://developers.cloudflare.com/workers/platform/limits/)
- 100,000 requests per day (resets at midnight UTC), 10 ms CPU time per request, 50 subrequests per request.
- Worker bundle: 64 MiB uncompressed (ours is about 1.7 MiB, 314 KiB gzipped).

A small team's daily use is far below these limits. The 10 ms CPU limit is the one to watch: if `/mcp` calls start failing with CPU-limit errors, check the Worker logs.

## Deploy (one time, done by the person who owns the hosting)

Commands are shown for bash and for PowerShell. In PowerShell use `curl.exe` (plain `curl` is an alias for `Invoke-WebRequest`), and set `$env:DATABASE_URL` once per terminal.

1. Create a Neon project and copy two connection strings:
   - the **pooled** one (host contains `-pooler`) for the Worker secret;
   - the **direct** (non-pooler) one for `db:migrate` and the `person:add` / `person:rotate` / `db:export` scripts, since migrations and one-off scripts work better without the pooler.
2. Apply the schema:
   - bash: `DATABASE_URL="<direct string>" npm run db:migrate`
   - PowerShell: `$env:DATABASE_URL="<direct string>"; npm run db:migrate`

   Run it again before any deploy that brings a new migration, and deploy right after it (step 5): the old Worker fails between the two, because the join-link migration drops `people.token_hash` after moving the tokens into the new `person_tokens` table (several tokens per person), so nobody has to set up again.
3. Create the system person, and anyone you want to give a personal setup command instead of the team link (same `DATABASE_URL` as above; in PowerShell it stays set for the session):
   - `npm run person:add -- meet "Meet" --system`
   - `npm run person:add -- miguel "Miguel"`

   Prefix each with `DATABASE_URL="<direct string>"` in bash. Each command prints that person's setup command (with their token) once. Send it to them through a private channel.
   Lost or leaked token, or someone who must lose access: `npm run person:rotate -- <id>` cuts off every computer of that person at once; the old tokens stop working immediately. It prints a new setup command: send it to them, or discard it to leave them out (there is no delete command). Anyone with the join link can join again, so to really lock someone out also run `npm run join:new` and share the new link with the rest of the team. If a token may have been used, also set a new `DASHBOARD_SECRET` (this signs everyone out of the dashboard).
4. Log in and set the secrets: `npx wrangler login`, then `npx wrangler secret put DATABASE_URL` (paste the pooled string) and `npx wrangler secret put DASHBOARD_SECRET` (paste a long random value, e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; it signs dashboard links and sessions). For `wrangler dev`, put `DASHBOARD_SECRET=dev` in `.dev.vars`.
5. Deploy: `npm run deploy` (it first builds `public/samepage-setup.tgz`, the installer, and `public/client.json`, the current client, which the Worker serves as static assets). The client version is computed from its files, so there is nothing to bump. Every deploy ships the current client to all teammates: their next session start after 24 hours picks it up (see Updates). Wrangler prints the Worker URL (`https://samepage.<account>.workers.dev`). Set `SAMEPAGE_URL` to it when running `person:add`, `person:rotate` or `join:new` if it differs from the default. Current deployment: `https://samepage.scooli.workers.dev` (Scooli Cloudflare account).
6. Create the team join link (after the first deploy, still logged in to wrangler):
   - `npm run join:new`

   It stores a new random code as the Worker secret `JOIN_CODE` and prints the link `https://<worker>/join/<code>`. Share it with the team. Running it again replaces the link: the old one stops working, and people who already joined are not affected. Do this if the link leaks.
7. Check it:
   - `curl https://<worker>/health` returns `ok` (PowerShell: `curl.exe https://<worker>/health`)
   - `curl https://<worker>/client.json` returns the client files (PowerShell: `curl.exe https://<worker>/client.json`)
   - `curl https://<worker>/join/<code>` returns the join page, 200 (PowerShell: `curl.exe https://<worker>/join/<code>`)
   - `curl -H "Authorization: Bearer <token>" https://<worker>/summary` returns the summary header (PowerShell: `curl.exe -H "Authorization: Bearer <token>" https://<worker>/summary`)

Later releases: run `db:migrate` if there is a new migration, then `npm run deploy`. Run `join:new` again only to replace the link.

`npm run db:export` files contain the token hashes, so store them privately.
