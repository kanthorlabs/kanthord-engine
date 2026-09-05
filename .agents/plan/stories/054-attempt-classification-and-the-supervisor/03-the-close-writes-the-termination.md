# Story 3 — The close writes the termination

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: Story 6 (`06-the-evidence-union-and-the-classifiers`), for the `Termination` type; Story 1
(`01-migration-16`), for the `attempt.termination` column and the two named CHECKs.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.
`test/helpers/sequence-conformance.ts:64` — `execution.closeAttempt` projects `input.attemptId` alone,
so an added input field changes no token of any diagram that draws the close.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**`termination` is optional at the seam, and that is not a convenience.** Five shipped call sites
write `outcome: "cancelled"` with no termination —
`src/commands/node/release-node.ts:124` — `closeAttempt`,
`src/commands/node/release-node.ts:166` — `closeAttempt`,
`src/commands/node/release-node.ts:262` — `closeAttempt`,
`src/commands/startup/recover-expired-leases.ts:113` — `closeAttempt` and
`src/commands/startup/recover-expired-leases.ts:196` — `closeAttempt` — and EPIC 054.4 is the epic
that gives each one its class. A required field here would not compile on this commit.

**No `setAttemptTermination` is added.** The epic's Decisions reject it:
`src/services/execution/sqlite.ts:294` — `UPDATE attempt SET outcome` is the one writer of
`attempt.outcome`, and EPIC 054.4's closure is measured over its callers.

## Change

### 1 — `src/services/execution/index.ts` — one input field and one record field

**Add one field to `src/services/execution/index.ts:75`** — `CloseAttemptInput`, after
`src/services/execution/index.ts:79` — `headOid`:

```ts
  termination?: Termination | null;
```

**Add one field to `src/services/execution/index.ts:28`** — `AttemptRecord`, after
`src/services/execution/index.ts:34` — `outcome`:

```ts
termination: Termination | null;
```

Import the type beside `src/services/execution/index.ts:1` — `AttemptOutcome`:
`import type { Termination } from "../../domain/termination.ts";`.

**`AttemptRecord` gains `termination` and gains neither `caller` nor `subject`.** The epic's Decisions
enumerate eight construction sites of the type and name `termination` at each; no reader in this
family reads a caller or a subject back through the service, and
`.agents/plan/epics/111-inspection-and-manual-controls.md:30` — `showAttempt` reads both from the
row. A field with no reader is what `pnpm run build` cannot catch and a reviewer has to.

### 2 — `src/services/execution/sqlite.ts` — the column list, the row type and the mapper

**Add `termination` to `src/services/execution/sqlite.ts:25`** — `ATTEMPT_COLUMNS`, last:

```ts
const ATTEMPT_COLUMNS =
  "id, run_id, driver, attempt_no, head_oid, outcome, ended_at, termination";
```

**Add one member to `src/services/execution/sqlite.ts:48`** — `AttemptRow`, after
`src/services/execution/sqlite.ts:55` — `ended_at`: `termination: Termination | null;`.

**Add one line to `src/services/execution/sqlite.ts:80`** — `toAttemptRecord`, after
`src/services/execution/sqlite.ts:88` — `endedAt`: `termination: row.termination,`.

**Add one line to the literal at `src/services/execution/sqlite.ts:276`** — the record `openAttempt`
returns, after `src/services/execution/sqlite.ts:283` — `endedAt`: `termination: null,`. A freshly
opened attempt carries no class, and `attempt_termination_outcome` refuses one on an open row. This
line is not optional: widening `AttemptRecord` in section 1 makes the literal fail `tsc` without it.

`ATTEMPT_COLUMNS` gains `caller` and `subject` **not at all**, matching section 1. The constant feeds
both the `attemptsOfRun` SELECT at `src/services/execution/sqlite.ts:319` and the two
`RETURNING` clauses, so an unmapped column added here would be read on every close for no reader.

### 3 — `src/services/execution/sqlite.ts` — the close writes both columns

**Rewrite the two statements at `src/services/execution/sqlite.ts:292`** — `transaction.all`, adding
`termination = ?` to each and one parameter to each list:

```ts
const writesHeadOid = input.headOid !== undefined;
const rows = transaction.all(
  writesHeadOid
    ? `UPDATE attempt SET outcome = ?, head_oid = ?, ended_at = ?, termination = ?
