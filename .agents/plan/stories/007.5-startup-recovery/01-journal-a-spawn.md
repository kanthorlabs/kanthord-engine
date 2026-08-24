# Story 01 — Journalling a spawn

Epic: `.agents/plan/epics/007.5-startup-recovery.md`

## Change

- **New file `src/services/git/journal.ts`.** It reaches `Transaction` through `../storage/index.ts`, which the import matrix permits for a service implementation. Export one factory:

  ```ts
  export function createGitJournal(
    dependencies: GitJournalDependencies,
  ): GitJournal;
  ```

- **Edit `src/services/git/index.ts`.** Add the journal interface and its types after `TRACKING_REFSPEC` (`:156`). The file already imports `Transaction` from `../storage/index.ts` at `:1`, plus three type groups from sibling implementations at `:2-4`, so no import is added. `src/services/home-lock/index.ts` is the precedent for one service interface file declaring several interfaces.

  ```ts
  export type GitIntent = "merge" | "sync" | "publish" | "revert";

  export type OpenJournalRowInput = Readonly<{
    id: string;
    repositoryId: string;
    intent: GitIntent;
    nodeId: string | null;
    runId: string | null;
    candidateId: string | null;
    leaseFence: number;
    ref: string;
    baseOid: string;
    proposedHeadOid: string;
    expectedRemoteOid: string | null;
    childToken: string;
  }>;

  export type CompleteJournalRowInput = Readonly<{
    id: string;
    resultHeadOid: string | null;
    outcome: string | null;
    completedAt: number;
  }>;

  export type DiscardJournalRowInput = Readonly<{
    id: string;
    outcome: string | null;
    completedAt: number;
  }>;

  export type InFlightJournalRow = Readonly<{
    id: string;
    repositoryId: string;
    repositoryHomePath: string;
    intent: GitIntent;
    ref: string;
    baseOid: string;
    proposedHeadOid: string;
    childToken: string;
  }>;

  export type OpenJournalRow = Readonly<{
    id: string;
    repositoryId: string;
    repositoryHomePath: string;
    intent: GitIntent;
    ref: string;
    baseOid: string;
    proposedHeadOid: string;
    childToken: string | null;
  }>;

  export type JournalErrorCode = "journal-row-not-open";

  export class JournalError extends Error {
    readonly code: JournalErrorCode;
    constructor(code: JournalErrorCode, message: string);
  }

  export interface GitJournal {
    open(transaction: Transaction, input: OpenJournalRowInput): void;
    complete(
      transaction: Transaction,
      input: CompleteJournalRowInput,
    ): string | null;
    discard(
      transaction: Transaction,
      input: DiscardJournalRowInput,
    ): string | null;
    listInFlight(transaction: Transaction): readonly InFlightJournalRow[];
    listOpen(transaction: Transaction): readonly OpenJournalRow[];
    markPublishPending(
      transaction: Transaction,
      input: Readonly<{ id: string; outcome: string }>,
    ): string | null;
    clearChildToken(
      transaction: Transaction,
      input: Readonly<{ id: string }>,
    ): string | null;
  }
  ```

- **No method removes a file.** The four methods that clear `child_token` **return the path they cleared**, or `null` when there was none, and the caller removes it through `Git.removePidFile` **after `storage.transact` returns**. A removal inside the transaction callback is not atomic with the commit: if the file were removed and the commit then failed, the row would stay open with its token while the file was gone, the next startup would read that as "git never started", and the sweep would run while the child was still alive. Removing after the commit inverts the residue into the safe direction — a file that outlives its row is re-inspected on the next startup, finds no matching process, and is removed then.

- **`createGitJournal` takes no dependencies** — `createGitJournal(): GitJournal`. All methods are synchronous because `Transaction` is synchronous (`src/services/storage/index.ts:1-5`, `connection.ts:90-101`).

  - `open` runs one INSERT naming all seventeen columns in the order `register-repository.ts:298` uses, with `state = 'open'`, `result_head_oid = NULL`, `detail_blob = NULL`, `completed_at = NULL`, `child_token = input.childToken`.
  - `complete` first reads `transaction.get("SELECT child_token FROM git_operation WHERE id = ? AND state = 'open'", [input.id])`; `undefined` throws `JournalError("journal-row-not-open", \`git operation ${input.id} is not open\`)`, because `Transaction`exposes no change count. It then runs`UPDATE git_operation SET state = 'complete', result_head_oid = ?, outcome = ?, child_token = NULL, completed_at = ? WHERE id = ? AND state = 'open'`and returns the`child_token` it read.
  - `discard` is `complete` with `state = 'discarded'` and `result_head_oid = NULL`, and the same read, the same throw and the same return.
  - `markPublishPending` reads the same column, runs `UPDATE git_operation SET outcome = ?, child_token = NULL WHERE id = ? AND state = 'open'`, leaves `state = 'open'`, does not set `completed_at`, and returns the previous `child_token`.
  - `clearChildToken` reads the column with no `state` predicate, runs `UPDATE git_operation SET child_token = NULL WHERE id = ?`, changes no other column, and returns the previous value.
  - `listInFlight` runs, exactly:
    `SELECT o.id, o.repository_id, r.home_path, o.intent, o.ref, o.base_oid, o.proposed_head_oid, o.child_token FROM git_operation o JOIN repository r ON r.id = o.repository_id WHERE o.state = 'open' AND o.child_token IS NOT NULL ORDER BY o.id`
  - `listOpen` runs the same statement without the `child_token IS NOT NULL` predicate, still `ORDER BY o.id`.
  - Both mappers name every column. No `SELECT *`.

