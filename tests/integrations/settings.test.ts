import { expect, it } from 'vitest';
import { mergeHooks, removeHooks } from '../../integrations/claude-code/lib/settings.mjs';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const HOOK = 'C:\\Users\\Me Me\\.samepage\\hook.mjs';
const other = { hooks: [{ type: 'command', command: 'echo hi' }] };

const handlers = (s: any) => Object.values(s.hooks).flatMap((groups: any) => groups.flatMap((g: any) => g.hooks));

it('mergeHooks adds the four events and keeps unrelated hooks', () => {
  const s = mergeHooks({ model: 'opus', hooks: { Stop: [other], PreToolUse: [other] } }, NODE, HOOK);
  expect(s.model).toBe('opus');
  expect(s.hooks.PreToolUse).toEqual([other]);
  expect(s.hooks.Stop[0]).toEqual(other);
  expect(s.hooks.Stop[1].hooks[0]).toEqual({ type: 'command', command: NODE, args: [HOOK, 'stop'], timeout: 10, async: true });
  expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: NODE, args: [HOOK, 'session-start'], timeout: 10, async: true });
  expect(s.hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: 'command', command: NODE, args: [HOOK, 'prompt'], timeout: 10 });
  expect(s.hooks.SessionEnd[0].hooks[0]).toEqual({ type: 'command', command: NODE, args: [HOOK, 'session-end'], timeout: 10 });
});

it('mergeHooks twice does not duplicate', () => {
  const once = mergeHooks({}, NODE, HOOK);
  expect(mergeHooks(once, NODE, HOOK)).toEqual(once);
  expect(handlers(once)).toHaveLength(4);
});

it('mergeHooks replaces an old SamePage hook with a different path', () => {
  const old = mergeHooks({}, '/usr/bin/node', '/home/me/.samepage/hook.mjs');
  const s = mergeHooks(old, NODE, HOOK);
  expect(handlers(s)).toHaveLength(4);
  expect(handlers(s).every((h: any) => h.command === NODE && h.args[0] === HOOK)).toBe(true);
});

it('a custom SAMEPAGE_HOME hook path is not duplicated and is removed by path', () => {
  const custom = '/data/sp-home/hook.mjs';
  const once = mergeHooks({}, NODE, custom);
  expect(mergeHooks(once, NODE, custom)).toEqual(once);
  expect(removeHooks(once, custom)).toEqual({ hooks: {} });
});

it('removeHooks leaves unrelated hooks and drops empty events', () => {
  const s = removeHooks(mergeHooks({ hooks: { Stop: [other] } }, NODE, HOOK));
  expect(s).toEqual({ hooks: { Stop: [other] } });
  expect(removeHooks(mergeHooks({}, NODE, HOOK))).toEqual({ hooks: {} });
});
