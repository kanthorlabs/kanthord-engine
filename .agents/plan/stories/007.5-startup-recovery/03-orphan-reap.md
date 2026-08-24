# Story 03 — The orphan reap

Epic: `.agents/plan/epics/007.5-startup-recovery.md`
Depends on: Story 01 (the `GitJournal` interface), Story 02 (`Git.inspectChild`, `Git.stopChild`, `src/domain/recovery.ts`).

## Change

- **Edit `src/domain/recovery.ts`** (created in Story 02). Add the reap types:

  ```ts
  export type ReapedChild = Readonly<{
    pidFile: string;
    gitOperationId: string | null;
    repositoryId: string | null;
    finding:
      | "no-pid-file"
      | "pid-file-unreadable"
      | "process-absent"
      | "started-later"
      | "stopped";
  }>;

  export type ReapReport = Readonly<{
    children: readonly ReapedChild[];
    findings: readonly RecoveryFinding[];
  }>;
  ```

- **New file `src/commands/startup/reap-orphans.ts`.**

  ```ts
  export type ReapOrphansDependencies = Readonly<{
    storage: Storage;
    journal: GitJournal;
    git: Git;
    events: EventLog;
    clock: Clock;
    runDirectory: string;
    graceMs: number;
  }>;

  export type ReapOrphansInput = Readonly<{ actor: string }>;

  export async function reapOrphans(
    dependencies: ReapOrphansDependencies,
    input: ReapOrphansInput,
  ): Promise<ReapReport>;
  ```

- **The candidate list, in this exact order.** It has two sources and the order between them is fixed.

  1. `dependencies.journal.listInFlight(transaction)` inside one `storage.transact`, already `ORDER BY o.id`. Each row contributes `{ pidFile: row.childToken, gitOperationId: row.id, repositoryId: row.repositoryId }`.
  2. `await dependencies.git.listPidFiles({ runDirectory: dependencies.runDirectory })`, minus every path source 1 already names. The member is declared below so `commands/` touches no filesystem. Each remaining path contributes one candidate, in the bytewise path order the member returns.

  **Source 2 is every regular `*.pid` file in the run directory, and the two named forms only add attribution.** `listPidFiles` returns every regular file whose basename ends with `.pid`. The run directory is `<home>/git/run`, created by the daemon at mode `0700` (`src/services/git/probe.ts:219-223`), inside a home the daemon holds an exclusive lock on, so every name in it is daemon-minted and the daemon is the only writer. Ownership comes from that, not from the filename.

  Two patterns, declared once in `src/domain/recovery.ts`, are used to **attribute** a candidate and never to filter one:

  ```ts
  export const SEED_PID_PATTERN = /^seed-(repo_[0-9A-HJKMNP-TV-Z]{26})\.pid$/;
  export const GITOP_PID_PATTERN =
    /^gitop-(gitop_[0-9A-HJKMNP-TV-Z]{26})\.pid$/;
  ```

  A `seed-` name yields `{ pidFile, gitOperationId: null, repositoryId: <captured> }`. A `gitop-` name yields `{ pidFile, gitOperationId: <captured>, repositoryId: null }`, and the command resolves its repository from the row. **Every other name yields `{ pidFile, gitOperationId: null, repositoryId: null }` and is still reaped.**

  Filtering on the two named forms would leave a hole wide enough to defeat the epic. `seedHome` makes six supervised spawns against the staging directory and passes the caller's `seed-<repositoryId>.pid` to only two of them: `init` at `src/services/git/seed.ts:99`, `remote add` at `:111`, the refspec `config` at `:122`, `resolveRef` at `:138` and `canPush` at `:150` all take a runner-minted `git-<uuid>.pid` (`run.ts:37-39`), while `fetchTracking` at `:131` and `refUpdate` at `:165` take the caller's. `canPush` is a `git push --dry-run` and reaches the network, so it is the longest-lived of them. `run.ts:163-164` removes a minted pid file in a `finally`, which a `SIGKILL` never runs — so a surviving `canPush` child leaves exactly one `git-<uuid>.pid` behind, and it is using the staging directory Story 04's sweep removes. The sweep's premise is that no process is still **using** a path, not that no process is still writing a ref.

  The second source exists because registration's seed spawn cannot carry a journal row — `git_operation.repository_id` is `NOT NULL REFERENCES repository(id)` (`src/services/storage/migration-0003-execution-and-journal.ts:129`) and `register-repository.ts:279` inserts the repository row after `seedHome` returns. Registration is the only phase-1 command that spawns git, so without this source the reap would find nothing in phase 1. See B1 in `index.md` — **B1 is `action:YES` and needs a decision before this epic ships**; source 2 is the mitigation, not the answer.

