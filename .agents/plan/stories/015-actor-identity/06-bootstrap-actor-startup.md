# Story 6 — The bootstrap actor and the startup order

Epic: `.agents/plan/epics/015-actor-identity.md`
Depends on: Story 3 (the `actor` table and its bootstrap row).

## Change

- Create `src/commands/startup/ensure-bootstrap-actor.ts`.

  ```ts
  export type EnsureBootstrapActorDependencies = Readonly<{ storage: Storage }>;

  export type EnsureBootstrapActorInput = Readonly<{ actor: string }>;

  export type EnsureBootstrapActorResult = Readonly<{
    name: string;
    changed: boolean;
  }>;

  export function ensureBootstrapActor(
    dependencies: EnsureBootstrapActorDependencies,
    input: EnsureBootstrapActorInput,
  ): EnsureBootstrapActorResult;
  ```

- The body opens one `storage.transact` and runs these steps in order.
  1. `SELECT id FROM actor WHERE name = ?` with `input.actor`.
  2. When a row exists and its `id` **is** `bootstrapActorId`, return `{ name: input.actor, changed: false }`. The name is already correct.
  3. When a row exists and its `id` is **not** `bootstrapActorId`, throw `EnsureBootstrapActorError` with the refusal `"actor-name-taken"` and a message that names both `input.actor` and the conflicting actor id. `name` is `UNIQUE`, and a silent collision would attribute two identities to one name.
  4. Otherwise `UPDATE actor SET name = ? WHERE id = ?` with `input.actor` and `bootstrapActorId`, and return `{ name: input.actor, changed: true }`.
- Export `export class EnsureBootstrapActorError extends Error` from the same file, carrying a `readonly refusal: "actor-name-taken"` field, following the shape of `RegisterProviderError` in `src/commands/provider/register-provider.ts`.
- The bootstrap row is **exempt from `actorNamePattern`**. It stores `settings.actor` verbatim, so an existing configured name such as `Ulrich` or `tuan.nguyen` never fails startup. Do not validate `input.actor` against the pattern here.
- `src/main.ts`: call `ensureBootstrapActor` inside `serve()`, **after** the `assertMigrated` gate at `:157-160` and **before** the `recoverHome` call at `:167`. Pass `{ storage }` and `{ actor: settings.actor }`. Let `EnsureBootstrapActorError` propagate; the existing `catch` around `serve()` reports it and exits non-zero, the same path `StartupError` takes.

## Constraints

- The order is load-bearing: the transport must never listen against a bootstrap row that names the wrong human. Place the call after the migration gate, because the `actor` table does not exist before migration 0005 is applied.
- `src/commands/` may not import `node:sqlite`, `node:fs` or any vendor package (`eslint.config.js:250-274`). Every read and write goes through the `Storage` interface.
- Append **no event**. The bootstrap name is configuration, not a decision, and no actor exists yet to attribute the write to.
- Write only the `name` column. Do not touch `token_sha256`, `created_at` or any other column of the bootstrap row.
- `src/commands/` files may not import another module in their own directory (`src/domain/layout.test.ts:177-207`), so do not import `recover-home.ts` here.

## Verify

- Create `src/commands/startup/ensure-bootstrap-actor.test.ts`, suite name `src/commands/startup/ensure-bootstrap-actor.test`, on **real SQLite** through `createMigratedStorage()`:
  - On a freshly migrated database, `ensureBootstrapActor({ storage }, { actor: "ulrich" })` returns `{ name: "ulrich", changed: true }`, and the row whose `id` is `bootstrapActorId` then has `name === "ulrich"`. Its `kind`, `token_sha256`, `registered_by` and `created_at` are unchanged, asserted column by column.
  - A second call with the same name returns `changed: false` and writes nothing, asserted by comparing the whole row before and after.
  - A call with a name that a **registered harness** already holds throws `EnsureBootstrapActorError` with `refusal === "actor-name-taken"`, and the message includes the conflicting actor id. Seed the harness row by direct `INSERT`. Assert the bootstrap row's `name` is unchanged after the throw.
  - A name outside `actorNamePattern`, such as `"Ulrich"` and `"tuan.nguyen"`, is accepted and written, so an existing configured name starts the daemon.
  - The `actor` table still holds exactly the expected number of rows in every case.
- `src/main.test.ts`: add a case asserting **`ensureBootstrapActor` runs before `recoverHome`**. Read the source of `src/main.ts` with `readFileSync` and assert `indexOf("ensureBootstrapActor(")` is greater than `indexOf("assertMigrated(")` and less than `indexOf("recoverHome(")`. This is the same by-construction technique `src/http/server/auth.test.ts:78-83` uses.
- `src/main.test.ts`: add a case asserting that a daemon whose configured `actor` names a registered harness refuses to start, and that the printed refusal names the conflicting actor id. Drive it through `launchDaemon` from `test/helpers/daemon.ts` against a home whose database was seeded with that harness row, and assert the process exits non-zero.
- Run `node --test --test-timeout=60000 src/commands/startup/ensure-bootstrap-actor.test.ts src/main.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage line 148.
