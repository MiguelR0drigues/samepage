import path from 'node:path';

/**
 * True when cwd is one of the company folders or inside one.
 * @param {string} cwd
 * @param {string[]} folders
 * @param {string} [platform]
 */
export function isCompanyFolder(cwd, folders, platform = process.platform) {
  if (!cwd) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = platform === 'win32' || platform === 'darwin';
  const norm = (/** @type {string} */ x) => { const n = p.normalize(p.resolve(x)); return fold ? n.toLowerCase() : n; };
  const c = norm(cwd);
  return folders.some((f) => {
    if (!f) return false;
    const n = norm(f);
    return c === n || c.startsWith(n.endsWith(p.sep) ? n : n + p.sep);
  });
}