- **New file `src/services/git/pid-file.ts`** exporting one function, so the path convention has one definition:

  ```ts
  export function pidFilePathFor(
    runDirectory: string,
    gitOperationId: string,
  ): string;
  ```

  It returns `join(runDirectory, \`gitop-${gitOperationId}.pid\`)`. `gitop`is the`gitOperation` identity prefix (`src/domain/identity.ts:41`), so a pid file names its row and the reap needs no second table.

- **`src/main.ts`.** After `const gitRunner = createGitRunner(gitPaths);` (`:110`) add `const gitJournal = createGitJournal();`. No `node:fs` import is added. Nothing else consumes it in this story; Stories 03 and 05 bind it.

## Constraints

- `git_operation.repository_id` is `NOT NULL REFERENCES repository(id)` (`src/services/storage/migration-0003-execution-and-journal.ts:129`), and `register-repository.ts:279` inserts the repository row **after** `seedHome` returns (`:225`). **Registration therefore cannot open a journal row before its spawn, and this story adds no call site to it.** Leave `register-repository.ts` unchanged, including its `child_token` value of `null` at `:315`. Story 03's reap covers registration's pid file by its second source. See B1 in `index.md`.
- Add no column and edit no `docs/proposal/database/*.md` SQL fence. `migration-0003-execution-and-journal.test.ts:402-423` compares the migration against the proposal fence, and it must stay green untouched.
- `GitJournal` is a second interface in `src/services/git/index.ts`, not a new service directory. `src/domain/layout.test.ts:101-123` pins the thirteen service directories, and this epic adds none.
- `src/services/git/index.ts` must still contain no `implements ` — `src/domain/layout.test.ts:157-173` asserts it for every service index.
- `GitJournal` methods are synchronous. An `async` member makes every caller unable to use it inside `transact`.
- No method touches the filesystem. `journal.ts` imports no `node:fs`, and `src/domain/layout.test.ts` is not what enforces that — the assertion below is.

## Verify

- New file `src/services/git/journal.test.ts`, suite name `src/services/git/journal.test`. It uses `createMigratedStorage()` from `test/helpers/database.ts` and seeds one `repository` row with `home_path = "/tmp/fixture.git"` through raw SQL. Assertions:
  - `open` then `listInFlight` returns exactly one row, and every member equals the input, with `repositoryHomePath` equal to the seeded `home_path`.
  - `open` with `intent = "publish"` and `expectedRemoteOid` set stores that value; read it back with an explicit `SELECT expected_remote_oid`.
  - `complete` sets `state = 'complete'`, `result_head_oid` to the input, `child_token` to `NULL` and `completed_at` to the input, asserted by an explicit `SELECT` of those four columns.
  - `complete` **returns** the row's previous `child_token`, asserted as an exact string.
  - `discard` sets `state = 'discarded'`, leaves `result_head_oid` `NULL`, clears `child_token`, and returns the previous token.
  - `complete` on an already completed row throws `JournalError` with `code === "journal-row-not-open"` and `name === "JournalError"`.
  - `markPublishPending` leaves `state = 'open'` and `completed_at` `NULL`, sets `outcome` to the input, clears `child_token`, and returns the previous token.
  - `clearChildToken` on an open row leaves `state = 'open'`, `outcome` `NULL` and `completed_at` `NULL`, sets `child_token` to `NULL`, and returns the previous token. A second call on the same row returns `null`.
  - **The module touches no filesystem.** `readFileSync(new URL("./journal.ts", import.meta.url), "utf8")` contains neither `"node:fs"` nor `"rmSync"`.
  - `listInFlight` excludes a row whose `state = 'complete'` and a row whose `child_token IS NULL`; `listOpen` includes the `child_token IS NULL` open row. Both are asserted with three seeded rows.
  - `listInFlight` returns rows ordered by `id`: seed three rows with ids minted so the insertion order is the reverse of the sorted order, and `deepEqual` the returned id array against the sorted one.
  - The domain refinement holds for every row this module writes: `gitOperationRow.parse` of each row read back succeeds. Import `gitOperationRow` from `src/domain/git-operation.ts`.
- New file `src/services/git/pid-file.test.ts`, suite `src/services/git/pid-file.test`: `pidFilePathFor("/h/git/run", "gitop_01J0")` equals `"/h/git/run/gitop-gitop_01J0.pid"` — an exact string, not a pattern.
- `node --test src/services/git/journal.test.ts src/services/git/pid-file.test.ts` exits 0.
- `node --test src/commands/repository/register-repository.test.ts` exits 0 with no edit to that file.
- `npm run verify` exits 0.
- Proof: this story delivers no `src/commands/startup/**` file, so it delivers no part of the EPIC Proof line. See B2 in `index.md`.
