# Story 04 — The startup sweep

Epic: `.agent/plan/epics/007.5-startup-recovery.md`
Depends on: Story 03 (`src/domain/recovery.ts` and the `ReapReport` the sweep consumes).

## Change

- **New file `src/services/git/sweep.ts`.** It holds every filesystem decision, because `src/commands/**` may import no `node:fs` (`eslint.config.js:233-234`).

  ```ts
  export const LOCK_FILE_NAMES = [
    "FETCH_HEAD.lock",
    "HEAD.lock",
    "commit-graph-chain.lock",
    "commit-graph.lock",
    "config.lock",
    "gc.pid",
    "index.lock",
    "packed-refs.lock",
    "shallow.lock",
  ] as const;

  export const LOCK_SUBTREES = ["objects", "refs"] as const;
  export const STAGING_PREFIX = ".staging-";
  export const KEY_PREFIX = "key-";
  export const HELPER_LOG_PATTERN = /^helper-[0-9a-f-]+\.log$/;
  export const KEPT_KEY_FILES = [
    "credential-helper.sh",
    "ssh-wrapper.sh",
  ] as const;

  export async function sweepHome(
    input: SweepHomeInput,
  ): Promise<SweepHomeReport>;
  ```

- **The declared boundaries.** The command supplies them; the service never discovers a root by walking.

  ```ts
  export type SweepBoundary = Readonly<{
    kind: "bare-home" | "workspace";
    root: string;
    repositoryId: string;
  }>;

  export type SweepHomeInput = Readonly<{
    boundaries: readonly SweepBoundary[];
    keyDirectory: string;
  }>;

  export type SweepRemoval = Readonly<{
    path: string;
    class: "lock" | "staging" | "key-material";
    repositoryId: string | null;
  }>;

  export type SweepRefusal = Readonly<{
    path: string;
    class: "lock" | "staging" | "key-material";
    repositoryId: string | null;
    reason:
      | "outside-boundary"
      | "not-a-regular-file"
      | "not-a-directory"
      | "symlink-on-path";
  }>;

  export type SweepHomeReport = Readonly<{
    removed: readonly SweepRemoval[];
    refused: readonly SweepRefusal[];
  }>;
  ```

- **Candidate collection, per boundary, in this order.** `readdirSync` output is never trusted for order; every list is sorted with `Buffer.compare` before use.

  **Collection matches by name and never by type.** A candidate is any path whose basename matches the class's pattern and for which `lstatSync` succeeds, whatever kind of entry it is. The type test is a **check**, not a filter: a `.staging-abc` that is a regular file and a `main.lock` that is a symbolic link must both become candidates so that they can be refused and reported. A collector that filtered by type would make the refusals unobservable.

  1. `kind: "bare-home"`: for each name in `LOCK_FILE_NAMES`, the path `join(root, name)` when `lstatSync` succeeds. Then, for each subtree in `LOCK_SUBTREES`, an iterative walk of `join(root, subtree)` that emits two kinds of candidate, both of class `"lock"`, and descends into a directory only when that directory is not a symbolic link:

     - every entry whose basename ends with `.lock`, whatever `lstatSync` reports it to be;
     - **every entry that is a symbolic link**, whatever its name.

     The second rule is what makes "a lock reached through a link is reported" observable: the walk cannot know what a link leads to without following it, and following it is the one mistake this pass must never make, so it emits the link and the check below refuses it as `"symlink-on-path"`.

  2. `kind: "workspace"`: the same two passes against `join(root, ".git")`. `index.lock` is already in `LOCK_FILE_NAMES`, and a worktree's index lives under `.git`, so no extra candidate is added at the workspace root.
  3. Staging, both kinds: every entry of `dirname(root)` whose basename starts with `STAGING_PREFIX`, whatever kind of entry it is. `src/services/git/seed.ts:53-55` and `clone.ts:18` both build `join(dirname(target), \`.staging-${randomUUID()}\`)`, so the parent of the boundary is where a staging directory sits.

     **Staging candidates are deduplicated across boundaries.** Two boundaries sharing a parent — every `repository.home_path` is under `<home>/repos/` — would otherwise discover the same staging directory twice and attempt two removals. The command's boundary list is in `repository.id` then `workspace.id` order, and a staging candidate is attributed to the **first** boundary whose parent contains it; a second sighting is dropped, keyed on the candidate's absolute path. The attribution is presentational only: a staging directory records no owner on disk, so the `repositoryId` on its removal names the first boundary that saw it and nothing stronger. See S5 in `index.md`.

  4. Key material, once, not per boundary: every entry of `input.keyDirectory` whose basename starts with `KEY_PREFIX` or matches `HELPER_LOG_PATTERN`, whatever kind of entry it is. `KEPT_KEY_FILES` are never candidates. `src/services/git/credential.ts:110` writes `key-<uuid>` and `:84-86` writes `helper-<uuid>.log`, both `0600`, both remnants of a killed operation; `:21` and `:31` write the two persistent `0700` scripts the daemon needs on the next run.

  The whole ordered candidate list is: boundaries in the order supplied, and within one boundary locks then staging; then the key directory last. Key material is removed in the same pass, and the pass runs before any network operation because Story 07 places recovery before readiness.

