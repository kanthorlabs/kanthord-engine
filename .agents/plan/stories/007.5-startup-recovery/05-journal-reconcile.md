# Story 05 — Local journal reconcile

Epic: `.agents/plan/epics/007.5-startup-recovery.md`
Depends on: Story 01 (`GitJournal`), Story 03 (`src/domain/recovery.ts`).

## Change

- **New file `src/commands/startup/reconcile-journal.ts`.**

  ```ts
  export type ReconcileJournalDependencies = Readonly<{
    storage: Storage;
    journal: GitJournal;
    git: Git;
    events: EventLog;
    clock: Clock;
  }>;

  export type ReconcileJournalInput = Readonly<{ actor: string }>;

  export type ReconcileJournalResult = Readonly<{
    completed: number;
    discarded: number;
    leftOpen: number;
    refusesNewWork: readonly string[];
    findings: readonly RecoveryFinding[];
  }>;

  export async function reconcileJournal(
    dependencies: ReconcileJournalDependencies,
    input: ReconcileJournalInput,
  ): Promise<ReconcileJournalResult>;
  ```

- **The row set.** One `storage.transact` calling `dependencies.journal.listOpen(transaction)`, already `ORDER BY o.id`. Every row is resolved in that order, one row at a time.

- **A `publish` row.** It needs the network, and startup does not wait for it (`docs/proposal/phase-3/recovery.md:89`). Steps:

  1. One `storage.transact` calling `dependencies.journal.markPublishPending(transaction, { id: row.id, outcome: "awaiting-remote-reconcile" })` and appending

     ```
     subjectKind: "repository", subjectId: row.repositoryId,
     type: "recovery.publishReconcilePending", actorKind: "daemon", actorId: input.actor,
     payload: { gitOperationId: row.id, ref: row.ref, proposedHeadOid: row.proposedHeadOid }
     ```

  2. `row.repositoryId` joins `refusesNewWork`, and `leftOpen` increments.
  3. No `git ls-remote` runs. No `Git` member is called for a `publish` row at all.

- **A `merge`, `sync` or `revert` row.** The ref is read once, and the reading decides the row. `docs/proposal/phase-3/recovery.md:77-83` is the matrix and this is its exact encoding.

  `observed = await dependencies.git.resolveRef({ gitDir: row.repositoryHomePath, ref: row.ref })`.

  | `observed`            | action                                                                                                                                                                                                                                  |
  | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `row.proposedHeadOid` | `journal.complete(transaction, { id, resultHeadOid: observed, outcome: "recovered-complete", completedAt: clock.now() })`; `completed` increments                                                                                       |
  | `row.baseOid`         | `journal.discard(transaction, { id, outcome: "recovered-discarded", completedAt: clock.now() })`; `discarded` increments                                                                                                                |
  | `null`                | `journal.discard(transaction, { id, outcome: "recovered-absent", completedAt: clock.now() })`; `discarded` increments. When `row.baseOid !== ZERO_OID`, add a finding with `code: "ref-absent-with-base"`                               |
  | anything else         | `journal.clearChildToken(transaction, { id })` only. The row stays `open`, `leftOpen` increments, `row.repositoryId` joins `refusesNewWork`, and a finding with `code: "ref-unexpected"` is added. No retry, and no second `resolveRef` |

  A `GitError` thrown by `resolveRef` throws `RecoveryError("ref-unreadable", \`the ref ${row.ref} of repository ${row.repositoryId} could not be read\`)`. It names the repository, which is what `docs/proposal/phase-3/recovery.md:83` requires.

  Each of the four outcomes runs in **one** `storage.transact` that also appends

  ```
  subjectKind: "repository", subjectId: row.repositoryId,
  type: "recovery.journalReconciled", actorKind: "daemon", actorId: input.actor,
  payload: { gitOperationId: row.id, intent: row.intent, ref: row.ref, observed, verdict }
  ```

  where `verdict` is `"complete" | "discarded" | "absent" | "unexpected"`. `observed` is the string or `null`, written as read.

- **`refusesNewWork` is deduplicated and bytewise sorted** before it is returned, with `Buffer.compare`. A repository holding two open rows appears once.

- **New file `src/commands/repository/assert-repository-accepts-work.ts`.** The refusal the EPIC requires, as a verdict rather than a throw, because `assert-no-outside-writer.ts` set that precedent in EPIC 007.

  ```ts
  export type RepositoryWorkVerdict =
    | Readonly<{ accepts: true }>
    | Readonly<{
        accepts: false;
        reason: "publish-reconcile-pending";
        gitOperationId: string;
      }>;

  export const OPEN_PUBLISH_SQL =
    "SELECT id FROM git_operation WHERE repository_id = ? AND intent = 'publish' AND state = 'open' ORDER BY id LIMIT 1";

  export function assertRepositoryAcceptsWork(
    transaction: Transaction,
    input: Readonly<{ repositoryId: string }>,
  ): RepositoryWorkVerdict;
  ```

  It runs `OPEN_PUBLISH_SQL`, returns `{ accepts: true }` on `undefined`, and otherwise `{ accepts: false, reason: "publish-reconcile-pending", gitOperationId }`. It writes nothing and throws nothing.

## Constraints

