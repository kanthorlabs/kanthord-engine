# Story 07 — The recovery component and its ordering

Epic: `.agent/plan/epics/007.5-startup-recovery.md`
Depends on: Stories 03, 04, 05, 06 (the four steps it orders).

## Change

- **Edit `src/domain/recovery.ts`** (created in Story 03). Add the four step types and the whole-run report:

  ```ts
  export type ReapStep = () => Promise<ReapReport>;
  export type SweepStep = (
    reap: ReapReport,
  ) => Promise<SweepRemnantsResultLike>;
  export type ReconcileStep = () => Promise<ReconcileResultLike>;
  export type LeasesStep = () => Promise<LeasesResultLike>;

  export type SweepRemnantsResultLike = Readonly<{
    removed: number;
    findings: readonly RecoveryFinding[];
  }>;

  export type ReconcileResultLike = Readonly<{
    completed: number;
    discarded: number;
    leftOpen: number;
    refusesNewWork: readonly string[];
    findings: readonly RecoveryFinding[];
  }>;

  export type LeasesResultLike = Readonly<{
    returnedToReady: number;
    blocked: number;
    findings: readonly RecoveryFinding[];
  }>;

  export const RECOVERY_STEP_ORDER = [
    "reap",
    "sweep",
    "reconcile",
    "leases",
  ] as const;

  export type RecoveryReport = Readonly<{
    reaped: number;
    removed: number;
    completed: number;
    discarded: number;
    leftOpen: number;
    refusesNewWork: readonly string[];
    returnedToReady: number;
    blocked: number;
    findings: readonly RecoveryFinding[];
  }>;
  ```

  The four step types are declared in `src/domain/` because `src/commands/startup/recover-home.ts` may not relative-import another `src/commands/` module (`src/domain/layout.test.ts:175-189`). The step results are structurally typed here and the four commands' own result types satisfy them, so no command imports another.

- **New file `src/commands/startup/recover-home.ts`.**

  ```ts
  export type RecoverHomeDependencies = Readonly<{
    reap: ReapStep;
    sweep: SweepStep;
    reconcile: ReconcileStep;
    leases: LeasesStep;
  }>;

  export async function recoverHome(
    dependencies: RecoverHomeDependencies,
  ): Promise<RecoveryReport>;
  ```

  It takes no `input`. A `home` member was considered and dropped: nothing in the body or the report reads it, and an unused parameter is a decision waiting to be re-litigated. The home reaches the four steps through their own dependencies, which `main.ts` binds from `settings.home` and `gitPaths`.

  The body is four sequential awaits in the order `RECOVERY_STEP_ORDER` names, with no branch and no `Promise.all`:

  ```ts
  const reap = await dependencies.reap();
  const sweep = await dependencies.sweep(reap);
  const reconcile = await dependencies.reconcile();
  const leases = await dependencies.leases();
  ```

  It then returns one `RecoveryReport`: `reaped` is `reap.children.length`, every other counter is copied from its step, and `findings` is the concatenation in step order — `reap.findings`, `sweep.findings`, `reconcile.findings`, `leases.findings` — never sorted, because step order is the report's order.

  The sweep receives the reap's own report as its argument. That is the type-level ordering constraint: the sweep is unreachable before the reap resolves.

- **Edit `src/main.ts`.** Inside the `serve` action, insert one block **between `assertMigrated(...)` ending at `:126` and `const reporters = [` at `:127`**:

  ```ts
  const events = createSqliteEventLog({ storage, ids });
  const recovery = await recoverHome({
    reap: () =>
      reapOrphans(
        {
          storage,
          journal: gitJournal,
          git,
          events,
          clock,
          runDirectory: gitPaths.runDirectory,
          graceMs: 5000,
        },
        { actor: "daemon" },
      ),
    sweep: (reap) =>
      sweepRemnants(
        { storage, git, events, keyDirectory: gitPaths.keyDirectory },
        { actor: "daemon", reap },
      ),
    reconcile: () =>
      reconcileJournal(
        { storage, journal: gitJournal, git, events, clock },
        { actor: "daemon" },
      ),
    leases: () =>
      recoverExpiredLeases(
        { storage, git, events, clock },
        { actor: "daemon" },
      ),
  });
  for (const finding of recovery.findings) {
    process.stderr.write(`kanthord: recovery: ${renderFinding(finding)}\n`);
  }
  ```

  `ids`, `crypto` and `events` are constructed at `:136-141` today. Move the `ids` and `events` construction **above** the recovery block and delete the duplicate lines, keeping `crypto` where it is. That is the only reordering.

