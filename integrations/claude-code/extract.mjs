#!/usr/bin/env node
// node extract.mjs <session_id> <mid|final>  |  node extract.mjs --sweep <current_session_id>
import { samepageHome } from './lib/paths.mjs';
import { readConfig, log } from './lib/state.mjs';
import { runPass, sweep } from './lib/pass.mjs';
import { runClaude } from './lib/claude.mjs';

const env = process.env;
const home = samepageHome(env);
const config = env.SAMEPAGE_EXTRACTOR ? null : readConfig(home);
if (config) {
  const deps = { home, config, env, fetch, runClaude, now: Date.now() };
  const [a, b] = process.argv.slice(2);
  try {
    if (a === '--sweep') await sweep(b ?? '', deps);
    else if (a && (b === 'mid' || b === 'final')) await runPass(a, b, deps);
  } catch (e) {
    try { log(home, `extract error: ${/** @type {Error} */ (e).message}`); } catch { /* nowhere to report */ }
  }
}
