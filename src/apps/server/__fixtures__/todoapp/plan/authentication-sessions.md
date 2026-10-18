---
node: authentication.md
bindings: []
verifications:
  - node --test test/authentication-sessions.test.js
  - npm ci && npm run test:authentication
  - npm run test:persistence
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Enforce expiring and revocable bearer sessions

## Requirement

Issue an opaque 32-byte cryptographically random bearer `access_token` at successful login. Return `token_type: "Bearer"` and `expires_at`. Persist only its SHA-256 digest in `sessions.token_hash`. Provide private `GET /api/v1/auth/me` and `POST /api/v1/auth/logout`. Authenticate each private request by the persisted session, its expiry and the current account. Read session expiry on every private request. Keep session creation separate from password hashing transactions.

Use no cookie authentication, no refresh token and no JWT. Document that TLS terminates at the production proxy. Provide the `test:authentication` script, which runs the three authentication suites.

## Criterion

- Login returns `access_token` (32 random bytes, opaque), `token_type: "Bearer"` and `expires_at` with `Cache-Control: no-store`. The database stores only the SHA-256 digest in `sessions.token_hash`. The database and logs never contain the raw token.
- Missing, malformed, unknown, expired and revoked credentials return 401 with `WWW-Authenticate: Bearer` on private routes. At `now == expires_at`, access is refused. Failed credentials never fall through as an authenticated user.
- `/auth/me` returns only `id`, `email`, `role`, `created_at` of the authenticated user, not client-supplied identity values.
- Logout returns 204 and physically removes only the current session. Reusing that token, including after a process/database reopen, returns 401. Other sessions remain valid.
- Authentication uses no cookie, refresh token or JWT. Tokens are absent from logs and ordinary user responses.
- Tests cover two accounts, multiple sessions per account, expiry at the exact deadline with an injected clock, and logout. They exercise actual signed-out and signed-in HTTP requests with separate tokens for two accounts, without sleeping to test expiry.
