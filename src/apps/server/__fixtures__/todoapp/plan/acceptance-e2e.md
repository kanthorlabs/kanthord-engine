---
node: acceptance.md
bindings: []
verifications:
  - npm run test:e2e
---

# Exercise the running API as independent clients

## Requirement

Build `test/e2e/todo-api.test.js` and its owned fixtures as a black-box suite around the actual production entrypoint, actual HTTP calls and a real temporary file-backed SQLite database. Wire readiness and shutdown of the production entrypoint to the real migrated SQLite connection. Launch the entrypoint on an ephemeral port. Provision an administrator through the operator path and create two users, Alice and Bob, through HTTP. Test the full lifecycle and access separation.

The `test:e2e` script runs this explicit file and any additional required end-to-end files without silently tolerating their absence. No remote network service, KanthorD database, real credentials or operator database is a test dependency.

## Criterion

- The harness launches the production entrypoint on an ephemeral port with a temporary file-backed database, provisions an administrator through the operator path and creates two users through HTTP. Readiness and shutdown use the real migrated SQLite connection.
- The suite depends on no remote network service, KanthorD database, real credentials or operator database.
- Tests cover registration/login, missing, invalid, expired and revoked sessions, user and admin route policies, two-user TODO isolation, CRUD, filtering, pagination, conditional-write conflict, errors and secret-safe logs.
- Alice registers, logs in, creates and completes a TODO, lists it through pagination and deletes it with the current ETag. Bob and the administrator cannot access Alice's TODO.
- Anonymous requests fail on all private endpoints. A user receives 403 for admin stats; an administrator receives aggregate stats only.
- Two requests sharing a version produce one success and one 412. Invalid bodies, malformed JSON and bad cursors produce safe errors without data changes.
- A process restart against the same temporary database preserves committed accounts, unexpired sessions and TODOs, and preserves logout revocation: a logged-out token remains invalid after restart. Expiry uses a bounded deterministic test mechanism, not an exposed production clock endpoint.
- No production TODO API route exists solely to make a fault test pass.
- Captured process logs contain correlated results but no secret or private-content sentinels. Tests always stop children and remove temporary resources, including on failure.
