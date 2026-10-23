# SamePage for Claude Code

Connects Claude Code to SamePage and shows a short team summary at session start.

1. Each person sets `SAMEPAGE_URL` (no trailing slash) and `SAMEPAGE_TOKEN` as **user environment variables**. Never put them in the repo.
2. In each company repo:
   - copy `mcp.json` to `.mcp.json` at the repo root;
   - copy `session-start.mjs` to `.claude/samepage/session-start.mjs`;
   - merge `settings.json` into `.claude/settings.json`.
3. Commit those files to the company repo.

If the variables are missing or the server is unreachable, the hook prints nothing and the session starts normally.