- **The three checks, applied to every candidate before removal, in this exact order.** The first check that fails decides the reason; a candidate failing any check is left alone and recorded in `refused`.

  1. **No symbolic link on the path.** Walk from the boundary root down to the candidate one component at a time and `lstatSync` each; any `isSymbolicLink()` — the candidate included — refuses with `"symlink-on-path"`. This check is first so a link is reported as a link rather than as an out-of-boundary path, and so no `realpathSync` runs over a path a link controls.
  2. **Inside a daemon-owned boundary.** `realpathSync(boundaryRoot)` resolved once per root; `realpathSync(dirname(candidate))` for the candidate. `relative(resolvedRoot, resolvedCandidateParent)` must not start with `".."` and must not be absolute. For a staging candidate the boundary is `dirname(root)`; for key material it is `input.keyDirectory`. Reason on failure: `"outside-boundary"`.
  3. **The right kind of entry.** `lstatSync(candidate).isFile()` for `"lock"` and `"key-material"`, otherwise `"not-a-regular-file"`. `lstatSync(candidate).isDirectory()` for `"staging"`, otherwise `"not-a-directory"`.

  Removal is `rmSync(path, { force: true })` for a lock and for key material, and `rmSync(path, { recursive: true, force: true })` for a staging directory. A missing root, a missing subtree and a missing key directory each contribute nothing and refuse nothing.

- **New `Git` member, in `src/services/git/index.ts` after `removePidFile`:**

  ```ts
  sweepHome(input: SweepHomeInput): Promise<SweepHomeReport>;
  ```

  Delegated from `src/services/git/binary.ts` as `sweepHome: (input) => sweepHome(input)`.

- **New file `src/commands/startup/sweep-remnants.ts`.**

  ```ts
  export type SweepRemnantsDependencies = Readonly<{
    storage: Storage;
    git: Git;
    events: EventLog;
    keyDirectory: string;
  }>;

  export type SweepRemnantsInput = Readonly<{
    actor: string;
    reap: ReapReport;
  }>;

  export type SweepRemnantsResult = Readonly<{
    removed: number;
    findings: readonly RecoveryFinding[];
  }>;

  export async function sweepRemnants(
    dependencies: SweepRemnantsDependencies,
    input: SweepRemnantsInput,
  ): Promise<SweepRemnantsResult>;
  ```

  Steps, exactly:

  1. `input.reap` is a required parameter and the command reads no field of it. It is the type-level guard that the sweep cannot be called before a reap ran, and Story 07's ordering test proves the report it receives is the reap's own.
  2. One `storage.transact` reads the boundaries, in this exact order and with these exact statements:
     - `SELECT id, home_path FROM repository ORDER BY id` → one `{ kind: "bare-home", root: home_path, repositoryId: id }` per row.
     - `SELECT w.path, w.repository_id FROM workspace w ORDER BY w.id` → one `{ kind: "workspace", root: path, repositoryId: repository_id }` per row.
  3. `await dependencies.git.sweepHome({ boundaries, keyDirectory: dependencies.keyDirectory })`.
  4. One `storage.transact` appends one event per removal that carries a `repositoryId`, and one per refusal that carries one:

     ```
     subjectKind: "repository", subjectId: repositoryId,
     type: "recovery.remnantRemoved" | "recovery.remnantRefused",
     actorKind: "daemon", actorId: input.actor,
     payload: { path, class, reason? }
     ```

     Key-material entries carry no repository and therefore no event; they reach the operator through `findings`.

  5. Every refusal becomes a `RecoveryFinding` with `step: "sweep"`, `code: refusal.reason`, `repositoryId`, and `detail: \`${refusal.class} ${refusal.path}\``. `removed`is`report.removed.length`.

## Constraints

- The sweep enumerates only from `repository.home_path` and `workspace.path` rows. It never walks the daemon home looking for `*.git`. `src/services/home-lock/startup.test.ts:145-176` plants `<home>/repos/a.git/refs/heads/main.lock` with **no** `repository` row, and that test must stay green untouched: a database-driven boundary list leaves that lock alone.
- `<home>/repos/<name>.git` is the bare home (`src/commands/repository/register-repository.ts:216`). `gitPaths.home` — `<home>/git/home` (`src/services/git/probe.ts:216`) — holds no repository and is not a boundary.
- No command calls `git.clone` yet, so no `workspace` row exists in production. The workspace half is proved by seeded rows, and step 2's statement is written now so no later epic re-decides it.
- `KEPT_KEY_FILES` must never be removed. `credential.ts:64-65` and `:161-166` write them once at `0700` and never recreate them per operation.
- The sweep writes nothing to stdout and nothing to stderr. `src/services/home-lock/startup.test.ts:247-248` pins the daemon's stdout to exactly `kanthord: ready\n` and its stderr to `""` on a clean start.
- Add no configuration key, no column and no migration.

