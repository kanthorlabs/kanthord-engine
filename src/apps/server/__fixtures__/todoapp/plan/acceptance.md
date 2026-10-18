---
intent: implement
depends_on:
  - todos.md
  - operations.md
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run verify
---

# Verify and document the integrated API release

## Requirement

Integrate the completed Node 24/Express 5/SQLite API. Wire readiness and shutdown to the real migrated SQLite connection. Deliver OpenAPI 3.1, a developer README, an operations runbook, CI and a black-box end-to-end suite. Add `test:acceptance`, `test:e2e` and `verify` scripts. `verify` runs lint, format checks, all six node suites and the end-to-end suite, with no recursive invocation and no silent skipped suites.

Document public GET /health/live and GET /health/ready; public POST /api/v1/auth/register and POST /api/v1/auth/login; private GET /api/v1/auth/me and POST /api/v1/auth/logout; admin GET /api/v1/admin/stats; and owner-only POST/GET /api/v1/todos plus GET/PATCH/DELETE /api/v1/todos/:id. Describe bearer security, exact snake_case fields, validation bounds, pagination, error codes/statuses, conditional ETags, CORS and rate limits. The TODO role of an admin still grants no ownership bypass.

The end-to-end harness launches the production entrypoint on an ephemeral port with a temporary file-backed database, provisions an administrator through the operator path and creates two users through HTTP. No remote network service, KanthorD database, real credentials or operator database is a test dependency.

## Criterion

- One `npm run verify` from a clean installed Node 24 checkout runs every actual suite, fails on a failed check and leaves no open process or test database.
- End-to-end tests cover registration/login, missing/invalid/expired/revoked sessions, user/admin route policies, two-user TODO isolation, CRUD, filtering, pagination, conditional-write conflict, errors and secret-safe logs.
- A process restart against the same temporary database preserves users, unexpired sessions and TODOs, and preserves logout revocation. All resources are cleaned up after the test.
- OpenAPI schema/route coverage checks fail for undocumented routes or mismatched response fields/statuses. Documentation examples are exercised rather than accepted by visual inspection alone.
- CI uses Node 24, `npm ci` and `npm run verify`. It emits test results without secrets and fails on test failures or missing acceptance tests.
- The runbook covers configuration, TLS/proxy trust, initial admin provisioning, migrations, start/stop, readiness, log inspection, backup/restore and SQLite capacity limits. A safe stopped-service backup/restore drill succeeds on a disposable database.
- Review names the tested commit and assesses substantive assertions, not only exit status. No production TODO API route exists solely to make a fault test pass.