- **New `Git` member, in `src/services/git/index.ts` after `stopChild`:**

  ```ts
  listPidFiles(input: Readonly<{ runDirectory: string }>): Promise<readonly string[]>;
  ```

  Implemented in **new file `src/services/git/pid-file.ts`** beside `pidFilePathFor` (Story 01):

  ```ts
  export async function listPidFiles(
    input: Readonly<{ runDirectory: string }>,
  ): Promise<readonly string[]>;
  ```

  It `readdirSync(runDirectory, { withFileTypes: true })`, keeps entries where `entry.isFile()` and `entry.name.endsWith(".pid")`, maps to `join(runDirectory, entry.name)`, and returns them sorted with `Buffer.compare`. `ENOENT` on the directory returns `[]`. Delegate it from `src/services/git/binary.ts` as `listPidFiles: (input) => listPidFiles(input)`. It applies neither pattern — attribution is the command's job.

  **`ps-<uuid>.pid` is the one name the reap must not re-enter.** Story 02's `inspectChild` mints one inside `dirname(input.pidFile)`, which for a source-2 candidate is the run directory itself, and removes it in a `finally`. The candidate list is built **once**, before any `inspectChild` call, so a scratch file created during the pass cannot join it.

- **The decision, per candidate, in order.** Each answer of `await dependencies.git.inspectChild({ pidFile })` maps to exactly one action. `docs/proposal/phase-3/recovery.md:42-47` is the table.

  | inspection            | action                                                                                                                                                                                  |
  | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `no-pid-file`         | record `finding: "no-pid-file"`, clear the token                                                                                                                                        |
  | `pid-file-unreadable` | record `finding: "pid-file-unreadable"`, clear the token, append a `RecoveryFinding` with `code: "pid-file-unreadable"`                                                                 |
  | `process-absent`      | record `finding: "process-absent"`, clear the token                                                                                                                                     |
  | `started-later`       | record `finding: "started-later"`, clear the token, append a `RecoveryFinding` with `code: "pid-reused"`                                                                                |
  | `liveness-unknown`    | **change nothing** and throw `RecoveryError("liveness-unknown", …)`                                                                                                                     |
  | `alive`               | `await dependencies.git.stopChild({ pid, graceMs: dependencies.graceMs })`. `true` records `finding: "stopped"` and clears the token. `false` throws `RecoveryError("orphan-alive", …)` |

  `liveness-unknown` refuses startup and leaves the token and the pid file intact, because `docs/proposal/phase-3/recovery.md:49` says a daemon that cannot establish the fact refuses to start rather than guessing, and the fact it is guessing about is silent data loss. The message is `\`the liveness of git process ${pid} for repository ${repositoryId ?? "unknown"} could not be established: ${detail}; pid file ${pidFile}\``.

  "Clear the token" is one `storage.transact` per candidate calling `dependencies.journal.clearChildToken(transaction, { id })` when `gitOperationId` is not `null`, followed by `dependencies.events.append` of the event below. **The pid file is removed after that transaction returns, never inside it**, through the member declared next, using the path `clearChildToken` returned. A candidate from source 2 has no row, so its file is removed the same way with no transaction at all. Ordering matters: a removal inside the callback that was followed by a failed commit would leave an open row whose token names a file that is gone, and the next startup would read that as "git never started". Committing first inverts the residue — a file that outlives its cleared token is re-inspected next startup, finds no matching process, and is removed then.

  The member, declared in `src/services/git/index.ts` after `listPidFiles`:

  ```ts
  removePidFile(input: Readonly<{ pidFile: string }>): Promise<void>;
  ```

  implemented in `pid-file.ts` as `rmSync(input.pidFile, { force: true })` and delegated from `binary.ts`. It is the **only** pid-file removal in this epic, and it runs exactly once per resolved candidate, after that candidate's transaction committed.

