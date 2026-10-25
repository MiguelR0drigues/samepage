#!/usr/bin/env node
// node extract.mjs <session_id> <mid|final>  |  --sweep <current_session_id>  |  --off-record <session_id>  |  --changes <session_id> <since_ms>
import { samepageHome } from './lib/paths.mjs';
import { readConfig, log } from './lib/state.mjs';
import { runPass, sweep, forgetSession, checkChanges } from './lib/pass.mjs';
import { runClaude } from './lib/claude.mjs';

const env = process.env;
const home = samepageHome(env);
const config = env.SAMEPAGE_EXTRACTOR ? null : readConfig(home);
if (config) {
  const deps = { home, config, env, fetch, runClaude, now: Date.now() };
  const [a, b, c] = process.argv.slice(2);
  try {
    if (a === '--sweep') await sweep(b ?? '', deps);
    else if (a === '--off-record' && b) await forgetSession(b, deps);
    else if (a === '--changes' && b) await checkChanges(b, Number(c), deps);
    else if (a && (b === 'mid' || b === 'final')) await runPass(a, b, deps);
  } catch (e) {
    try { log(home, `extract error: ${/** @type {Error} */ (e).message}`); } catch { /* nowhere to report */ }
  }
}
