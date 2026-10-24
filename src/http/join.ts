import { Hono } from 'hono';
import { html } from 'hono/html';
import type { Store } from '../storage/store';
import { sha256Hex, type Env } from './app';

const NAME_MAX = 80;

export const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const slugify = (name: string) =>
  name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const pasteMessage = (origin: string, code: string) =>
  `Set up SamePage (our team memory) for me. Ask me my name and confirm that this folder holds company work. `
  + `Check that Node 22 or newer is installed and install the LTS if it is not (winget on Windows, Homebrew on macOS); `
  + `on Windows, if npx is not found right after installing Node, use "C:\Program Files\nodejs\npx.cmd" instead. `
  + `Then run: npx -y ${origin}/samepage-setup.tgz --join ${code} --name "<my name>" --folders "<this folder>". `
  + `If it says that name already exists, ask me whether that is me; if yes run it again with --same-person, if not ask me for a different name. `
  + `Tell me in one line what it did, and remind me to open a new session.`;

const CSS = `body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;color:#1f1f1d}
pre{white-space:pre-wrap;background:#f1f0ec;border-radius:8px;padding:12px}code{background:#f1f0ec;padding:1px 4px;border-radius:4px}
button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #bbb;cursor:pointer}.mut{color:#6b6a65}
@media (prefers-color-scheme:dark){body{background:#161615;color:#ecebe6}pre,code{background:#262625}button{background:#1f1f1e;color:inherit;border-color:#3a3936}.mut{color:#a3a29c}}`;

const joinPage = (origin: string, code: string) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join SamePage</title><style>${CSS}</style></head><body>
<h1>Join SamePage</h1>
<p>Paste this message into Claude (desktop app or terminal):</p>
<pre id="msg">${pasteMessage(origin, code)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('msg').textContent).then(() => this.textContent = 'Copied')">Copy</button>
<h2>Prefer the terminal?</h2>
<pre>npx -y ${origin}/samepage-setup.tgz --join ${code}</pre>
<p class="mut">Installs: the SamePage connection for Claude Code, capture hooks, files in ~/.samepage. Undo any time: <code>npx -y ${origin}/samepage-setup.tgz --uninstall</code>.</p>
</body></html>`;

export function joinRoutes(getStore: (env: Env) => Store) {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/:code', async (c) => {
    const code = c.env.JOIN_CODE;
    if (!code || c.req.param('code') !== code) return c.text('not found', 404);
    return c.html(await joinPage(new URL(c.req.url).origin, code), 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  });

  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null) as { code?: unknown; name?: unknown; existing?: unknown } | null;
    if (!c.env.JOIN_CODE || body?.code !== c.env.JOIN_CODE) return c.json({ error: 'invalid join code' }, 403);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length > NAME_MAX) return c.json({ error: 'name is too long' }, 400);
    const id = slugify(name);
    if (!id) return c.json({ error: 'name needs letters or digits' }, 400);

    const store = getStore(c.env);
    const token = newToken();
    const hash = await sha256Hex(token);
    let person = await store.findPersonById(id);
    if (!person) {
      try {
        person = await store.addPerson({ id, name, isSystem: false }, hash);
        return c.json({ id, name: person.name, token, created: true }, 201);
      } catch (e) {
        // A concurrent join with the same name won the primary key.
        person = await store.findPersonById(id);
        if (!person) throw e;
      }
    }
    if (body.existing !== true) return c.json({ id, name: person.name }, 409);
    if (person.isSystem) return c.json({ error: 'cannot join as this member' }, 403);
    await store.addToken(id, hash);
    return c.json({ id, name: person.name, token, created: false });
  });

  return app;
}
