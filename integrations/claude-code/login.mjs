#!/usr/bin/env node
// Approves the Claude login that capture needs: runs `claude setup-token`, then stores the token it prints.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { samepageHome } from './lib/paths.mjs';
import { ask, askHidden } from './lib/prompt.mjs';
import { readConfig, setClaudeToken } from './lib/state.mjs';
import { findClaude, runClaude } from './setup.mjs';

/** @param {string} home @param {string} claude @returns {Promise<boolean>} whether a token was stored */
export async function runLogin(home, claude) {
  console.log('Capture uses your own Claude subscription. Claude will now create a long-lived token for it (setup-token):');
  // setup-token needs a real terminal, so the token is pasted inside this window
  try { runClaude(claude, ['setup-token'], { stdio: 'inherit' }); } catch { /* it printed its own error; an empty answer below keeps capture off */ }
  const token = await askHidden('Paste the token it printed (starts with sk-ant-):');
  if (token) setClaudeToken(home, token);
  else console.warn('Capture stays off until you run the login again.');
  return !!token;
}

async function main() {
  const home = samepageHome();
  const config = readConfig(home);
  const claude = config?.claudePath ?? findClaude();
  if (!config || !claude) {
    console.error('Run setup first.');
    process.exit(1);
  }
  if (await runLogin(home, claude)) console.log('Done. You can close this window.');
  if (process.stdin.isTTY) await ask('Press Enter to close. ');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
