import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as st from '../../integrations/claude-code/lib/state.mjs';
import { LOCK_STALE_MS } from '../../integrations/claude-code/lib/limits.mjs';
import { samepageHome, claudeDir } from '../../integrations/claude-code/lib/paths.mjs';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-state-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

it('loadSession defaults for an unknown id, saveSession round-trips', () => {
  expect(st.loadSession(home, 'x')).toEqual({
    transcriptPath: null, cwd: null, lastActivity: 0, processedLine: 0, processedAt: 0,
    skipUntilLine: 0, private: false, notes: [], notice: null,
  });
  const s = { ...st.loadSession(home, 'x'), processedLine: 7, notes: ['a'], private: true };
  st.saveSession(home, 'x', s);
  expect(st.loadSession(home, 'x')).toEqual(s);
  expect(st.listSessions(home)).toEqual(['x']);
  expect(fs.readdirSync(path.join(home, 'sessions'))).toEqual(['x.json']);
});

it('listSessions is empty before any save', () => {
  expect(st.listSessions(home)).toEqual([]);
});

it('readConfig returns null when missing, the parsed config when present', () => {
  expect(st.readConfig(home)).toBeNull();
  const c = { url: 'u', token: 't', folders: ['/a'], dailyLimit: 20, claudePath: null, claudeToken: 'oat' };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c));
  expect(st.readConfig(home)).toEqual(c);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'u', token: 't' }));
  expect(st.readConfig(home)).toEqual({ url: 'u', token: 't', folders: [], dailyLimit: 20, claudePath: null, claudeToken: null });
});

it('writeConfig keeps a stored dailyLimit, new installs get the default', () => {
  const c = { url: 'u', token: 't', folders: ['/a'], claudePath: null, claudeToken: 'oat' };
  st.writeConfig(home, c);
  expect(st.readConfig(home)).toEqual({ ...c, dailyLimit: 20 });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...c, dailyLimit: 7 }));
  st.writeConfig(home, { ...c, token: 't2' });
  expect(st.readConfig(home)).toEqual({ ...c, token: 't2', dailyLimit: 7 });
});

it('takeLock is exclusive, reusable after release, and replaces a stale lock', () => {
  const release = st.takeLock(home, 's1', 1000)!;
  expect(release).toBeTypeOf('function');
  expect(st.takeLock(home, 's1', 1000)).toBeNull();
  release();
  const again = st.takeLock(home, 's1', 1000);
  expect(again).toBeTypeOf('function');
  expect(st.takeLock(home, 's1', 1000 + 1000)).toBeNull();
  expect(st.takeLock(home, 's1', Date.now() + LOCK_STALE_MS + 60_000)).toBeTypeOf('function');
});

it('takeLock treats an empty lock file as held and never throws', () => {
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'locks', 's2'), '');
  expect(st.takeLock(home, 's2')).toBeNull();
  fs.writeFileSync(path.join(home, 'file'), '');
  expect(st.takeLock(path.join(home, 'file'), 's3')).toBeNull(); // unusable home
});

it('takeLock replaces a stale lock exactly once and leaves no claim files behind', () => {
  st.takeLock(home, 's4', 1000);
  const later = Date.now() + LOCK_STALE_MS + 60_000;
  const release = st.takeLock(home, 's4', later);
  expect(release).toBeTypeOf('function');
  expect(st.takeLock(home, 's4')).toBeNull();
  expect(fs.readdirSync(path.join(home, 'locks'))).toEqual(['s4']);
  release!();
  expect(st.takeLock(home, 's4')).toBeTypeOf('function');
});

it('usage counts per local day and resets on a new day', () => {
  const day1 = new Date(2026, 9, 24, 10).getTime();
  const day2 = new Date(2026, 9, 25, 10).getTime();
  expect(st.usageToday(home, day1)).toBe(0);
  st.addUsage(home, day1);
  st.addUsage(home, day1);
  expect(st.usageToday(home, day1)).toBe(2);
  expect(st.usageToday(home, day2)).toBe(0);
  st.addUsage(home, day2);
  expect(st.usageToday(home, day2)).toBe(1);
});

it('log appends timestamped lines', () => {
  st.log(home, 'one');
  st.log(home, 'two');
  const lines = fs.readFileSync(path.join(home, 'capture.log'), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z one$/);
});

it('paths honour env overrides', () => {
  expect(samepageHome({ SAMEPAGE_HOME: '/x/sp' })).toBe('/x/sp');
  expect(claudeDir({ CLAUDE_CONFIG_DIR: '/x/cl' })).toBe('/x/cl');
  expect(samepageHome({})).toBe(path.join(os.homedir(), '.samepage'));
  expect(claudeDir({})).toBe(path.join(os.homedir(), '.claude'));
});
