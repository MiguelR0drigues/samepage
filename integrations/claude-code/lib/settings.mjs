const EVENTS = /** @type {const} */ ([
  ['SessionStart', 'session-start', true],
  ['UserPromptSubmit', 'prompt', false],
  ['Stop', 'stop', true],
  ['SessionEnd', 'session-end', false],
]);

// ours: args[0] is .../.samepage/hook.mjs (either separator), or the hook path of a custom SAMEPAGE_HOME
const isOurs = (/** @type {any} */ h, /** @type {string | undefined} */ hookPath) =>
  /[\\/]\.samepage[\\/]hook\.mjs$/.test(String(h?.args?.[0] ?? '')) || (!!hookPath && h?.args?.[0] === hookPath);

/** The command of our existing hook, so a rewrite keeps the node the installer chose. @param {Record<string, any>} settings @param {string} hookPath @returns {string | undefined} */
export const ourHookCommand = (settings, hookPath) =>
  Object.values(settings.hooks ?? {}).flat().flatMap((g) => g?.hooks ?? []).find((h) => isOurs(h, hookPath) && typeof h.command === 'string')?.command;

/** Drops our handlers (and the groups and events they leave empty). @param {Record<string, any>} hooks @param {string} [hookPath] */
function withoutOurs(hooks, hookPath) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((/** @type {any} */ h) => !isOurs(h, hookPath)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

/**
 * Settings with the four SamePage hooks added (older SamePage hooks replaced, everything else untouched).
 * @param {Record<string, any>} settings @param {string} nodePath @param {string} hookPath
 * @returns {Record<string, any>}
 */
export function mergeHooks(settings, nodePath, hookPath) {
  const hooks = withoutOurs(settings.hooks ?? {}, hookPath);
  for (const [event, arg, async] of EVENTS) {
    const handler = { type: 'command', command: nodePath, args: [hookPath, arg], timeout: 10, ...(async && { async }) };
    hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
  }
  return { ...settings, hooks };
}

/** @param {Record<string, any>} settings @param {string} [hookPath] hook path of a custom SAMEPAGE_HOME @returns {Record<string, any>} */
export function removeHooks(settings, hookPath) {
  return { ...settings, hooks: withoutOurs(settings.hooks ?? {}, hookPath) };
}
