# Story 06 — Expired lease recovery

Epic: `.agent/plan/epics/007.5-startup-recovery.md`
Depends on: Story 03 (`src/domain/recovery.ts`).

## Change

- **New file `src/services/git/worktree.ts`.**

  ```ts
  export type WorktreeCleanInput = Readonly<{ workDir: string }>;

  export async function worktreeClean(
    runner: GitRunner,
    input: WorktreeCleanInput,
  ): Promise<boolean>;
  ```

  It calls `runner({ args: ["status", "--porcelain=v1", "--untracked-files=all"], cwd: input.workDir })` and returns `result.stdout.length === 0`. A non-zero `result.code` throws `GitError("unknown", \`git status failed in ${input.workDir}\`, result.stderr)`. `--porcelain=v1`pins the format across git versions, and`--untracked-files=all` makes an untracked file count as dirty, because a recovered task must not inherit one.

- **New `Git` member, in `src/services/git/index.ts` after `sweepHome`:**

  ```ts
  worktreeClean(input: WorktreeCleanInput): Promise<boolean>;
  ```

  Delegated from `src/services/git/binary.ts` as `worktreeClean: (input) => worktreeClean(runner, input)`.

- **New file `src/commands/startup/recover-expired-leases.ts`.**

  ```ts
  export type RecoverExpiredLeasesDependencies = Readonly<{
    storage: Storage;
    git: Git;
    events: EventLog;
    clock: Clock;
  }>;

  export type RecoverExpiredLeasesInput = Readonly<{ actor: string }>;

  export type RecoverExpiredLeasesResult = Readonly<{
    returnedToReady: number;
    blocked: number;
    findings: readonly RecoveryFinding[];
  }>;

  export async function recoverExpiredLeases(
    dependencies: RecoverExpiredLeasesDependencies,
    input: RecoverExpiredLeasesInput,
  ): Promise<RecoverExpiredLeasesResult>;
  ```

- **The candidate set.** One `storage.transact` and one statement, exactly:

  ```sql
  SELECT l.subject_id, l.fence, n.kind, r.base_oid, w.path, w.repository_id
  FROM lease l
  JOIN node n ON n.id = l.subject_id
  LEFT JOIN run r ON r.node_id = n.id AND r.state = 'active'
  LEFT JOIN workspace w ON w.id = r.workspace_id
  WHERE l.subject_kind = 'node'
    AND l.expires_at IS NOT NULL
    AND l.expires_at <= ?
    AND n.state = 'running'
  ORDER BY l.subject_id
  ```

  **The workspace is reached through the active run, not through `workspace.node_id`.** `run.workspace_id` is `NOT NULL REFERENCES workspace(id)` (`migration-0003-execution-and-journal.ts:35`), and that is the attributed relationship: a task run records the workspace it ran in. `workspace.node_id` is `NOT NULL UNIQUE REFERENCES node(id)` (`:9`) and names the node the workspace was cloned **for**, which for a task's workspace is the objective. Joining `w.node_id = n.id` against a running task would therefore find nothing and every real task recovery would report missing inputs and block the task.

  The parameter is `dependencies.clock.now()`, read once before the transaction and reused for every row, so one startup uses one instant. Expiry is never read from `Date.now()`.

  The `lease` service is not consulted. `src/services/lease/not-implemented.ts:22-27` makes `Lease.expired` throw `LeaseError("not-implemented", …)`, and `NotImplementedLease` is the only implementation. `src/commands/repository/assert-no-outside-writer.ts:25-29` is the precedent for a command holding its own statement.

- **The verdict, per row, in `subject_id` order.**

  1. `kind !== "task"` adds a finding with `code: "lease-expired-on-non-task"` and changes nothing. `src/domain/transition.ts:134-141` makes `running -> ready` legal for a task only, and `docs/proposal/phase-1/state-machine.md:78` states why.
  2. `path === null` or `base_oid === null` moves the node to `blocked` with reason `dirty-recovery` and adds a finding with `code: "recovery-inputs-missing"`. An expired lease whose workspace or active run is gone cannot be proved clean.
  3. Otherwise `clean = await dependencies.git.worktreeClean({ workDir: path })` and `head = await dependencies.git.resolveRef({ gitDir: join(path, ".git"), ref: "HEAD" })`. Both awaits happen before the write transaction opens.
  4. `clean === true && head === base_oid` moves the node to `ready`. Anything else moves it to `blocked` with reason `dirty-recovery`.
  5. A `GitError` from either call moves the node to `blocked` with reason `dirty-recovery` and adds a finding with `code: "workspace-unreadable"`. It does not refuse startup: one unreadable workspace costs one task, and the block is the state a human clears.

- **The write, one `storage.transact` per row.** In this order:

  1. `assert(canTransition("task", "running", target))` — import `canTransition` from `src/domain/transition.ts`. A false answer throws `Error(\`running -> ${target} is not a task transition\`)`, which is a defect rather than a runtime condition.
  2. `UPDATE node SET state = ?, block_reason = ?, updated_at = ? WHERE id = ? AND state = 'running'` with `block_reason` `null` for `ready` and `'dirty-recovery'` for `blocked`. `src/domain/node.ts:35-37` requires `(state = 'blocked') = (block_reason IS NOT NULL)`, so the two columns are always written together.
  3. `UPDATE lease SET owner = NULL, expires_at = NULL, renewed_at = NULL, fence = fence + 1 WHERE subject_kind = 'node' AND subject_id = ?`. The fence increment is what stops a returning worker from writing under the old fence.
  4. `dependencies.events.append(transaction, { subjectKind: "node", subjectId, type, actorKind: "daemon", actorId: input.actor, payload })` where `type` is `"recovery.leaseRecovered"` for `ready` and `"recovery.leaseBlocked"` for `blocked`, and `payload` is `{ target, clean, headOid: head, baseOid: base_oid, fence: fence + 1 }`. For case 1 no event is appended, because no state changed.

