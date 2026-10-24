// Stands in for `claude -p` in tests: echoes FAKE_CLAUDE_OUT, logs argv and SAMEPAGE_EXTRACTOR.
import fs from 'node:fs';

const env = process.env;
if (env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), SAMEPAGE_EXTRACTOR: env.SAMEPAGE_EXTRACTOR ?? null }) + '\n');
}
if (env.FAKE_CLAUDE_SLEEP) setInterval(() => {}, 1000);
else {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    if (env.FAKE_CLAUDE_STDIN) fs.writeFileSync(env.FAKE_CLAUDE_STDIN, input);
    if (env.FAKE_CLAUDE_OUT) process.stdout.write(fs.readFileSync(env.FAKE_CLAUDE_OUT, 'utf8'));
    process.exit(env.FAKE_CLAUDE_EXIT === '1' ? 1 : 0);
  });
}
