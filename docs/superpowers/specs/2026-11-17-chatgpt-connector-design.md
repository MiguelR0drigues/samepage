# ChatGPT connector (OAuth for /mcp)

## Intent

Teammates who use both Claude Code (coding) and ChatGPT in the browser (brainstorming) get the same team memory in both, as the same person. Example: Pedro codes in Claude Code and brainstorms in ChatGPT; what he records in one shows up in the other.

## Goals

- ChatGPT (developer mode, custom connector) can connect to `/mcp` via OAuth.
- The ChatGPT connection authenticates as an existing person; no duplicate people.
- In ChatGPT the teammate can search and read freely, and records only when they ask.

## Non-goals

- Automatic capture of ChatGPT conversations (no hooks there; would need a browser extension or export import). Later, if wanted.
- Onboarding people who never used Claude Code / the dashboard.
- Expiring access tokens / refresh tokens.

## Anti-goals

- Widening impersonation risk: connecting must require proof of being that person, not just the team join code.
- Changing how Claude Code clients authenticate.

## Constraints

- Cloudflare Worker, no new storage bindings (no KV), no new dependencies.
- ChatGPT custom connectors need a paid plan with developer mode; writes may ask the user to confirm.
- The dashboard session cookie is scoped to `/dashboard`.

## Approaches

- **A. Dashboard login + minimal hand-rolled OAuth (chosen).** Consent page reuses the dashboard session; codes are signed JWTs; the issued access token is an ordinary person token. No new storage, `/mcp` auth unchanged. Trade-off: no token expiry; revoke like today.
- B. Same, but log in with team join code + name. Rejected: anyone with the code could connect as someone else.
- C. Cloudflare `workers-oauth-provider`. Rejected: needs KV, a dependency and more self-hosting steps for a small team.

## Design

1. **Discovery (public):**
   - `GET /.well-known/oauth-protected-resource` → `{ resource: <origin>/mcp, authorization_servers: [<origin>] }`.
   - `GET /.well-known/oauth-authorization-server` → issuer, `authorization_endpoint` (`/dashboard/oauth/authorize`), `token_endpoint` (`/oauth/token`), `registration_endpoint` (`/oauth/register`), `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code"]`, `response_types_supported: ["code"]`, `token_endpoint_auth_methods_supported: ["none"]`.
   - The bearer middleware's 401 adds `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
2. **Registration (public, stateless):** `POST /oauth/register` validates `redirect_uris` (https only) and returns `client_id` = JWT signed with `DASHBOARD_SECRET` carrying the redirect URIs and client name. Nothing is stored.
3. **Authorize (`/dashboard/oauth/authorize`, under the dashboard so the session cookie is sent):** verifies `client_id` and that `redirect_uri` is in it, requires PKCE S256. No session → page saying to ask Claude Code "open the dashboard", then reload. With session → consent page "Connect <client name> (<redirect host>) as <person name>? [Allow] [Cancel]". Allow (POST, same-origin) → redirect with `code` = short-lived (5 min) signed JWT carrying person id, redirect URI, code challenge, client id; plus `state`.
4. **Token (`POST /oauth/token`, public):** verifies the code JWT, redirect URI, client id and PKCE verifier; mints a random token, stores its hash with `addToken`, returns `{ access_token, token_type: "Bearer" }`. Code replay is accepted as a known limit (5-minute window, PKCE-bound; each redemption only adds another token for the same person).
5. **Tools:** add `readOnlyHint: true` annotations to read-only tools (`search_context`, `list_decisions`, `list_team`, `list_workstreams`, `pending`) so ChatGPT doesn't ask to confirm searches. ChatGPT records use source `explicit`.
6. **Docs:** a README section "Using SamePage from ChatGPT" (enable developer mode, add connector with `<origin>/mcp`, sign in).

## Left to the builder

- Exact page copy and styling (reuse the dashboard look).
- Tests for discovery, register, authorize (with/without session), token (PKCE ok/bad, wrong redirect, expired code), and the 401 header.
