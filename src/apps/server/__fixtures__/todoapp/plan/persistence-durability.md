---
node: persistence.md
bindings: []
verifications:
  - node --test test/persistence-durability.test.js
---

# Preserve committed data and bound write contention

## Requirement

Make persistence behavior observable under reopen, rollback and concurrent writes. Keep transactions synchronous and short around SQLite work. Run no network call and no password hashing inside a write transaction. Translate lock exhaustion to an explicit repository error for the HTTP layer. Busy contention ends within the configured timeout and never retries forever.

## Criterion

- A real file-backed test writes accounts, sessions and TODOs, closes the connection, reopens it and verifies identical committed values.
- A failed multi-write transaction leaves none of its partial rows.
- Two updates with the same expected version yield one winner, one conflict and a single version increment.
- Database writes are short and bounded. No network call or password hashing runs inside a write transaction.
- An independent connection/process holding a write lock causes bounded failure within the configured timeout, with no partial write and no endless retry. Tests have explicit deadlines and release locks in cleanup.
- Tests use isolated temporary databases and exercise real SQLite. Every test closes connections before it removes temporary directories, and removes all database, WAL and SHM files.
