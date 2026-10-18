---
intent: implement
depends_on:
  - foundation.md
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run test:persistence
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Persist accounts, sessions and TODOs in SQLite

## Requirement

Use Node 24's `node:sqlite` behind repositories, with versioned transactional migrations, prepared statements, foreign keys, WAL and a bounded busy timeout. Own the database connection in startup and close it at shutdown. Add `npm run db:migrate` and `npm run test:persistence`.

Create tables `users` with `id`, `email`, `password_hash`, `role`, `created_at`; `sessions` with `id`, `user_id`, `token_hash`, `created_at`, `expires_at`; and `todos` with `id`, `user_id`, `title`, `description`, `completed`, `version`, `created_at`, `updated_at`. Use UUID text identities, UTC ISO-8601 timestamp strings and snake_case domain/JSON fields matching column names. Represent `completed` as a domain boolean and a SQLite integer. A user owns its sessions and TODOs through foreign keys. Keep session secrets and password hashes internal.

Email is trimmed and lowercased before storage and comparison. Email and session token digests are unique. A TODO starts at version 1. Enforce closed values in code, with no SQL CHECK constraints and no non-unique indexes. Primary keys and unique indexes are permitted. Define `UserRole` as the closed code enum `user | admin`. Do not create HTTP endpoints in this node.

## Criterion

- Migrations create a fresh database, preserve existing data on repeated runs, reject unsupported newer schema versions and roll back a failed migration without a partial schema/version update.
- Users, sessions and TODOs survive closing and reopening a file-backed database. Foreign keys reject orphan session/TODO rows.
- Repositories bind every external SQL operand and reject invalid role values, invalid booleans and invalid versions before writes.
- TODO reads/updates/deletes accept the authenticated owner identity as a required operand. Updates atomically require the expected version and increment it once; conflicts change no fields.
- Database writes are short and bounded; no network call or password hashing runs inside a write transaction. Busy contention ends within a configured timeout rather than retrying forever.
- Tests use isolated temporary databases, exercise real SQLite and remove all database/WAL/SHM files after closing connections.