- **Edit `src/main.ts`'s catch at `:217-229`.** Add `error instanceof RecoveryError ||` to the union, so a refusal prints `kanthord: <code>: <message>` and exits 1 exactly as `StartupError` does. Import `RecoveryError` and `renderFinding` from `./domain/recovery.ts`.

- **`graceMs` is `5000`, a literal in `main.ts`.** It bounds how long `stopChild` waits for a signalled process group, and nothing else. It is not a configuration key because adding one needs a `convict.ts` schema entry (`:34-64`), a `Settings` key-order edit (`convict.test.ts:107-113`) and a documented default, for a value no operator has a reason to change: too low only turns a stop into an `orphan-alive` refusal, which is safe and loud.

## Constraints

- Recovery runs after the tool probe (`:105-108`) and after the migration gate (`:123-126`), and before the readiness line at `:211`. It cannot precede the migration gate: every step reads a table.
- Recovery writes **nothing to stdout**. `src/services/home-lock/startup.test.ts:247` pins the daemon's stdout to exactly `kanthord: ready\n`, and `:248` pins its stderr to `""` on a clean start — so a clean recovery must produce no finding and therefore no stderr line.
- Recovery holds the home lock throughout, because `:95-97` acquires it before the probe and never releases it in the `serve` path. `docs/proposal/phase-3/recovery.md:19` requires that.
- `recover-home.ts` must relative-import no other `src/commands/` module.
- Do not change `src/http/contract/**`. No operation, no status, no schema and no error code changes, so `registry.test.ts`, `parity.test.ts` and `openapi.test.ts` stay green untouched.

## Verify

- New file `src/commands/startup/recover-home.test.ts`, suite `src/commands/startup/recover-home.test`. It uses four recording fakes and no storage at all.
  - **The order is asserted, not assumed.** Each fake pushes its name onto a shared array; `deepEqual(calls, ["reap", "sweep", "reconcile", "leases"])`, and `deepEqual(calls, [...RECOVERY_STEP_ORDER])` as a second assertion so the constant and the body cannot drift.
  - The sweep receives the reap's exact report object, asserted with `assert.equal(receivedReap, reapReport)` — identity, not deep equality.
  - Each step resolves only after the previous one did: every fake records `Date.now()`-free evidence by appending to the shared array before and after an `await new Promise((resolve) => setImmediate(resolve))`, and the array reads `["reap:start","reap:end","sweep:start","sweep:end","reconcile:start","reconcile:end","leases:start","leases:end"]` by `deepEqual`.
  - The report copies every counter: with `reap.children` of length 2, `sweep.removed = 3`, `reconcile` counters `1/2/4` and `refusesNewWork: ["repo_b","repo_a"]`, `leases` counters `5/6`, the returned `RecoveryReport` deep-equals the literal expectation, including `reaped: 2` and `refusesNewWork: ["repo_b","repo_a"]` **unsorted** — the command copies the reconcile step's order and sorts nothing.
  - `findings` is the four lists concatenated in step order, asserted by `deepEqual` against a literal built from one finding per step.
  - A rejection in the reap propagates and the sweep fake was never called.
  - A rejection in the reconcile propagates and the leases fake was never called.
- Extend `src/domain/recovery.test.ts` (Story 02):
  - `deepEqual([...RECOVERY_STEP_ORDER], ["reap", "sweep", "reconcile", "leases"])`.
- **New file `test/helpers/recovery-home.ts`**, so the two daemon tests below build their fixture from one place and the exact row is not left to build time. It exports:

  ```ts
  export const FIXTURE_REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";

  export function seedFixtureRepository(
    homePath: string,
  ): Readonly<{ gitDir: string; lockPath: string }>;
  ```

  It opens `<homePath>/kanthord.db` with `node:sqlite`, runs one INSERT naming all fourteen `repository` columns with these exact values — `id: FIXTURE_REPOSITORY_ID`, `name: "fixture"`, `remote_url: "https://example.invalid/fixture.git"`, `credential_id: <the id of the provider row this helper seeds first>`, `home_path: join(homePath, "repos", "fixture.git")`, `upstream_branch: "main"`, `landing_branch: "kanthord/landing"`, `publish_ref: "refs/heads/kanthord/publish"`, `publish_on_approval: 0`, `state: "ready"`, `diverged_landing_oid: null`, `diverged_upstream_oid: null`, `fetched_upstream_oid: null`, `updated_at: 1700000000000` — then `mkdirSync(<gitDir>/refs/heads, { recursive: true })`, then returns the two paths. `credential_id` is `NOT NULL REFERENCES provider(id)` at `migration-0001-core-entities.ts:44`, and `node:sqlite` enforces the key, so the helper inserts one provider row before the repository row and names its id. Assert the provider-backed credential in this helper's own test rather than assuming the column.