- **The event.** One per candidate whose `repositoryId` is not `null`, appended in the same transaction as the token clear, or in its own transaction when there is no row to update:

  ```
  subjectKind: "repository", subjectId: repositoryId,
  type: "recovery.childReaped", actorKind: "daemon", actorId: input.actor,
  payload: { gitOperationId, pidFile, finding }
  ```

  A `gitop-` source-2 candidate has a `gitOperationId` and no repository, so the command resolves its repository with `SELECT repository_id FROM git_operation WHERE id = ?` in the same transaction and uses it; `undefined` leaves `repositoryId` `null` and appends no event, because `event.subject_id` is `anyIdentity` (`src/domain/event.ts:5`) and admits no daemon-level subject. That candidate's outcome reaches the operator through the returned `findings`.

- **The refusal.** `RecoveryError("orphan-alive", \`git process ${pid} for repository ${repositoryId ?? "unknown"} did not exit; pid file ${pidFile}\`)`. It names the process and the repository, which is what the EPIC requires. It is thrown after `stopChild`returns`false`, so both signals were already sent.

- **`src/main.ts`.** No wiring in this story; Story 07 binds it.

## Constraints

- `src/commands/**` may import no `node:fs`, `node:child_process`, `node:sqlite` or `node:http` (`eslint.config.js:222-244`). Every filesystem read and every signal in this story goes through a `Git` member.
- `src/commands/startup/reap-orphans.ts` must relative-import no other module under `src/commands/` — `src/domain/layout.test.ts:175-189` fails on one offender. Its shared types come from `src/domain/recovery.ts`.
- `Transaction` is synchronous (`src/services/storage/index.ts:33`, `connection.ts:90-101`). Every `await` happens outside `storage.transact`. One transaction per candidate, never one around the whole loop.
- Do not edit `src/commands/repository/register-repository.ts`, and do not edit `src/services/home-lock/startup.test.ts` in this story.
- `src/domain/recovery.ts` must contain no `Date.now(`, `new Date(` and no `Math.random(` — `src/domain/layout.test.ts:56-66` walks every production file at the `src/domain/` root.

## Verify

- **New file `test/helpers/recovery.ts`.** Every command test in this epic builds its fixture here, because AGENTS.md's test rule lets a test reach an implementation **only in the capability it covers** — a test under `src/commands/` may not import `src/services/git/journal.ts` or `src/services/event/sqlite.ts`. `test/helpers/database.ts` already imports `SqliteStorage`, so a helper may. It exports:

  ```ts
  export type RecoveryFixture = Readonly<{
    storage: Storage;
    journal: GitJournal;
    events: EventLog;
    clock: Clock;
    seedRepository(
      input: Readonly<{ id: string; name: string; homePath: string }>,
    ): void;
    seedGitOperation(row: Readonly<Record<string, unknown>>): void;
    readGitOperation(id: string): Readonly<Record<string, unknown>>;
    listEvents(): readonly RecordedEvent[];
    dispose(): void;
  }>;

  export function createRecoveryFixture(): RecoveryFixture;
  ```

  It wires `createMigratedStorage()`, the real `createGitJournal()`, the real SQLite `EventLog`, and `createMockClock({ start: 1700000000000 })` with **no `step`**, so every `now()` returns that literal. `seedRepository` writes a complete `repository` row with `upstream_branch = "main"`, `landing_branch = "kanthord/landing"`, `publish_ref = "refs/heads/kanthord/publish"`, `publish_on_approval = 0`, `state = "ready"`, three `NULL` oid columns and `updated_at = 1700000000000` — the exact row, so no test invents one.

