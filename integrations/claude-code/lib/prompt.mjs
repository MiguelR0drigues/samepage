import readline from 'node:readline/promises';

/** @param {string} prompt */
export async function askHidden(prompt) {
  process.stdout.write(`${prompt} `);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin });
    const answer = await rl.question('');
    rl.close();
    return answer.trim();
  }
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); };
    const onData = (/** @type {string} */ chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); return resolve(value.trim()); }
        if (ch === '\u0003') { finish(); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** @param {string} prompt */
export async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

/** @param {string} question @returns {Promise<boolean>} */
export async function askYesNo(question) {
  for (;;) {
    const a = (await ask(question)).toLowerCase();
    if (a === 'y' || a === 'yes') return true;
    if (a === 'n' || a === 'no') return false;
  }
}
