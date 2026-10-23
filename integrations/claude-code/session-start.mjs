// Claude Code SessionStart hook: prints the SamePage summary. Never fails a session.
const { SAMEPAGE_URL, SAMEPAGE_TOKEN } = process.env;
try {
  if (SAMEPAGE_URL && SAMEPAGE_TOKEN) {
    const res = await fetch(`${SAMEPAGE_URL.replace(/\/+$/, '')}/summary`, {
      headers: { Authorization: `Bearer ${SAMEPAGE_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200) process.stdout.write(await res.text());
  }
} catch {
  // silent by design: a broken hook must not break the session
}
