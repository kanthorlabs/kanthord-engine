---
intent: examine
depends_on:
  - foundation.md
  - persistence.md
  - authentication.md
  - todos.md
  - operations.md
  - acceptance.md
  - contributing.md
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run verify
---

# Deliver a secure, maintainable TODO REST API

## Requirement

Deliver a Node.js 24 and SQLite TODO API using Express 5 and ecosystem middleware. Account holders authenticate, manage only their own TODOs and receive predictable JSON errors. Operators can diagnose failures without exposing secrets and can run the service from a clean checkout.

This examine node integrates the outcomes of its direct dependencies and does not repeat their implementation. Check out the base-branch head of its `todoapp-repo` binding. Judge the final repository snapshot and the current outcome of each direct dependency; publish an addressed integration report as produced evidence.

## Criterion

- Every direct dependency is `Completed` with a successful current outcome. A discarded dependency satisfies nothing, so this examine node stays `Pending` until a human removes that dependency.
- A clean Node 24 checkout installs from its lockfile and passes every node suite, the integrated end-to-end suite, lint and formatting through `npm run verify`.
- Two users can register, log in and persist private TODOs across a process restart. Neither user can read or mutate the other's TODOs. Logout and expiry revoke access.
- Public health and authentication routes work without a token; private and admin-only routes enforce their documented policies. Invalid inputs, unavailable storage and unexpected exceptions produce safe, correlated errors.
- OpenAPI and the runbook match the running API. Production secrets and user content never enter logs. SQLite's single-host, single-writer limits are explicit.
- The integration report identifies the tested commit, verification results and the outcome of each direct dependency. A passing command alone does not replace review of test adequacy or security behavior.