- **The ordering proof, in `src/services/home-lock/startup.test.ts`.** Add two `it` blocks after `:176`, using the existing `createTemporaryHome`, `launchDaemon`, `migrateHome`, `reservePort` and `killAll` helpers. Each block builds its own home; neither relies on another test's daemon, because `after` hooks in this file run at file scope and `killAll()` closes every daemon.
  - `ordering proof: a stale ref lock is gone before the daemon reports ready`. Steps: `migrateHome(home.path)`; `const { lockPath } = seedFixtureRepository(home.path)`; `writeFileSync(lockPath, "")`; launch the daemon and `await first.ready()`. Assert `existsSync(lockPath) === false` **after** `ready()` resolved, `first.stdout() === "kanthord: ready\n"` and `first.stderr() === ""`. Readiness is the observation point, which is what makes the order observable rather than assumed.
  - **`composed proof: a live recorded child is stopped before its lock is removed`.** This is the one test that exercises the four real steps in one daemon. Steps: `migrateHome(home.path)`; `seedFixtureRepository(home.path)`; `writeFileSync(lockPath, "")`; start a long-lived child with `spawn("/bin/sh", ["-c", 'printf "%s" "$$" > "$1"; exec /bin/sleep 30', "sh", pidPath], { detached: true })` where `pidPath` is `<home>/git/run/seed-<FIXTURE_REPOSITORY_ID>.pid`, and wait for the pid file to appear with the `Atomics.wait` poll idiom of `launcher.test.ts:41-50`; launch the daemon and `await first.ready()`. Assert, in this order: `existsSync(lockPath) === false`; `process.kill(childPid, 0)` throws `ESRCH`, so the real reap stopped the real child; `existsSync(pidPath) === false`; and one `event` row exists with `type = 'recovery.childReaped'`, `subject_id = FIXTURE_REPOSITORY_ID` and a payload whose `finding` is `"stopped"`, read with `node:sqlite`. The event is what proves the reap ran, and the missing lock is what proves the sweep ran after it — a sweep that ran first would have removed the lock while the child lived, and no assertion in this test could then distinguish the two orders.
  - **`reconcile` and `leases` are not exercised by a daemon test, and cannot be in this epic.** An open `git_operation` row needs a real bare home with a real ref to resolve, and an expired lease needs a `workspace` row, which needs `git.clone`, which has no caller (`src/services/git/binary.ts:27`). Both steps are proved by their own command tests and by `recover-home.test.ts`'s order assertion. See B4 in `index.md`.
  - Do **not** add a second `home-locked` test: `src/services/home-lock/startup.test.ts:65-91` and `:178-204` already assert exactly that, the second one matching `/^kanthord: home-locked: [^\n]+\n$/` and the first holder's pid. The EPIC's line "a second daemon against the same home exits non-zero naming `home-locked`" is already delivered by the tree, and this story asserts it stays green rather than duplicating it.
  - Do **not** modify `:145-176` (`ref lock created after readiness survives SIGTERM`) or `:228-250` (`first daemon SIGKILL: second daemon reaches readiness with no cleanup step`). Both stay green because neither home holds a `repository` row naming `<home>/repos/a.git`, so the sweep's boundary list is empty for them.
- `node --test src/commands/startup/recover-home.test.ts src/domain/recovery.test.ts src/services/home-lock/startup.test.ts` exits 0.
- The EPIC's `Proof:` block — fourteen explicitly named paths, no glob — prints `PASS EPIC-007.5`.
- `npm run verify` exits 0.
- Proof: delivers `src/commands/startup/recover-home.test.ts` and the `PASS EPIC-007.5` line of the EPIC Proof, plus the ordering proof the EPIC requires beyond it.
