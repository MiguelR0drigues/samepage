import os from 'node:os';
import path from 'node:path';

/** @param {Record<string, string | undefined>} [env] */
export const samepageHome = (env = process.env) => env.SAMEPAGE_HOME || path.join(os.homedir(), '.samepage');

/** @param {Record<string, string | undefined>} [env] */
export const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