- The ref is read **once per row**. A second read would let two readings disagree, which is the defect `docs/proposal/phase-3/recovery.md:75` forbids.
- A `publish` row never reaches `resolveRef`. `row.ref` for a `publish` names a remote ref (`docs/proposal/database/git_operation.md:45`), and resolving it locally would read the wrong thing.
- `Transaction` is synchronous. Every `resolveRef` await sits outside `storage.transact`, and each row's writes are one transaction so the state change and its event commit together, as `docs/proposal/phase-1/domain.md` requires.
- `assertRepositoryAcceptsWork` has **no production call site in phase 1**, because no phase-1 command writes to an already registered repository. It is owned and proved here rather than left unowned. See B3 in `index.md`.
- `src/commands/repository/assert-repository-accepts-work.ts` must relative-import no other `src/commands/` module (`src/domain/layout.test.ts:175-189`).
- Add no column, no migration, no configuration key, no HTTP error code and no contract entry. `src/http/contract/errors.ts` already holds `needs-reconcile` at `409`, and this story does not use it: the repository `state` enum is `["ready","needs-reconcile"]` with a refinement tying `needs-reconcile` to two non-null diverged oids (`src/domain/repository.ts:23-31`), and an open `publish` row sets neither.

## Verify

- New file `src/commands/startup/reconcile-journal.test.ts`, suite `src/commands/startup/reconcile-journal.test`. It uses `createRecoveryFixture()` from `test/helpers/recovery.ts` (Story 03) — a command test may not import `src/services/git/journal.ts` or `src/services/event/sqlite.ts` directly, because AGENTS.md lets a test reach an implementation only in the capability it covers. The fixture's clock is `createMockClock({ start: 1700000000000 })` with **no `step`**, so every `now()` returns that value and a `completed_at` assertion is an exact number. The test adds a Mock `Git` whose `resolveRef` returns the value the case names and records its arguments. Fixture oids are literals: `BASE = "a".repeat(40)`, `HEAD_OID = "b".repeat(40)`, `OTHER = "c".repeat(40)`.
  - `merge` row, `resolveRef → HEAD_OID`: `state` reads `complete`, `result_head_oid` reads `HEAD_OID`, `outcome` reads `recovered-complete`, `child_token` reads `NULL`, `completed_at` reads `1700000000000`. Assert every one with an explicit `SELECT`. `completed` is `1`.
  - `sync` row, `resolveRef → BASE`: `state` reads `discarded`, `result_head_oid` reads `NULL`, `outcome` reads `recovered-discarded`. `discarded` is `1`.
  - `revert` row, `resolveRef → HEAD_OID`: resolved exactly as `merge`, proving `revert` shares the matrix (`docs/proposal/phase-3/recovery.md:87`).
  - `resolveRef → null` with `baseOid = BASE`: `state` reads `discarded`, `outcome` reads `recovered-absent`, and `findings` holds one entry with `code: "ref-absent-with-base"`.
  - `resolveRef → null` with `baseOid = ZERO_OID`: `state` reads `discarded` and `findings` is empty.
  - **A ref that matches neither leaves the row open, reports, and does not retry.** `resolveRef → OTHER`: `state` still reads `open`, `outcome` reads `NULL`, `child_token` reads `NULL`, `leftOpen` is `1`, `refusesNewWork` deep-equals `[repositoryId]`, `findings` holds one `code: "ref-unexpected"`, and the mock recorded exactly **one** `resolveRef` call.
  - `resolveRef` throwing `new GitError("lock-held", "m")`: `reconcileJournal` rejects with `RecoveryError`, `code === "ref-unreadable"`, and the message contains the ref and the repository id. The row is unchanged — `state` still reads `open` and `child_token` is unchanged.
  - **A `publish` row is still open after reconcile.** `state` reads `open`, `outcome` reads `awaiting-remote-reconcile`, `child_token` reads `NULL`, `completed_at` reads `NULL`, `leftOpen` is `1`, `refusesNewWork` deep-equals `[repositoryId]`, exactly one `recovery.publishReconcilePending` event exists, and the mock's `resolveRef` call list is **empty**.
  - Two repositories each holding one open `publish` row: `refusesNewWork` deep-equals the two ids bytewise sorted. One repository holding two open `publish` rows: `refusesNewWork` has length `1`.
  - Rows are reconciled in `id` order: seed three rows whose insertion order reverses sorted order and `deepEqual` the mock's recorded `resolveRef` refs against the sorted expectation.
  - Every appended event parses with `eventRow`, and every reconciled row read back parses with `gitOperationRow`.
- **Every pid-file removal is the caller's, after the commit.** `journal.complete`, `discard`, `markPublishPending` and `clearChildToken` return the cleared token (Story 01) and remove nothing. `reconcileJournal` calls `dependencies.git.removePidFile({ pidFile })` for each non-`null` return **after** that row's `storage.transact` returned. Add `git` to the dependency use for this purpose; it is already there for `resolveRef`.
- New file `src/commands/repository/assert-repository-accepts-work.test.ts`, suite `src/commands/repository/assert-repository-accepts-work.test`:
  - No `git_operation` row returns `{ accepts: true }` by `deepEqual`.
  - One open `publish` row returns `{ accepts: false, reason: "publish-reconcile-pending", gitOperationId: <id> }` by `deepEqual`.
  - An open `merge` row returns `{ accepts: true }` — the guard is about `publish` only.
  - A `complete` `publish` row returns `{ accepts: true }`.
  - Two open `publish` rows return the bytewise-lowest `id`.
  - A row belonging to another repository returns `{ accepts: true }`.
  - The function wrote nothing: compare `SELECT count(*) FROM event` and every `git_operation` column before and after with `deepEqual`.
- `node --test src/commands/startup/reconcile-journal.test.ts src/commands/repository/assert-repository-accepts-work.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: delivers `src/commands/startup/reconcile-journal.test.ts` under the EPIC Proof glob.
