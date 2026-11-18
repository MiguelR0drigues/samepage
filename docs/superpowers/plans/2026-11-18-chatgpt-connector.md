# ChatGPT Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ChatGPT (developer mode, custom connector) can connect to `/mcp` via OAuth as an existing team member.

**Architecture:** A minimal, stateless OAuth 2.1 authorization server inside the Worker. Client ids and authorization codes are HS256 JWTs signed with `DASHBOARD_SECRET`; consent reuses the dashboard session cookie (so it lives under `/dashboard`); the token endpoint mints an ordinary person token via `store.addToken`, so the `/mcp` bearer check is unchanged.

**Tech Stack:** Hono, `hono/jwt`, Web Crypto, Vitest with the existing test DB helper.

**Spec:** `docs/superpowers/specs/2026-11-17-chatgpt-connector-design.md`

## Global Constraints

- No new dependencies, no new storage bindings (no KV), no schema migration.
- Reuse `DASHBOARD_SECRET`; when it is unset, OAuth endpoints answer 404 (`{ error: 'oauth not configured' }`) and never throw.
- PKCE `S256` only; `token_endpoint_auth_methods_supported: ["none"]`; grant `authorization_code` only; no refresh tokens.
- Only `https:` redirect URIs are registrable.
- Authorization codes live 300 s.
- All product text in English.
- Claude Code clients (static bearer tokens) must keep working unchanged.

## Review Focus

1. ChatGPT asks for path-suffixed metadata (`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/mcp`) → served the same as the bare paths (Task 1).
2. Authorize with a `redirect_uri` not in the client id → error page, no redirect (open redirect) (Task 2).
3. A code redeemed with another `client_id`, another `redirect_uri` or a wrong verifier → `invalid_grant`, no token stored (Task 3).
4. The person behind a code became a system actor or no longer exists → `invalid_grant` (Task 3).
5. `DASHBOARD_SECRET` unset → 404 JSON from metadata/register/token, not a 500 (Task 1, Task 3).

---

### Task 1: Discovery metadata, client registration, 401 hint

**Files:**
- Create: `src/http/oauth.ts`
- Modify: `src/http/app.ts` (mount public routes before the bearer middleware; add `WWW-Authenticate` on its 401)
- Test: `tests/http/oauth.test.ts`

**Interfaces:**
- Produces (in `src/http/oauth.ts`):
  - `CODE_TTL_S = 300`
  - `issueClientId(c: { redirectUris: string[]; name: string }, secret: string): Promise<string>`
  - `readClientId(id: string, secret: string): Promise<{ redirectUris: string[]; name: string } | null>` (JWT `kind: 'client'`)
  - `issueCode(c: { personId: string; clientId: string; redirectUri: string; challenge: string }, secret: string): Promise<string>` (JWT `kind: 'code'`, `exp = now + CODE_TTL_S`)
  - `readCode(code: string, secret: string): Promise<{ personId: string; clientId: string; redirectUri: string; challenge: string } | null>`
  - `s256(verifier: string): Promise<string>` (base64url, no padding, of SHA-256)
  - `oauthRoutes(): Hono<{ Bindings: Env }>` mounted at `/` in `createApp`

- [ ] **Step 1: Write the failing tests** (`tests/http/oauth.test.ts`, same setup as `tests/http/app.test.ts`, env `ENV` from `tests/dashboard/helpers`)

