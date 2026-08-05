# Story 07 — Outside-writer diagnostic

Epic: `.agent/plan/epics/006-git-primitives.md`
Depends on: Story 01 (`createGitRunner`). Dispatch it last: it is the only story in the epic that reads the database.

This story delivers a verdict. It writes no event and it sets no state, because "detect, refuse, append an event" is operation-level logic over a storage transaction and `AGENTS.md` puts that in `commands/`. B3 in the index carries the EPIC amendment and names what EPIC 007 must gain, because the behaviour moves rather than disappears.

## Change

### 1. `src/services/git/index.ts` — the transaction on the input

Import the storage transaction context and widen the input at `src/services/git/index.ts:79-84`:

```ts
import type { Transaction } from "../storage/index.ts";

export type OutsideWriterInput = Readonly<{
  transaction: Transaction;
  gitDir: string;
  repositoryId: string;
  ref: string;
  intent: "merge" | "sync" | "publish" | "revert";
}>;
```

A service interface may name another service's interface, and `AGENTS.md` requires the transaction context to arrive that way. The check reads inside the caller's transaction, so the value it compares is the value the caller's write will compare against.

### 2. `src/services/git/ref-read.ts` (new)

```ts
import type { GitRunner } from "./run.ts";

export function resolveRef(
  runner: GitRunner,
  input: Readonly<{ gitDir: string; ref: string }>,
): Promise<string | null>;
```

One command: `git --git-dir=<gitDir> rev-parse --verify --quiet <ref>`. On `code === 0`, return `result.stdout.trim()`. On a non-zero code, return `null`. `--verify --quiet` makes an absent ref an exit code rather than a diagnostic, so an absent ref and a failure are not distinguished by message.

Assert the returned value against `/^[0-9a-f]{40}$/` and throw `GitError("unknown", `rev-parse returned an unexpected value for ${input.ref}`, "")` when it does not match. `rev-parse` on a malformed argument can echo the argument back with exit code 0, and an echoed ref name must never be stored as an object id.

### 3. `src/services/git/outside-writer.ts` (new)

```ts
import type { OutsideWriterInput, OutsideWriterVerdict } from "./index.ts";
import { resolveRef } from "./ref-read.ts";
import type { GitRunner } from "./run.ts";

export const LAST_COMPLETED_SQL: string;

export function lastCompletedOid(
  input: Pick<
    OutsideWriterInput,
    "transaction" | "repositoryId" | "ref" | "intent"
  >,
): string | null;

export function checkOutsideWriter(
  runner: GitRunner,
  input: OutsideWriterInput,
): Promise<OutsideWriterVerdict>;
```

`LAST_COMPLETED_SQL` is exactly:

```sql
SELECT result_head_oid FROM git_operation
WHERE repository_id = ? AND ref = ? AND intent = ?
  AND state = 'complete' AND result_head_oid IS NOT NULL
ORDER BY completed_at DESC, id DESC
LIMIT 1
```

**What this query means, and what it does not.** It returns the ref value recorded by the latest row _by recorded completion time_, tie-broken by identity. It does **not** return "the operation that finished last". `git_operation` carries no monotonic completion sequence, `completed_at` is a millisecond epoch, and a ULID encodes creation order rather than completion order, so two rows completing inside one millisecond have an order this query cannot recover. That is acceptable here and nowhere else: `docs/proposal/phase-1/git-foundation.md:191-197` already states this check is a diagnostic and not a boundary, and the compare-and-swap of Story 05 is what actually protects the write. S4 in the index records the phase-2 fix.

Five properties of that statement are load-bearing.

- `intent = ?` is required, not a convenience. `docs/proposal/database/git_operation.md:45` says `merge` and `sync` name a local `refs/heads/*` while `publish` names a ref on the remote, and both can carry `refs/heads/main`. Without the filter, a publish row answers a question about a local ref.
- `state = 'complete'` excludes an `open` row. An open row is what EPIC 007.5 reconciles, and its `result_head_oid` is null.
- The order is `completed_at DESC, id DESC`. `completed_at` is a millisecond epoch and two rows can share one, so the identity breaks the tie. The identity is a ULID with a monotonic prefix, so the tie-break is a total order and the query is deterministic. `AGENTS.md` forbids a query whose result depends on insertion order.
- `result_head_oid IS NOT NULL` excludes a row that completed **without** writing a ref. `state = 'complete'` alone admits a row whose `outcome` is `auth-failed` or `non-fast-forward`, and such a row reported no ref value. Treating its null as the expected value would make a failed operation the baseline, and every later check would then refuse a ref that is exactly where the last successful operation left it.
- The statement names its one column. `docs/proposal/database/provider.md:61` forbids `SELECT *` across the schema.

`lastCompletedOid` runs that statement with `transaction.get` and returns `result_head_oid`, or `null` when there is no row. The column can no longer be null in a returned row.

`checkOutsideWriter`:

1. `const expected = lastCompletedOid(input)`.
2. `const observed = await resolveRef(runner, { gitDir, ref })`.
3. When `expected === observed`, return `{ expected: true, oid: observed }`. Two nulls are equal: a ref that never existed and has no recorded operation is consistent.
4. Otherwise return `{ expected: false, expectedOid: expected, observedOid: observed }`.

The comparison is `===` on two strings. There is no normalisation, no abbreviation and no case fold: `git` writes a lowercase forty-character object id under every supported version.

## Constraints