## Constraints

- Expiry comes from `dependencies.clock.now()`. `src/domain/layout.test.ts:56-66` polices `Date.now(` in `src/domain/` only, so this rule is carried by the test list below, not by a lint rule.
- `src/commands/**` may import no `node:fs` (`eslint.config.js:233-234`). `join` from `node:path` is not restricted and is already used at `src/commands/repository/register-repository.ts:216`.
- No production code writes a `workspace`, `run` or `lease` row in phase 1 — nothing calls `git.clone` (`src/services/git/binary.ts:27` is its only wiring) and `Lease` is unimplemented. Every case is proved against seeded rows.
- `blockReasons` already holds `dirty-recovery` (`src/domain/state.ts:27`) and `migration-0002-graph-and-plan.ts:39` already admits it in the `CHECK`. Add neither.
- Add no column, no migration and no configuration key.

## Verify

- New file `src/services/git/worktree.test.ts`, suite `src/services/git/worktree.test`. It uses `resolveTools()`, `pinnedGitEnvironment` from `test/helpers/remote/seed.ts`, a temp directory per case, and the real `createGitRunner`:
  - A freshly initialised repository with one commit and no change returns `true`.
  - The same repository with one modified tracked file returns `false`.
  - The same repository with one untracked file returns `false` — this is what `--untracked-files=all` buys.
  - A directory that is not a repository throws `GitError`.
- New file `src/commands/startup/recover-expired-leases.test.ts`, suite `src/commands/startup/recover-expired-leases.test`. It uses `createRecoveryFixture()` from `test/helpers/recovery.ts` (Story 03), whose clock is `createMockClock({ start: 1700000000000 })` with **no `step`** so every `now()` is that exact value, and a Mock `Git` answering `worktreeClean` and `resolveRef` with the values the case names. A command test may not import `src/services/event/sqlite.ts` directly. Rows are seeded with `seedGraph` / `seedExecution` from `test/helpers/rows.ts` plus explicit `lease`, `run` and `workspace` inserts. `BASE = "a".repeat(40)`, `OTHER = "b".repeat(40)`.
  - **An expired lease on a clean workspace at the recorded base returns the node to `ready`.** `expires_at = 1699999999999`, `worktreeClean → true`, `resolveRef → BASE`, `run.base_oid = BASE`. Afterwards `SELECT state, block_reason FROM node` reads `("ready", null)`, `SELECT owner, expires_at, renewed_at, fence FROM lease` reads `(null, null, null, <original + 1>)`, exactly one `recovery.leaseRecovered` event exists, and `returnedToReady` is `1`.
  - **An expired lease on a dirty workspace moves it to `blocked` with reason `dirty-recovery`.** `worktreeClean → false`. `SELECT state, block_reason` reads `("blocked", "dirty-recovery")`, exactly one `recovery.leaseBlocked` event exists, and `blocked` is `1`.
  - A clean workspace whose `resolveRef → OTHER` moves it to `blocked` with reason `dirty-recovery`.
  - **Both cases read expiry from the mock clock.** A lease with `expires_at = 1700000000001` — one millisecond after the mock's instant — is **not** a candidate: the node still reads `running`, no event exists, and both counters are `0`. Change nothing but that column between this case and the first one.
  - A lease with `expires_at = 1700000000000` is a candidate, proving the comparison is `<=`.
  - A lease with `expires_at IS NULL` is not a candidate.
  - A node in state `ready` with an expired lease is not a candidate.
  - `kind = "objective"` with an expired lease adds a finding with `code: "lease-expired-on-non-task"`, leaves the node `running`, appends no event, and leaves the lease `fence` unchanged.
  - A task with no `workspace` row moves to `blocked` with reason `dirty-recovery` and adds a finding with `code: "recovery-inputs-missing"`, and the Mock's `worktreeClean` call list is empty.
  - A task whose only `run` row has `state = 'ended'` reaches the same outcome, proving the `run.state = 'active'` join predicate. `run.state` is `CHECK (state IN ('active', 'ended'))` (`migration-0003-execution-and-journal.ts:41`), so `'ended'` is the only non-active value a fixture can insert.
  - A task whose active run names a workspace whose own `node_id` is the **objective**, not the task, is still recovered — the join is through `run.workspace_id`. Seed exactly that shape, because it is the shape production will write.
  - `worktreeClean` throwing `new GitError("unknown", "m")` moves the node to `blocked` with reason `dirty-recovery`, adds a finding with `code: "workspace-unreadable"`, and `recoverExpiredLeases` resolves rather than rejects.
  - Three candidates are processed in `subject_id` order, asserted by `deepEqual` of the Mock's recorded `worktreeClean` `workDir` list against the expectation derived from the sorted ids.
  - Every appended event parses with `eventRow`, and every node read back parses with `nodeRow` from `src/domain/node.ts`.
  - `canTransition("task", "running", "ready")` and `canTransition("task", "running", "blocked")` are both `true` — asserted directly, so the guard's premise is pinned in this file.
- Edit `src/services/git/binary.test.ts`: member count becomes `18`, the array gains `"worktreeClean"` at the end, and the suite name says `the eighteen member names`.
- `node --test src/services/git/worktree.test.ts src/commands/startup/recover-expired-leases.test.ts src/services/git/binary.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: delivers `src/commands/startup/recover-expired-leases.test.ts` under the EPIC Proof glob.
