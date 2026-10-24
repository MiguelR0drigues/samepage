import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readTranscript, branchHint, buildExcerpt } from '../../integrations/claude-code/lib/transcript.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-tr-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const line = (o: object) => JSON.stringify(o);
const user = (content: unknown, extra = {}) =>
  line({ type: 'user', cwd: '/w', gitBranch: 'HEAD', message: { role: 'user', content }, ...extra });

function fixture(): string {
  const f = path.join(dir, 't.jsonl');
  const lines = [
    line({ type: 'queue-operation' }),
    user('first question'),
    user([{ type: 'tool_result', content: 'secret output' }]),
    line({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'an answer' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/w/web-app/src/a.ts' } },
    ] } }),
    user('meta text', { isMeta: true }),
    user('side text', { isSidechain: true }),
    user('<command-name>/clear</command-name>'),
    user([{ type: 'text', text: '<system-reminder>noise</system-reminder>second question' }]),
    user('/private'),
    user('/forget'),
    user('<system-reminder>only noise</system-reminder>'),
  ];
  fs.writeFileSync(f, lines.join('\n') + '\n' + '{"type":"user","message":{"role":"us');
  return f;
}

it('keeps only real texts in order and stops before a truncated last line', () => {
  const r = readTranscript(fixture(), 0);
  expect(r.messages).toEqual([
    { role: 'user', text: 'first question' },
    { role: 'agent', text: 'an answer' },
    { role: 'user', text: 'second question' },
  ]);
  expect(r.endLine).toBe(11);
  expect(r.userCount).toBe(2);
  expect(r.chars).toBe('first question'.length + 'an answer'.length + 'second question'.length);
  expect(r.paths).toEqual(['/w/web-app/src/a.ts']);
  expect(r.cwd).toBe('/w');
  expect(r.gitBranch).toBe('HEAD');
});

it('fromLine skips earlier lines', () => {
  const r = readTranscript(fixture(), 7);
  expect(r.messages).toEqual([{ role: 'user', text: 'second question' }]);
  expect(r.paths).toEqual([]);
  expect(r.endLine).toBe(11);
});

it('a complete final line is counted', () => {
  const f = path.join(dir, 'c.jsonl');
  fs.writeFileSync(f, user('hi') + '\n' + user('there'));
  const r = readTranscript(f, 0);
  expect(r.endLine).toBe(2);
  expect(r.messages).toHaveLength(2);
});

it('buildExcerpt keeps the newest messages within maxChars and cuts long ones', () => {
  const msgs: { role: 'user' | 'agent'; text: string }[] = [
    { role: 'user', text: 'old old old' },
    { role: 'agent', text: 'middle' },
    { role: 'user', text: 'newest message here' },
  ];
  expect(buildExcerpt(msgs, 40, 10)).toBe('[agent] middle\n[user] newest mes');
  expect(buildExcerpt(msgs, 30, 100)).toBe('[user] newest message here');
});

it('branchHint uses the repo folder most used by paths', () => {
  fs.mkdirSync(path.join(dir, 'web-app'));
  const repo = path.join(dir, 'web-app');
  execFileSync('git', ['init', '-q', '-b', 'feat-x', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i']);
  const paths = [path.join(dir, 'web-app', 'a.ts'), path.join(dir, 'web-app', 'b.ts'), path.join(dir, 'other', 'c.ts')];
  expect(branchHint(dir, paths, 'HEAD')).toBe('web-app@feat-x');
});

it('branchHint falls back to gitBranch, then the basename', () => {
  expect(branchHint(path.join(dir, 'proj'), [], 'main')).toBe('proj@main');
  expect(branchHint(path.join(dir, 'proj'), [], 'HEAD')).toBe('proj');
  expect(branchHint(null, [], null)).toBeNull();
});
