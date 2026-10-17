---
node: persistence.md
bindings: []
verifications:
  - node --test test/persistence-migrations.test.js
---

# Maintain transactional SQLite migrations

## Requirement

Use Node 24's `node:sqlite` behind repositories. Provide a versioned migration runner and explicit database connection owner. Startup opens the connection and shutdown closes it. Set foreign keys on every connection, use WAL for file-backed databases and bound lock waits with a busy timeout. Keep migration code separate from HTTP routing. Add `npm run db:migrate`.

Create these tables. `users` has `id`, `email`, `password_hash`, `role`, `created_at`. `sessions` has `id`, `user_id`, `token_hash`, `created_at`, `expires_at`. `todos` has `id`, `user_id`, `title`, `description`, `completed`, `version`, `created_at`, `updated_at`. Store `completed` as a SQLite integer. A user owns its sessions and TODOs through foreign keys. Make `users.email` and `sessions.token_hash` unique. Declare no SQL CHECK constraint and no non-unique index. Primary keys and unique indexes are permitted.

## Criterion

- Tests cover initialization of a fresh empty database, repeated migration, an older supported fixture, newer-version refusal and rollback of an injected failed migration. A failed migration leaves no partial schema or version update.
- Repeated runs preserve existing data. The migration ledger changes atomically with its migration. Existing rows remain unchanged by a no-op run.
- `npm run db:migrate` migrates the configured database.
- The schema has tables `users`, `sessions` and `todos` with exactly the columns in the requirement. Unique indexes cover email and token digest.
- Tests inspect actual connection settings (foreign keys, WAL, busy timeout) and prove orphan session and TODO rows fail under foreign-key enforcement.
- Startup opens the connection and shutdown closes it. Startup cannot serve with a partially applied schema.
- No SQL CHECK constraint or non-unique index is declared.
