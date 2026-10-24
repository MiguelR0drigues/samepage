# SamePage for Claude Code

## Join (each teammate, one command)

Ask the admin for your personal setup command (printed by `npm run person:add`) and paste it into any terminal:

```
claude mcp add --scope user --transport http samepage https://samepage.scooli.workers.dev/mcp --header "Authorization: Bearer <your token>"
```

That is all. It works in every folder (including a parent folder with several repos) and in the Claude desktop app. Open a new session: `/mcp` shows `samepage` connected, and your team summary (principles, recent decisions, what changed since your last session, open proposals) arrives with the server instructions at the start of each session.

To disconnect: `claude mcp remove samepage -s user`.

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
5. Deploy: `npm run deploy`. Wrangler prints the Worker URL (`https://samepage.<account>.workers.dev`). Set `SAMEPAGE_URL` to it when running `person:add` if it differs from the default. Current deployment: `https://samepage.scooli.workers.dev` (Scooli Cloudflare account).
6. Check it:
   - `curl https://<worker>/health` returns `ok` (PowerShell: `curl.exe https://<worker>/health`)
   - `curl -H "Authorization: Bearer <token>" https://<worker>/summary` returns the summary header (PowerShell: `curl.exe -H "Authorization: Bearer <token>" https://<worker>/summary`)

`npm run db:export` files contain the token hashes, so store them privately.