WHERE id = ? AND outcome IS NULL
RETURNING ${ATTEMPT_COLUMNS}`
    : `UPDATE attempt SET outcome = ?, ended_at = ?, termination = ?
WHERE id = ? AND outcome IS NULL
RETURNING ${ATTEMPT_COLUMNS}`,
  writesHeadOid
    ? [
        input.outcome,
        input.headOid,
        input.at,
        input.termination ?? null,
        input.attemptId,
      ]
    : [input.outcome, input.at, input.termination ?? null, input.attemptId],
) as readonly AttemptRow[];
```

**`termination` is written unconditionally, and `headOid` keeps its two-branch form.** The branch
count stays two rather than four, and that is sound because a termination cannot exist before the
close: `attempt_termination_outcome` refuses a termination on a row whose `outcome` is null, this
statement is the only writer of `attempt.outcome`, and its `WHERE ... AND outcome IS NULL` guard
matches only a row that has never been closed. So `input.termination ?? null` can never overwrite a
stored class. `headOid` cannot take the same treatment:
`src/services/execution/sqlite.ts:291` — `writesHeadOid` flags on `!== undefined` precisely so
`headOid: null` clears the column and an omitted key leaves a stamped head alone.

**`?? null` and not `?? undefined`.** `node:sqlite` binds `undefined` as an error, and the two
meanings this field has — omitted and explicitly null — are one stored value.

**The zero-row path does not change.** `src/services/execution/sqlite.ts:305` — `row === undefined`
throws `ExecutionError("attempt-not-open")`, which is the first-writer-wins signal EPIC 054.1 turns
into a no-op settlement. Do not soften it to a nullable return here.

### 4 — `test/helpers/execution.ts` — mirror all four sites

`test/helpers/execution.ts:217` — `Mirrors the statements of` states
the obligation, and there is no shared code path. Four edits:

1. **`test/helpers/execution.ts:136`** — `ATTEMPT_COLUMNS`, take the same trailing `termination`.
2. **`test/helpers/execution.ts:191`** — `toAttemptRecord`, take the same
   `termination: row.termination,` line, and add `termination` to the local `AttemptRow` type of that
   file.
3. **`test/helpers/execution.ts:439`** — `closeAttempt` of `createBackedExecutionFake`, take
   `termination = ?` in its single UPDATE and `input.termination ?? null` in its parameter list. This
   fake writes `head_oid` unconditionally and diverges from production there; leave that divergence
   alone, and do not copy it to `termination`.
4. **`test/helpers/execution.ts:98`** — the literal returned by `closeAttempt` of
   `createExecutionFake`, take `termination: input.termination ?? null,`.
5. **`test/helpers/execution.ts:429`** — the literal returned by `openAttempt` of
   `createBackedExecutionFake`, take `termination: null,`.

## Constraints

- One statement writes `outcome` and `termination`. No second writer of `attempt.termination` exists
  after this story, and a reviewer checks that by grepping `SET termination` in `src/`.
- The `WHERE id = ? AND outcome IS NULL` guard and the `RETURNING` clause are untouched.
- The parameter order matches the `SET` list. A transposed `at` and `termination` writes an epoch
  into a CHECKed column and fails at run time, not at build time.
- `AttemptRecord` gains `termination` only. Do not add `caller` or `subject` to it, and do not add
  either to `ATTEMPT_COLUMNS`.
- Both `openAttempt` literals carry `termination: null`, and neither carries `caller` or `subject`.
  Story 5 (`05-the-open-records-caller-and-subject`) adds those two to the **input** and to the
  insert, and to neither record.
- Do not change `src/services/execution/index.ts:82` — `ExecutionErrorCode`. The three codes stay.

## Verify

```
node --test src/services/execution/sqlite.test.ts
```

Extend `src/services/execution/sqlite.test.ts`, whose suite is at
`src/services/execution/sqlite.test.ts:152` — `describe`. Build with its own
`src/services/execution/sqlite.test.ts:35` — `build`, open a run with
`src/services/execution/sqlite.test.ts:146` — `executionRunInput`, and assert refusals with
`src/services/execution/sqlite.test.ts:119` — `assertExecutionError` and constraint failures with
`src/services/execution/sqlite.test.ts:106` — `assertConstraint`.

**Update the shipped close case first.**
`src/services/execution/sqlite.test.ts:412` — `closeAttempt writes the outcome and the end instant, and refuses a second close` reads back `outcome` and `ended_at`; add `termination` to its `SELECT` and
assert `null`, so the shipped case states the default rather than ignoring it.

