# SamePage for Claude Code

## Join (each teammate, one command)

You need Node 22 or newer and Claude Code installed. Ask the admin for your personal setup command (printed by `npm run person:add`) and paste it into any terminal:

```
npx -y https://samepage.scooli.workers.dev/samepage-setup.tgz <your token>
```

It asks which folders hold company work, then:
- connects the SamePage MCP server to Claude Code (every folder, desktop app included);
- adds the capture hooks to `~/.claude/settings.json` (first install keeps a `settings.json.samepage-backup`);
- copies the capture client to `~/.samepage/` and writes `~/.samepage/config.json`;
- runs `claude setup-token` so capture uses your own Claude subscription: paste the token it prints (hidden). A re-run keeps the stored one; `--claude-token <t>` skips the question.

The hooks run the `node` found on your PATH at setup time. Re-run the setup command after moving or reinstalling Node.

Open a new session: `/mcp` shows `samepage` connected, and your team summary (principles, recent decisions, what changed since your last session, open proposals) arrives with the server instructions at the start of each session.

Undo everything (hooks, MCP connection, `~/.samepage`): `npx -y https://samepage.scooli.workers.dev/samepage-setup.tgz --uninstall`.

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
- `capture.log`: one line per pass or failure (never conversation text); look here when nothing shows up.
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
   - the **direct** (non-pooler) one for `db:migrate` and the `person:add` / `db:export` scripts, since migrations and one-off scripts work better without the pooler.
2. Apply the schema:
   - bash: `DATABASE_URL="<direct string>" npm run db:migrate`
   - PowerShell: `$env:DATABASE_URL="<direct string>"; npm run db:migrate`
3. Create each team member and the system person (same `DATABASE_URL` as above; in PowerShell it stays set for the session):
   - `npm run person:add -- miguel "Miguel"`
   - `npm run person:add -- meet "Meet" --system`

   Prefix each with `DATABASE_URL="<direct string>"` in bash. Each command prints that person's setup command (with their token) once. Send it to them through a private channel.
   Lost or leaked token: `npm run person:rotate -- <id>` prints a new setup command and the old token stops working immediately. If the token may have been used, also set a new `DASHBOARD_SECRET` (this signs everyone out of the dashboard).
4. Log in and set the secrets: `npx wrangler login`, then `npx wrangler secret put DATABASE_URL` (paste the pooled string) and `npx wrangler secret put DASHBOARD_SECRET` (paste a long random value, e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; it signs dashboard links and sessions). For `wrangler dev`, put `DASHBOARD_SECRET=dev` in `.dev.vars`.
5. Deploy: `npm run deploy` (it first builds `public/samepage-setup.tgz`, the installer teammates run, which the Worker serves as a static asset). Maintainers: bump `version` in `integrations/claude-code/package.json` whenever the client changes, or `npx` may reuse a cached old tarball. Wrangler prints the Worker URL (`https://samepage.<account>.workers.dev`). Set `SAMEPAGE_URL` to it when running `person:add` if it differs from the default. Current deployment: `https://samepage.scooli.workers.dev` (Scooli Cloudflare account).
6. Check it:
   - `curl https://<worker>/health` returns `ok` (PowerShell: `curl.exe https://<worker>/health`)
   - `curl -H "Authorization: Bearer <token>" https://<worker>/summary` returns the summary header (PowerShell: `curl.exe -H "Authorization: Bearer <token>" https://<worker>/summary`)

`npm run db:export` files contain the token hashes, so store them privately.
