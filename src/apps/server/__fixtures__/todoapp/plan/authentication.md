---
intent: implement
depends_on:
  - persistence.md
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run test:authentication
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Authenticate users and authorize private routes

## Requirement

Provide public `POST /api/v1/auth/register` and `POST /api/v1/auth/login`, private `GET /api/v1/auth/me` and `POST /api/v1/auth/logout`, and admin-only `GET /api/v1/admin/stats`. Use Zod strict request schemas and asynchronous scrypt password hashing with unique random salts and timing-safe comparison. Use at least N=131072, r=8, p=1 with sufficient explicit memory allowance; store algorithm, parameters, salt and derived key in `password_hash`.

Issue an opaque 32-byte cryptographically random bearer `access_token` at login, return `token_type: "Bearer"` and `expires_at`, and store only its SHA-256 digest in `sessions.token_hash`. Read session expiry and current user role on every private request. No cookie authentication, refresh token, or JWT is needed. TLS terminates at the documented production proxy.

Registration accepts only `email` and `password`, normalizes email by trimming/lowercasing, creates role `user`, returns 201 with safe user fields and no session. Email is valid and at most 254 characters; password is 12 through 128 characters and at most 512 UTF-8 bytes, never trimmed or normalized. Duplicate email returns 409. Login returns 200; unknown email and incorrect password return the same safe 401 error, with a dummy hash comparison for unknown accounts.

Provision the initial administrator through a documented operator-only CLI reading a password from hidden input or stdin, never a command argument or log. No HTTP route can choose or change role. Admin stats return only aggregate `user_count` and `todo_count`. Use `user` and `admin` as the closed code enum. Create `src/modules/auth` and `src/modules/admin` with their code. Add `test:authentication`.

## Criterion

- Strict schemas reject unknown properties including `role`, `user_id` and stored-secret fields with 400; failed registration writes no account/session.
- Missing, malformed, unknown, expired or revoked bearer credentials return 401 with `WWW-Authenticate: Bearer` on private routes. Failed credentials never fall through as an authenticated user.
- `/auth/me` returns only `id`, `email`, `role`, `created_at`; logout returns 204 and physically removes the current session. A later use of that token returns 401; other sessions remain valid.
- Anonymous admin access returns 401; authenticated non-admin access returns 403; an administrator receives only the documented aggregate fields.
- Tokens and password hashes are absent from logs and ordinary user responses. The login response carries `Cache-Control: no-store`.
- Tests cover two accounts, multiple sessions, expiry at the exact deadline with an injected clock, logout, role escalation attempts and direct unauthenticated requests to every private route implemented here.
