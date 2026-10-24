# SamePage for Claude Code

Connects Claude Code to SamePage and shows a short team summary at session start.

1. Each person sets `SAMEPAGE_URL` (no trailing slash) and `SAMEPAGE_TOKEN` as **user environment variables**. Never put them in the repo.
2. In each company repo:
   - copy `mcp.json` to `.mcp.json` at the repo root;
   - copy `session-start.mjs` to `.claude/samepage/session-start.mjs`;
   - merge `settings.json` into `.claude/settings.json`.
3. Commit those files to the company repo.

If the variables are missing or the server is unreachable, the hook prints nothing and the session starts normally.

The hook command uses `$CLAUDE_PROJECT_DIR`, so it works even when Claude Code starts in a subdirectory of the repo.

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

   Prefix each with `DATABASE_URL="<direct string>"` in bash. Each command prints a token once. Give each person theirs through a private channel.
   Lost or leaked token: `npm run person:rotate -- <id>` prints a new one and the old one stops working immediately.
4. Log in and set the secret: `npx wrangler login`, then `npx wrangler secret put DATABASE_URL` (paste the pooled string).
5. Deploy: `npm run deploy`. Wrangler prints the Worker URL (`https://samepage.<account>.workers.dev`). That is the `SAMEPAGE_URL`. Current deployment: `https://samepage.samepage.workers.dev` (Scooli Cloudflare account).
6. Check it:
   - `curl https://<worker>/health` returns `ok` (PowerShell: `curl.exe https://<worker>/health`)
   - `curl -H "Authorization: Bearer <token>" https://<worker>/summary` returns the summary header (PowerShell: `curl.exe -H "Authorization: Bearer <token>" https://<worker>/summary`)

On Windows, Claude Code runs hooks under Git Bash, so the session-start hook command works there as written.

`npm run db:export` files contain the token hashes, so store them privately.
