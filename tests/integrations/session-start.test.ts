import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const script = 'integrations/claude-code/session-start.mjs';
let server: Server | undefined;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

function run(env: Record<string, string>) {
  return new Promise<{ stdout: string; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ stdout, code }));
  });
}

async function listen(status: number, body: string) {
  server = createServer((req, res) => {
    const ok = req.url === '/summary' && req.headers.authorization === 'Bearer tok';
    res.writeHead(ok ? status : 401, { 'content-type': 'text/plain' }).end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('session-start hook', () => {
  it('prints the summary when the server responds 200', async () => {
    const url = await listen(200, '# Team memory');
    const { stdout, code } = await run({ SAMEPAGE_URL: url, SAMEPAGE_TOKEN: 'tok' });
    expect(stdout).toContain('# Team memory');
    expect(code).toBe(0);
  });

  it('exits silently with code 0 without environment variables', async () => {
    expect(await run({})).toEqual({ stdout: '', code: 0 });
  });

  it('exits silently with code 0 when the server is down', async () => {
    const url = await listen(200, 'x');
    await new Promise<void>((r) => server!.close(() => r()));
    expect(await run({ SAMEPAGE_URL: url, SAMEPAGE_TOKEN: 'tok' })).toEqual({ stdout: '', code: 0 });
  });

  it('exits silently with code 0 on 401', async () => {
    const url = await listen(200, '# Team memory');
    expect(await run({ SAMEPAGE_URL: url, SAMEPAGE_TOKEN: 'wrong' })).toEqual({ stdout: '', code: 0 });
  });
});
