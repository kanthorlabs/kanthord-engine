# Story 6 — The profile store

Epic: `.agent/plan/epics/103-repository-profile-and-templates.md`
Depends on: EPIC 102 (its `model` capability lands in the same directory list).

## Change

- Add `src/services/profile/index.ts`. It declares the interface only and holds no implementation, because `src/domain/layout.test.ts:159-175` asserts no `src/services/*/index.ts` contains an implementation.
- Import `Transaction` from `../storage/index.ts` with `import type`, exactly as `src/services/plan/index.ts:1` does. The write of Story 7 persists inside the caller's transaction, so the interface names the context.
- Import `ProfileRow` from `../../domain/profile.ts`, which already exists at `src/domain/profile.ts:7-14` with fields `id`, `repositoryId`, `contentBlob` and `updatedAt`.
- Export `interface ProfileStore` with exactly two synchronous methods: `read(transaction: Transaction, repositoryId: string): ProfileRow | null` and `upsert(transaction: Transaction, row: ProfileRow): void`.
- Add `src/services/profile/sqlite.ts` exporting `class SqliteProfileStore implements ProfileStore`. Give it no constructor and no injected dependency, exactly as `SqlitePlanStore` at `src/services/plan/sqlite.ts:115`.
- Declare a module-level `const columns = "id, repository_id, content_blob, updated_at"` and a local snake_case row type, following `src/services/plan/sqlite.ts:17-61`.
- Implement `read` with the statement below, mapping `undefined` to `null`, and mapping snake_case to camelCase through a pure `toProfileRow` helper.

  ```ts
  transaction.get(`SELECT ${columns} FROM profile WHERE repository_id = ?`, [
    repositoryId,
  ]);
  ```

- Implement `upsert` as one `INSERT INTO profile (id, repository_id, content_blob, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET content_blob = excluded.content_blob, updated_at = excluded.updated_at`. The `repository_id` unique constraint at `src/services/storage/migration-0001-core-entities.ts:62` keeps one profile per repository, and the conflict target is that column, not `id`, so an edit moves the pointer and keeps the original row id.
- In `src/domain/layout.test.ts:108-125`, insert `"profile"` between `"plan"` and `"storage"` in the asserted directory list.
- In `src/domain/layout.test.ts:101`, change the test name to `src/services/ holds exactly the sixteen capabilities plus home-lock`. EPIC 102 already changed it to `fifteen` and inserted `"model"` between `"lease"` and `"plan"`; this story adds one name on top of that.

## Constraints

- Do not add a migration. The `profile` table already exists at `src/services/storage/migration-0001-core-entities.ts:60-65`.
- Do not add a `not-implemented.ts`; `src/domain/layout.test.ts:144-157` pins that triple to `agent`, `verify` and `lease`.
- Do not open a transaction inside the store. Every method takes the caller's `Transaction`.
- Do not import another capability's implementation.
- Do not copy `template_id`, `checks` or the schema version onto the row; `docs/proposal/database/profile.md:16` states the document is the one truth.

## Verify

- Add `src/services/profile/sqlite.test.ts` on real temporary SQLite through `createMigratedStorage` of `test/helpers/database.ts:31`, with `seedRegistry` of `test/helpers/rows.ts` to supply the repository and blob rows the foreign keys need, and `after(() => dispose())`.
- Assert `read` returns `null` for a repository with no profile.
- Assert `upsert` then `read` returns a row deep-equal to the written row, with `updatedAt` an integer and `contentBlob` the exact `sha256:` string.
- Assert a second `upsert` for the same `repositoryId` with a different `contentBlob` leaves exactly one `profile` row, keeps the original `id`, and returns the new `contentBlob` and `updatedAt`.
- Assert an `upsert` for a second repository creates a second row, so `SELECT COUNT(*) FROM profile` equals `2`.
- Assert the written row parses through `profileRow` of `src/domain/profile.ts`.
- Run `node --test src/services/profile/sqlite.test.ts src/domain/layout.test.ts`; both exit 0.
- Run `npm run verify`; it exits 0.
- Proof: EPIC Proof line 47.