- This file writes nothing. It runs no `INSERT`, no `UPDATE`, and it calls no event log. The caller decides what a mismatch means.
- It never sets `needs-reconcile`. `docs/proposal/phase-1/git-foundation.md:189` reserves that state for a landing-to-upstream divergence.
- It never treats a passing verdict as proof the home was untouched. Nothing in this file records a "verified" fact, so nothing downstream can read one.
- `transaction.get` returns `unknown`. Narrow it with a runtime check on the shape before reading the column; do not cast. Assert this through behaviour, not through the source text: feed a table of wrong-shaped rows — `null`, `undefined`, a number, a string, `[]`, `{}`, a wrong-typed column, a null column, an absent column — and require `null` from each. A source scan for `" as "` is not the assertion; it also fires on a legitimate `as const`.
- Do not fall back to `base_oid`. A row with no `result_head_oid` is skipped by the `WHERE` clause, and the baseline is the previous row that did report one, or `null` when there is none.

## Verify

`node --test src/services/git/ref-read.test.ts src/services/git/outside-writer.test.ts` — two new files.

### `ref-read.test.ts`

Against `seedRepositories(resolveTools()).repositories["fixture.git"]` from `test/helpers/remote/seed.ts`, whose `refs/heads/main` is `fixtureObjectIds.commit2`:

- `resolveRef` for `refs/heads/main` returns `"251c92d5a215053aea80432f179653f99072835d"`, asserted as a literal and cross-checked against `fixtureObjectIds.commit2`.
- `resolveRef` for `refs/heads/absent` returns `null`.
- `resolveRef` for `refs/heads/main` after `pack-refs --all` returns the same literal.
- `resolveRef` with `gitDir` naming a directory that is not a repository returns `null` rather than throwing. An unreadable home is EPIC 007.5's refusal, not this primitive's.
- `resolveRef` for the ref name `"HEAD~1x"` returns `null`. `--verify --quiet` makes a malformed ref name a non-zero exit.
- **The shape guard, against a stub runner.** Call `resolveRef` with a hand-written `GitRunner` that resolves `{ code: 0, stdout: "refs/heads/main\n", stderr: "", args: [] }`, and assert it rejects with a `GitError` whose `failure` is `"unknown"`. A real `git` is not needed to prove the guard, and a stub is the only way to produce the value it defends against.

### `outside-writer.test.ts`

Storage comes from `test/helpers/database.ts:30` `createMigratedStorage()`, which is a real `node:sqlite` file with every migration applied. Rows are inserted through `storage.transact` with the identity helpers of `test/helpers/ids.ts` and the clock of `test/helpers/clock.ts`, so every id and timestamp in the case is an exact literal. `git_operation` has foreign keys to `repository`, so each case inserts the `provider` and `repository` parents first; `test/helpers/rows.ts` holds the existing row builders.

- `LAST_COMPLETED_SQL` includes `"intent = ?"`, includes `"state = 'complete'"`, includes `"result_head_oid IS NOT NULL"`, includes `"ORDER BY completed_at DESC, id DESC"`, and does not include `"SELECT *"`.
- **A match.** One `complete` `sync` row with `result_head_oid = C1` for `refs/heads/main`, and the ref at `C1`. The verdict is `{ expected: true, oid: C1 }`.
- **A mismatch reports both values.** The same row, and the ref moved to `C2` by a direct `runGit` `update-ref` that stands in for the human. The verdict is `{ expected: false, expectedOid: C1, observedOid: C2 }`. This is the diagnostic's whole purpose, asserted with two exact literals.
- **No recorded operation and no ref.** No row, and a ref name that does not exist. The verdict is `{ expected: true, oid: null }`.
- **No recorded operation and a live ref.** No row, and the ref at `C1`. The verdict is `{ expected: false, expectedOid: null, observedOid: C1 }`.
- **The intent filter.** A `complete` `publish` row with `result_head_oid = C9` on `refs/heads/main`, plus a `complete` `sync` row with `C1` on the same ref, and the ref at `C1`. A check with `intent: "sync"` is `expected: true`. A check with `intent: "publish"` is `expected: false` with `expectedOid: C9` and `observedOid: C1`. Without the filter the first assertion fails, so this case is the filter's mechanism.
- **The order and its tie-break.** Two `complete` `sync` rows on one ref sharing one `completed_at`, with ids `gitop_01...A` and `gitop_01...B` and result heads `C1` and `C2`. The verdict compares against `C2`, the higher identity. Insert them in both orders in two subtests and assert the same verdict. This proves the tie-break is **deterministic**; it does not prove `C2` is the value written last, and the story's own text says so. Name the test accordingly — "the tie-break is deterministic", not "the last write wins".
- **An open row is ignored.** One `open` `sync` row with `result_head_oid` null, and one older `complete` row with `C1`. The check compares against `C1`.
- **A completed row that reported no ref value is skipped.** Two `complete` `sync` rows on one ref: the older with `result_head_oid = C1`, the newer with `result_head_oid` null and `outcome = "auth-failed"`. With the ref at `C1`, the verdict is `{ expected: true, oid: C1 }`. Without the `IS NOT NULL` clause the newer row wins and the verdict inverts, so this case is that clause's mechanism.
- **A failed operation is never the baseline, even alone.** One `complete` row with `result_head_oid` null, and the ref at `C1`. The verdict is `{ expected: false, expectedOid: null, observedOid: C1 }` — there is no baseline, which is the same answer as no row at all. It does not fall back to `base_oid`.
- **Nothing is written.** Snapshot `SELECT id, state, outcome, completed_at FROM git_operation ORDER BY id` and the full `event` table before and after a mismatching check, and assert both are deep-equal. The diagnostic writes nothing, and this is the assertion that fails if a reviewer moves the event write into the service.

`npm run verify` exits 0.

Proof: contributes `src/services/git/ref-read.test.ts` and `src/services/git/outside-writer.test.ts` to `node --test src/services/git/**/*.test.ts`.