- New file `src/commands/startup/reap-orphans.test.ts`, suite `src/commands/startup/reap-orphans.test`. It uses `createRecoveryFixture()` and a **hand-written Mock `Git`** implementing only `inspectChild`, `stopChild`, `listPidFiles` and `removePidFile`, with every other member throwing. The mock returns the exact inspection the case names and records its calls. Assertions:
  - Two in-flight rows and one unreferenced pid file produce candidates in the order `[rowIdA, rowIdB, unreferencedPath]`, asserted against the mock's recorded `inspectChild` argument list by `deepEqual`.
  - Two unreferenced pid files named `b.pid` and `a.pid` are inspected in bytewise path order.
  - `alive` then `stopChild → true`: the returned child carries `finding: "stopped"`, `child_token` for that row reads `NULL` afterwards, exactly one `recovery.childReaped` event exists for it, and the file removal was requested once.
  - **The lock still exists while the child lives.** With `stopChild` recorded as a spy that asserts, at call time, that a fixture file `<homePath>/refs/heads/main.lock` still exists, and with no sweep in this story, the returned report is produced with the lock untouched. Assert `existsSync(lock)` after `reapOrphans` returns.
  - `alive` then `stopChild → false`: `reapOrphans` rejects with `RecoveryError`, `code === "orphan-alive"`, and the message contains the pid, the repository id and the pid file path. `child_token` for that row is still non-`NULL`, and no event was appended.
  - `started-later`: `stopChild` was never called (the mock's recorded call list is empty), the token is cleared, one event with `finding: "started-later"` exists, and a `RecoveryFinding` with `code: "pid-reused"` is in the report.
  - `no-pid-file`: the token is cleared, the event carries `finding: "no-pid-file"`, and the report carries no finding.
  - `pid-file-unreadable`: the token is cleared and the report carries a finding with `code: "pid-file-unreadable"`.
  - **`liveness-unknown` refuses startup and changes nothing.** `reapOrphans` rejects with `RecoveryError`, `code === "liveness-unknown"`, the message contains the pid and the detail, `child_token` for that row is unchanged, no event was appended, and the mock's `removePidFile` and `stopChild` call lists are both empty.
  - A `seed-<repositoryId>.pid` source-2 candidate **does** produce a `recovery.childReaped` event on that repository, and `removePidFile` was called once with its path.
  - A `gitop-<id>.pid` source-2 candidate whose row exists produces an event on that row's repository; one whose row does not exist produces none.
  - **A `git-<uuid>.pid` source-2 candidate is inspected, stopped and removed**, and it produces no event because it names no repository. Its outcome is in `children` with `finding: "stopped"`. This is the case a name filter would have skipped.
  - A candidate list built from a run directory holding six differently named `.pid` files inspects all six.
  - **Every removal happens after its transaction committed.** The Mock's `removePidFile` asserts, at call time, that the row it belongs to already reads `child_token IS NULL` through a fresh `readGitOperation`. A removal inside the callback would see the pre-commit state.
  - `listInFlight` after a full clean reap returns `[]`, so a second `reapOrphans` on the same storage inspects only the source-2 files.
  - Every appended event parses with `eventRow` from `src/domain/event.ts`.
- Extend `src/services/git/pid-file.test.ts` from Story 01 with:
  - `listPidFiles` on a missing directory returns `[]`.
  - **Every `.pid` regular file is returned, whatever its name.** A directory holding `seed-repo_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid`, `gitop-gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid`, `git-3f2a.pid`, `probe-3f2a.pid`, `keyscan-3f2a.pid`, `note.txt` and a subdirectory `d.pid/` returns exactly the five `.pid` regular files, bytewise sorted, by `deepEqual`. `git-3f2a.pid` being in that list is the assertion that closes the `canPush` hole.
  - `SEED_PID_PATTERN` and `GITOP_PID_PATTERN` are exported from `src/domain/recovery.ts` and each captures the id: assert the capture groups equal the expected `repo_…` and `gitop_…` strings, and that neither matches `git-3f2a.pid`.
  - `removePidFile` on a missing path resolves without throwing.
- Edit `src/services/git/binary.test.ts`: member count becomes `16`, the array gains `"listPidFiles"` after `"inspectChild"` and `"removePidFile"` after `"refUpdate"`, and the suite name says `the sixteen member names`.
- `node --test src/domain/recovery.test.ts src/commands/startup/reap-orphans.test.ts src/services/git/pid-file.test.ts src/services/git/binary.test.ts` exits 0.
- `src/domain/layout.test.ts` needs no edit: `test/helpers/recovery.ts` is not a `.test.ts` file and adds no `src/` directory.
- `npm run verify` exits 0.
- Proof: delivers `src/commands/startup/reap-orphans.test.ts` under the EPIC Proof glob.