Add, each as a separate `it`:

1. `"a close writes the outcome and the termination in one statement"` — close a freshly opened
   attempt with `{ outcome: "failed", at: AT, termination: "semantic" }`, assert the returned record
   carries `outcome: "failed"` and `termination: "semantic"`, then read
   `SELECT outcome, termination, ended_at FROM attempt WHERE id = ?` and assert all three by value.
   Assert `transaction.all` was reached once by asserting the row's `ended_at` equals `AT`, which only
   the close writes. This is the epic's gate row 6.

2. `"a close with no termination writes null"` — close with `{ outcome: "cancelled", at: AT }` and no
   `termination` key, and assert the stored `termination` is `null` and the returned record's
   `termination` is `null`. A second sub-case passes `termination: null` explicitly and asserts the
   same stored value, which is what proves the two spellings are one stored meaning. This is the
   control for case 1 and the epic's gate row 6.

3. `"a close that stamps a head oid writes the termination too"` — close with
   `{ outcome: "accepted", at: AT, headOid: OID40 }` and assert the stored `head_oid` is `OID40` and
   the stored `termination` is `null`; then, on a second attempt, close with
   `{ outcome: "rejected", at: AT, headOid: OID40, termination: "semantic" }` and assert both
   columns by value. This is the case that covers the `writesHeadOid` branch, which case 1 and case 2
   do not reach.

4. `"a second close of a closed attempt returns zero rows and changes nothing"` — close once with
   `{ outcome: "failed", at: AT, termination: "infrastructure" }`, snapshot
   `SELECT outcome, termination, ended_at, head_oid FROM attempt WHERE id = ?`, then
   `assertExecutionError` around a second close carrying
   `{ outcome: "cancelled", at: AT + 1, termination: "semantic" }` with the code
   `"attempt-not-open"`, and assert the snapshot deep-equals a fresh read. The second close names a
   **different** outcome and a **different** termination, so a statement that lost its
   `outcome IS NULL` guard fails on the stored values and not only on the error. This is the epic's
   gate row 7.

5. `"a close that names an accepted outcome and a termination is refused by the database"` —
   `assertConstraint` around a close carrying
   `{ outcome: "accepted", at: AT, termination: "semantic" }`, asserting
   `/CHECK constraint failed: attempt_termination_outcome/`. This is the case that proves the seam
   passes the value through to the CHECK rather than filtering it, and it is why the epic needs no
   refusal branch in the service.

6. `"attemptsOfRun returns the stored termination"` — close two attempts of one run with
   `"semantic"` and `"infrastructure"`, then assert
   `execution.attemptsOfRun(transaction, runId).map((a) => a.termination)` deep-equals
   `["semantic", "infrastructure"]` by value, in `attempt_no` order. This is what proves
   `ATTEMPT_COLUMNS` and `toAttemptRecord` agree, and Story 7 (`07-accounting-by-class`) case 5 reads
   through it.

7. `"the plain execution fake returns the termination it was given"` — in
   `test/helpers/execution.test.ts` if one exists, and otherwise in
   `src/services/execution/sqlite.test.ts`, call `closeAttempt` on
   `createExecutionFake` at `test/helpers/execution.ts:31` with
   `{ attemptId: "attempt_x", outcome: "failed", at: 1, termination: "semantic" }` and assert the
   returned record's `termination` is `"semantic"`, then call it with no `termination` key and assert
   `null`. The build proves the literal at `test/helpers/execution.ts:98` holds the member; only this
   case proves it holds `input.termination` rather than a hardcoded `null`. The same fake's
   `closeAttemptCalls` at `test/helpers/execution.ts:96` is asserted to carry the input verbatim,
   which is what the command tests read.

8. `"the backed execution fake stores the same termination as the real service"` — in
   `src/services/execution/sqlite.test.ts`, run one close through `SqliteExecution` and the same close
   through `createBackedExecutionFake` at `test/helpers/execution.ts:220` over two temporary
   databases, and assert the two stored `(outcome, termination, ended_at)` triples deep-equal. This is
   what stops the hand-mirrored fake drifting, and `test/helpers/execution.ts:217` — `Mirrors the statements of` states why no shared code path exists to test
   instead.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts` in `PASS EPIC-054`.