## Verify

- New file `src/services/git/sweep.test.ts`, suite `src/services/git/sweep.test`. Temp directories via `mkdtempSync(join(tmpdir(), "kanthord-sweep-"))` collected in a module array and removed in one `after`. Assertions:
  - A bare home holding `HEAD.lock`, `config.lock`, `packed-refs.lock`, `refs/heads/main.lock`, `refs/tags/v1.lock` and `objects/pack/tmp.lock` reports all six in `removed`, and `existsSync` is `false` for each afterwards.
  - `removed` paths are in bytewise order, asserted by `deepEqual` against the sorted list.
  - A file named `refs/heads/main` (no `.lock`) and a file named `README` in the home are still present afterwards, and appear in neither `removed` nor `refused`.
  - `gc.pid` is removed; a file named `gc.pid.keep` is not.
  - **A lock reached through a symbolic link pointing outside the home is not removed and is reported.** Create `outside/target.lock` beside the home, `symlinkSync` it to `<home>/refs/heads/main.lock`, sweep, then assert `refused` holds exactly one entry for that path with `reason: "symlink-on-path"`, `removed` is empty, `existsSync(outsideTarget)` is `true`, and `lstatSync(<home>/refs/heads/main.lock).isSymbolicLink()` is still `true` — the link itself was not removed either.
  - A `refs/heads` directory that is itself a symbolic link to a directory outside the home is emitted as a candidate and refuses with `"symlink-on-path"`; the walk never descends into it, proved by a `.lock` file inside the target that is still present afterwards and that appears in neither `removed` nor `refused`.
  - **A staging directory from an interrupted seed is removed, and a finished home beside it is untouched.** `dirname(root)` holds `.staging-abc/` and `fixture.git/`; after the sweep `.staging-abc` is gone and `fixture.git` and its `HEAD` file are present.
  - A `.staging-abc` that is a regular file refuses with `"not-a-directory"` and is still present.
  - A `HEAD.lock` that is a directory refuses with `"not-a-regular-file"`.
  - **An ssh key file left by a killed daemon is removed.** A key directory holding `key-abc`, `helper-abc.log`, `credential-helper.sh` and `ssh-wrapper.sh` reports `key-abc` and `helper-abc.log` in `removed` with `class: "key-material"`, and both scripts are still present with mode `0o700` unchanged, read through `statSync(path).mode & 0o777`.
  - A workspace boundary holding `.git/index.lock` and `.git/HEAD.lock` reports both, and a file at `<workspace>/index.lock` is **not** a candidate and is still present.
  - A missing boundary root, a missing key directory and a missing `refs` subtree together produce `{ removed: [], refused: [] }` by `deepEqual`.
  - `LOCK_FILE_NAMES` is bytewise sorted, asserted with `Buffer.compare` over adjacent pairs — the list is data and its order is the removal order.
  - **Two boundaries sharing a parent see one staging candidate.** With `<parent>/a.git`, `<parent>/b.git` and `<parent>/.staging-abc`, `removed` holds exactly one entry for `.staging-abc`, and its `repositoryId` is the first boundary's.
- New file `src/commands/startup/sweep-remnants.test.ts`, suite `src/commands/startup/sweep-remnants.test`. It uses `createRecoveryFixture()` from `test/helpers/recovery.ts` (Story 03) and a Mock `Git` whose `sweepHome` returns the report the case names and records its argument. Assertions:
  - Two `repository` rows and one `workspace` row produce the boundary array in the order `[bare-home(repoA), bare-home(repoB), workspace]`, by `deepEqual` against the recorded argument, with `keyDirectory` equal to the dependency.
  - Repository rows are ordered by `id`: seed them so insertion order reverses sorted order.
  - One removal with a `repositoryId` appends exactly one `recovery.remnantRemoved` event whose payload holds `path` and `class`.
  - One refusal appends exactly one `recovery.remnantRefused` event whose payload holds `path`, `class` and `reason`, and the returned `findings` has one entry with `step: "sweep"` and `code` equal to that reason.
  - A `key-material` removal with `repositoryId: null` appends **no** event; the returned `removed` count still includes it.
  - `removed` equals `report.removed.length`.
  - Every appended event parses with `eventRow`.
  - The command reaches `git.sweepHome` exactly once, whatever the number of boundaries.
- Edit `src/services/git/binary.test.ts`: member count becomes `17`, the array gains `"sweepHome"` after `"stopChild"`, and the suite name says `the seventeen member names`.
- `node --test src/services/git/sweep.test.ts src/commands/startup/sweep-remnants.test.ts src/services/git/binary.test.ts src/services/home-lock/startup.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: delivers `src/commands/startup/sweep-remnants.test.ts` under the EPIC Proof glob.
