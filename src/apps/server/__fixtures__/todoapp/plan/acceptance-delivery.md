---
node: acceptance.md
bindings: []
verifications:
  - node --test test/acceptance-delivery.test.js
  - npm ci && npm run verify
---

# Make deployment and maintenance reproducible

## Requirement

Provide a developer README, operations runbook and Node 24 CI workflow. Keep the application a single API process on one host with local durable SQLite storage. Document future scaling boundaries without adding distributed infrastructure to this fixture.

Provide the `test:acceptance` script, which runs the acceptance-contract and acceptance-delivery suites, and the `verify` script. `verify` runs lint, format checks, all six node suites and the end-to-end suite. It makes no recursive invocation and skips no suite silently.

## Criterion

- One `npm run verify` from a clean installed Node 24 checkout runs lint, format checks, all six node suites and the end-to-end suite. It fails on a failed check, makes no recursive invocation, skips no suite silently and leaves no open process or test database.
- CI uses Node 24, installs the lockfile with `npm ci` and runs `npm run verify`. It emits test results without secrets and fails on test failures or missing acceptance tests. Tests inspect script/workflow wiring and prove that a deliberately failing fixture returns nonzero rather than being swallowed.
- Startup instructions cover migrations, explicit production configuration, HTTPS termination, allowed origins, trusted proxies and operator-only initial administrator creation.
- The runbook covers configuration, TLS/proxy trust, initial admin provisioning, migrations, start/stop, readiness and liveness, log inspection by request ID, backup/restore and SQLite capacity limits. It describes the ten-second shutdown deadline. Errors and example logs disclose no secrets.
- A disposable test stops the app, checkpoints/closes SQLite, backs up the consistent database, restores to a separate path and verifies accounts/TODOs after restart. It never copies a live main file without its WAL state. This stopped-service backup/restore drill succeeds on a disposable database.
- Document that backups contain sensitive hashes and session digests and require restricted permissions, protected storage and operator-managed retention. Restoring an old backup can restore old session records; the recovery procedure removes all sessions before reopening access.
- Tests execute documented commands where practical and validate their artifacts; merely asserting that documentation files exist is insufficient.
