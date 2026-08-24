# Story 05 — `refUpdate`

Epic: `.agents/plan/epics/006-git-primitives.md`
Depends on: Story 01 (`createGitRunner`).

One command, one compare-and-swap, and one best-effort parse of a diagnostic that has no machine-readable alternative.

## Change

### 1. `src/services/git/index.ts` — the pid file on the input

At `src/services/git/index.ts:27-32`, add one member to `RefUpdateInput`:

```ts
export type RefUpdateInput = Readonly<{
  gitDir: string;
  ref: string;
  expectedOid: string | null;
  nextOid: string;
  pidFile: string;
}>;
```

`pidFile` is required, not optional. A `refUpdate` is the write a `git_operation` row journals, and `docs/proposal/phase-3/recovery.md:36` commits the path **before** the spawn. An optional member would let a caller journal nothing and still write a ref.

### 2. `src/services/git/ref-update.ts` (new)

```ts
import {
  GitError,
  type RefUpdateInput,
  type RefUpdateResult,
} from "./index.ts";
import type { GitRunner } from "./run.ts";

export const OBSERVED_OID_PATTERN: RegExp;

export function parseObservedOid(stderr: string): string | null;

export function refUpdate(
  runner: GitRunner,
  input: RefUpdateInput,
): Promise<RefUpdateResult>;
```

`refUpdate` runs exactly one command:

```
git --git-dir=<gitDir> update-ref <ref> <nextOid> <expectedOid ?? "">
```

The third positional argument is always present. An empty string asserts the ref does not exist; `docs/proposal/phase-1/git-foundation.md:162` fixes that meaning. `pidFile` passes straight to `runner`.

On `code === 0`, return `{ updated: true, oid: input.nextOid }`.

On a non-zero code, return `{ updated: false, observedOid: parseObservedOid(result.stderr) }`. It does not throw. A rejected compare-and-swap is the expected answer of a compare-and-swap, and the caller decides what to do with it.

`OBSERVED_OID_PATTERN` is `/\bis at ([0-9a-f]{40}) but expected /`. `parseObservedOid` returns capture group 1, or `null` when the pattern does not match.

Three measured facts fix that pattern and the story's assertions. Each was observed on `git version 2.50.1` under `LC_ALL=C`:

- A wrong non-zero expected object id yields, on standard error:
  `fatal: update_ref failed for ref 'refs/heads/main': cannot lock ref 'refs/heads/main': is at <observed> but expected <expected>`
  and exit code `128`. The observed value is present, and the ref is unchanged.
- An **empty** expected value against an existing ref, and equally an all-zero expected value, yields:
  `... cannot lock ref 'refs/heads/main': reference already exists`
  and exit code `128`. There is no observed object id in that message, so `observedOid` is `null`. This is not a parse defect; the "must not exist" assertion has no competing value to report.
- The message is identical whether the ref is loose or inside `packed-refs`. A `pack-refs --all` before the call does not change either the code or the text.

A parse failure degrades to `observedOid: null`. It never degrades to a wrong object id, and the pattern requires the full forty hexadecimal characters for that reason.

`LC_ALL=C` comes from `gitEnvironment` and is not set here. The parse is only valid under it, and Story 01 owns the pin.

## Constraints

- One `git` command per call. Never read the ref first to build a better message: the read would race the write and the compare-and-swap is the guarantee.
- Never pass `--no-deref`, `--stdin` or `-z`. The three-argument form is the primitive.
- Never treat a non-zero exit as a throw, and never map `reference already exists` to a distinct result member. `RefUpdateResult` has two shapes and gains no third.
- Never use `parseObservedOid` on `stdout`. `update-ref` writes the diagnostic to standard error.
- The observed object id is a hint. Do not add a second command to confirm it — `docs/proposal/phase-1/git-foundation.md:168` puts the re-read in the caller.

## Verify

`node --test src/services/git/ref-update.test.ts` — new file, suite `"src/services/git/ref-update.test"`.

`parseObservedOid` unit cases:

- The full `fatal: ...is at <oid> but expected <oid>` line returns the first object id.
- `"... cannot lock ref 'refs/heads/main': reference already exists"` returns `null`.
- `""` returns `null`.
- A line carrying a 39-character hexadecimal value returns `null` — a short value is never accepted.
- A line carrying `is at deadbeef... but expected` where the value has non-hexadecimal characters returns `null`.

Integration cases. Each copies `seedRepositories(resolveTools()).repositories["fixture.git"].path` into its own `mkdtemp` directory as the bare home, and reads its object ids from `fixtureObjectIds` in `test/helpers/remote/seed.ts`: `C1` is `commit1`, `"7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca"`, and `C2` is `commit2`, `"251c92d5a215053aea80432f179653f99072835d"`. `refs/heads/main` starts at `C2`, and `refs/tags/v1` exists. The two ids and its own `GitPaths` over a `mkdtemp` directory. Every case asserts the ref file state through `git --git-dir=<home> rev-parse <ref>` after the call, never by reading `refs/heads/<name>` as a file, so a packed ref reads the same as a loose one.

- **A matching expected value updates.** With `refs/heads/main` at `C2`, `refUpdate` to `C1` with `expectedOid: C2` resolves `{ updated: true, oid: C1 }`, and `rev-parse` reports `C1`.
- **A stale expected value aborts and reports the observed value.** With the ref at `C2`, `refUpdate` to `C1` with `expectedOid: C1` resolves `{ updated: false, observedOid: C2 }` and `rev-parse` still reports `C2`. This is the epic coverage line "`refUpdate` against a stale expected oid aborts and reports the observed oid, and the ref file is unchanged."
- **The same case with the ref packed.** Run `git --git-dir=<home> pack-refs --all` first, and assert the identical result — `{ updated: false, observedOid: C2 }`. This is why the pattern is not anchored to a loose-ref message.
- **An empty expected value creates.** `refUpdate` of `refs/heads/fresh` to `C1` with `expectedOid: null` resolves `{ updated: true, oid: C1 }`, and `rev-parse` reports `C1`.
- **An empty expected value against an existing ref fails, and reports no observed value.** `refUpdate` of `refs/heads/main` to `C1` with `expectedOid: null` resolves `{ updated: false, observedOid: null }`, and `rev-parse` still reports `C2`. The `null` observed value is asserted, not tolerated. This is the epic coverage line "`refUpdate` with an empty expected value against an existing ref fails and leaves the ref unchanged."
- **A pre-existing lock fails rather than truncates.** Create `<home>/refs/heads/main.lock` with `fs.writeFileSync(lockPath, "sentinel")`, then `refUpdate` of `refs/heads/main` to `C1` with `expectedOid: C2`. Assert the result is `{ updated: false, observedOid: null }`, that `rev-parse` still reports `C2`, and that `fs.readFileSync(lockPath, "utf8")` is still `"sentinel"` — the lock file was neither truncated nor removed. This is the epic coverage line "A pre-existing `.lock` file makes `refUpdate` fail rather than truncate." Remove the lock file in the case's own cleanup so a later case is not affected.
- **The pid file reaches the launcher.** `refUpdate` with `pidFile` under the case directory leaves that file present after a successful call, containing a positive integer. Story 01 fixes the rule: a caller-supplied pid file is never removed by the runner.
- **No hook runs.** Install an executable `<home>/hooks/reference-transaction` that writes a file, then run a successful `refUpdate`, and assert the file was not written. `core.hooksPath=/dev/null` comes from Story 01, and this is the one place in the epic that proves it against a real hook.

`npm run verify` exits 0.

Proof: contributes `src/services/git/ref-update.test.ts` to `node --test src/services/git/**/*.test.ts`.