```ts
it('serves protected-resource metadata, bare and path-suffixed', async () => {
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    expect(await (await app.request(`http://t${p}`, {}, ENV)).json())
      .toEqual({ resource: 'http://t/mcp', authorization_servers: ['http://t'] });
  }
});
it('serves authorization-server metadata, bare and path-suffixed', async () => {
  const m = await (await app.request('http://t/.well-known/oauth-authorization-server/mcp', {}, ENV)).json();
  expect(m).toMatchObject({ issuer: 'http://t', authorization_endpoint: 'http://t/dashboard/oauth/authorize',
    token_endpoint: 'http://t/oauth/token', registration_endpoint: 'http://t/oauth/register',
    code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'],
    response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'] });
});
it('registers an https client statelessly', async () => {
  const res = await app.request('http://t/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/cb'] }) }, ENV);
  expect(res.status).toBe(201);
  const b = await res.json() as { client_id: string };
  expect(await readClientId(b.client_id, ENV.DASHBOARD_SECRET)).toEqual({ redirectUris: ['https://chatgpt.com/cb'], name: 'ChatGPT' });
});
it('rejects non-https or missing redirect URIs with invalid_redirect_uri (400)', ...); // ['http://evil'], [], absent
it('answers 404 JSON when DASHBOARD_SECRET is unset', ...); // metadata and register with { DATABASE_URL: '' }
it('401 from /mcp names the resource metadata', async () => {
  const res = await app.request('http://t/mcp', {}, ENV);
  expect(res.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://t/.well-known/oauth-protected-resource"');
});
it('s256 matches the RFC 7636 example', async () => {
  expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
```

- [ ] **Step 2: Run** `npx vitest run tests/http/oauth.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/http/oauth.ts` with the interfaces above and the metadata/register routes. Default `client_name` to `'An app'`. Origin comes from `new URL(c.req.url).origin`. In `app.ts`, `app.route('/', oauthRoutes())` right after `/join`, and the bearer middleware's 401 sets the `WWW-Authenticate` header shown in the test.
- [ ] **Step 4: Run** `npx vitest run tests/http` — Expected: PASS (existing app tests too).
- [ ] **Step 5: Commit** `feat(oauth): discovery metadata and stateless client registration`

### Task 2: Consent page under the dashboard

**Files:**
- Modify: `src/dashboard/routes.ts` (two routes after the session middleware; `SIGN_IN` copy)
- Modify: `src/dashboard/pages.ts` (add `consentPage`)
- Test: `tests/dashboard/oauth.test.ts`

**Interfaces:**
- Consumes: `readClientId`, `issueCode` from Task 1; `signIn`, `get`, `post`, `ENV` from `tests/dashboard/helpers.ts`.
- Produces: `GET /dashboard/oauth/authorize`, `POST /dashboard/oauth/authorize`; `consentPage(v: Viewer, a: { clientName: string; redirectHost: string; params: Record<string, string> }): Promise<Response>`.

Query/form params: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state` (optional; echoed back). Other params (`scope`, `resource`) are ignored.

- [ ] **Step 1: Write the failing tests** (helper `authorizeUrl(overrides)` builds a valid URL from a client registered with `issueClientId({ redirectUris: ['https://chatgpt.com/cb'], name: 'ChatGPT' })`)

```ts
it('without a session, asks to sign in through the agent and reload', async () => {
  const res = await app.request(authorizeUrl(), {}, ENV);
  expect(res.status).toBe(401);
  expect(await res.text()).toContain('then reload this page');
});
it('with a session, shows who connects what', async () => {
  const body = await (await get(app, authorizeUrl(), cookie)).text();
  for (const s of ['ChatGPT', 'chatgpt.com', 'Miguel', 'Allow', 'Cancel']) expect(body).toContain(s);
});
it('Allow redirects with a code for this person and the state', async () => {
  const res = await post(app, '/dashboard/oauth/authorize', cookie, { ...validParams, decision: 'allow' });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe('https://chatgpt.com/cb');
  expect(loc.searchParams.get('state')).toBe('xyz');
  expect(await readCode(loc.searchParams.get('code')!, ENV.DASHBOARD_SECRET)).toMatchObject({ personId: 'miguel', redirectUri: 'https://chatgpt.com/cb' });
});
it('Cancel redirects with error=access_denied and the state', ...);
it('an unregistered redirect_uri shows an error page and never redirects (GET and POST)', ...); // status 400, no location header
it('rejects a bad client_id, missing code_challenge or a method other than S256 with a 400 page', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/dashboard/oauth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** One shared validator in `routes.ts` turns the params into `{ client, redirectUri, challenge, state }` or a `message(400, …)`; both routes use it. `SIGN_IN` becomes `'Sign in by asking your agent to open the dashboard (open_dashboard tool), then reload this page.'`. `consentPage` reuses the dashboard look (`message`-style card) with a POST form carrying the params as hidden inputs and two submit buttons `name="decision"` `value="allow"|"cancel"`. The existing `csrf()` middleware already covers the POST.
- [ ] **Step 4: Run** `npx vitest run tests/dashboard` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(oauth): consent page reuses the dashboard session`

### Task 3: Token endpoint

**Files:**
- Modify: `src/http/oauth.ts` (add `POST /oauth/token`)
- Test: `tests/http/oauth.test.ts`

**Interfaces:**
- Consumes: `readCode`, `s256`, `readClientId` (Task 1); `newToken` from `src/http/join.ts`; `sha256Hex` from `src/http/app.ts`; `store.findPersonById`, `store.addToken`.
- Produces: `POST /oauth/token`, body `application/x-www-form-urlencoded` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`. Success 200 `{ access_token, token_type: 'Bearer' }` with `Cache-Control: no-store`. Errors 400 `{ error: 'invalid_grant' | 'invalid_request' | 'unsupported_grant_type' }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('exchanges a valid code for a token that works on /mcp as that person', async () => {
  // code from issueCode({ personId: 'miguel', clientId, redirectUri, challenge: await s256(verifier) })
  const res = await token({ code, redirect_uri, client_id, code_verifier: verifier });
  expect(res.status).toBe(200);
  const { access_token, token_type } = await res.json();
  expect(token_type).toBe('Bearer');
  const client = await connect(access_token, ENV);       // same helper as app.test.ts
  expect(text(await client.callTool({ name: 'list_team', arguments: {} }))).toContain('miguel');
});
it('the Claude Code token keeps working after a ChatGPT connection', ...); // t-miguel still authenticates
it('invalid_grant for a wrong verifier, other client_id, other redirect_uri, expired or tampered code', ...); // vi.setSystemTime past CODE_TTL_S for expiry; no token added
it('invalid_grant when the person is gone or is a system actor', ...);
it('unsupported_grant_type for refresh_token; invalid_request when a field is missing', ...);
it('404 JSON when DASHBOARD_SECRET is unset', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/http/oauth.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the route: parse the form with `c.req.parseBody()`, check grant type, read the code, compare `client_id` and `redirect_uri`, compare `await s256(code_verifier)` with the challenge, load the person (must exist and `!isSystem`), `token = newToken()`, `await store.addToken(person.id, await sha256Hex(token))`. Codes are not single-use (accepted in the spec: 5-minute, PKCE-bound window).
- [ ] **Step 4: Run** `npx vitest run tests/http` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(oauth): token endpoint mints a person token`

### Task 4: Read-only tool hints, company-only recording, README

Chat apps like ChatGPT reliably read tool descriptions, not always server instructions, and a ChatGPT conversation is often not about the company. So the "only about the company" rule moves into the `record` description, with the company's name.

**Files:**
- Modify: `src/mcp/server.ts` (`annotations: { readOnlyHint: true }` on `search_context`, `list_decisions`, `list_team`, `list_workstreams`, `pending`; `buildMcpServer(..., company?: string)`; company rule in `record` description and `INSTRUCTIONS`)
- Modify: `src/http/app.ts` (`Env.COMPANY_NAME?: string`, passed to `buildMcpServer`)
- Modify: `README.md` (self-hosting: optional `COMPANY_NAME` var in `wrangler.toml` `[vars]`; section "Using SamePage from ChatGPT" after "Talking to it"; roadmap item "ChatGPT" checked)
- Test: `tests/http/app.test.ts`

**Interfaces:**
- Produces: `buildMcpServer(store, actor, summary, openDashboard, company = 'the company')`. With `COMPANY_NAME=Scooli` the `record` description contains: `Only information about Scooli (its product, team, decisions and work); never personal matters or other topics. If asked to save something that is not about Scooli, do not call this tool; say why.`

- [ ] **Step 1: Write the failing tests**

```ts
it('marks read-only tools so ChatGPT does not ask to confirm them', async () => {
  const { tools } = await (await connect('t-miguel')).listTools();
  const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  expect(ro).toEqual(['list_decisions', 'list_team', 'list_workstreams', 'pending', 'search_context']);
});
it('the record tool names the company and refuses other topics', async () => {
  const { tools } = await (await connect('t-miguel', { ...ENV, COMPANY_NAME: 'Scooli' })).listTools();
  expect(tools.find((t) => t.name === 'record')!.description).toContain('Only information about Scooli');
});
it('without COMPANY_NAME it says "the company"', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/http/app.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the annotations and the company rule. README section, short: needs a paid ChatGPT plan with developer mode; Settings → Apps/Connectors → add `https://<your-worker>/mcp` with OAuth; sign in to the dashboard first (ask Claude Code "open the dashboard"), then Allow; in ChatGPT it records only when you ask, only about the company (ChatGPT also asks you to confirm each save); no automatic capture there.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(mcp): read-only hints; docs: using SamePage from ChatGPT`
