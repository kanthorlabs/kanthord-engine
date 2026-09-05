# Story 4 — The node ambiguous counter

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: Story 1 (`01-migration-16`), for the `node.ambiguous_used` column; Story 2
(`02-the-attempt-row`), for `nodeRow.ambiguousUsed`.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.
The two members it adds are drawn for the first time by EPIC 054.1, which is the epic that calls them.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line. `eslint.config.js` needs no edit:
`eslint.config.js:18` — `src/services/plan/sqlite.ts` is already the first entry of
`eslint.config.js:17` — `nodeEdgeWriteExemptions`, and `src/services/plan/sqlite.test.ts` is already
an entry too.

**The counter is not a field of `StoredNode`.** A separate read is what the epic's story list names,
and the reason is the blast radius: `src/services/plan/sqlite.ts:27` — `NODE_COLUMNS`,
`src/services/plan/sqlite.ts:48` — `NodeRow`, `src/services/plan/sqlite.ts:85` — `toNode`, the
`StoredNode` type in `src/domain/plan-graph.ts` and every fake and fixture that builds one would move
for a value three of the four readers of `readNode` never look at.

## Change

### 1 — `src/services/plan/index.ts` — two members

**Add two members to `src/services/plan/index.ts:70`** — `PlanStore`, after
`src/services/plan/index.ts:123` — `setNodeAssignment`, which is the shipped single-column node
mutator they copy:

```ts
  readNodeAmbiguousUsed(transaction: Transaction, id: string): number | null;
  incrementNodeAmbiguousUsed(
    transaction: Transaction,
    input: IncrementNodeAmbiguousUsedInput,
  ): void;
```

**Add the input type**, after `src/services/plan/index.ts:65` — `SetNodeAssignmentInput`:

```ts
export type IncrementNodeAmbiguousUsedInput = Readonly<{ id: string }>;
```

**The read returns `number | null`, and the two values mean different things.** `null` is "no node
carries that id"; `0` is "the node carries a null or a zero counter". That is the shipped convention
for a single-value read — `src/services/plan/index.ts:80` — `newestRevision` and
`src/services/plan/index.ts:94` — `readRepositoryName` both return `T | null` — and collapsing the two
onto `0` would let an unknown node id classify as a fresh crash loop.

**The increment returns `void`, and carries no compare and set.** The epic's Decisions state why: the
read and the update sit in one write transaction, SQLite admits one writer at a time, so a zero-row
result is unreachable and the restart it would guard is dead logic.
`src/commands/node/release-node.ts:103` — `openAttempts` already throws on more than one open attempt
of a run, so two attempts of one node cannot be open at once.

**It returns `void` and not the new value, and no `RETURNING` clause is added.** The caller of
EPIC 054.1 reads the counter to classify before it decides whether to charge it, so
`ambiguousUsedAfter` for the `attempt.ended` payload is that read on an arm that charges nothing and
that read plus one on the arm that increments. `.agents/plan/stories/054.1-the-end-attempt-command/01-a-semantic-ending-and-an-accepted-one.md:17`
— `Seams` draws `plan.readNodeAmbiguousUsed` and no increment on the semantic arm, which is that
split. A `RETURNING` clause would be a second source of the same number, and the epic's Decisions
state the statement without one.

**An input object for one field, matching `SetNodeAssignmentInput`.** A bare `id` string would make
the two new members disagree on shape with each other and with every mutator of the interface.

### 2 — `src/services/plan/sqlite.ts` — two statements

**Add two SQL constants beside `src/services/plan/sqlite.ts:35`** — `UPDATE_NODE_STATE`:

```ts
const SELECT_NODE_AMBIGUOUS_USED =
  "SELECT COALESCE(ambiguous_used, 0) AS ambiguous_used FROM node WHERE id = ?";

const INCREMENT_NODE_AMBIGUOUS_USED =
  "UPDATE node SET ambiguous_used = COALESCE(ambiguous_used, 0) + 1 WHERE id = ?";
```

**Add both methods to `src/services/plan/sqlite.ts:142`** — `SqlitePlanStore`, after
`src/services/plan/sqlite.ts:565` — `setNodeAssignment`:

```ts
  readNodeAmbiguousUsed(transaction: Transaction, id: string): number | null {
    const row = transaction.get(SELECT_NODE_AMBIGUOUS_USED, [id]) as
      | Readonly<{ ambiguous_used: number }>
      | undefined;
    return row === undefined ? null : row.ambiguous_used;
  }

  incrementNodeAmbiguousUsed(
    transaction: Transaction,
    input: IncrementNodeAmbiguousUsedInput,
  ): void {
    transaction.run(INCREMENT_NODE_AMBIGUOUS_USED, [input.id]);
  }
```

**`COALESCE` appears in both statements, and the two defaults must be the same.** The column is
nullable and every historical node holds null, so the read applies the default the increment applies:
a null counter and a zero counter classify identically, and
`convertOnExhaustion` at `src/domain/termination.ts` sees one number either way.

**The `UPDATE node` literal lives here and only here.**
`eslint.config.js:9` — `nodeEdgeWritePattern` matches `update\s+["'`\[]?node\b`, and
`eslint.config.js:17`—`nodeEdgeWriteExemptions`is the enumerated list of files that may hold one.
The`SELECT` matches no clause of that pattern and needs no exemption.

**The increment checks no affected-row count.**
`src/services/plan/sqlite.ts:565` — `setNodeAssignment` is the shipped precedent: an unconditional
`UPDATE node ... WHERE id = ?`, `void` return, no `changes` read.

### 3 — `test/helpers/plan.ts` — the recording wrapper forwards both

**Add two forwarding members to `test/helpers/plan.ts:67`** — `wrapped`, after
`test/helpers/plan.ts:117` — `setNodeAssignment`:

```ts
    readNodeAmbiguousUsed(transaction, id) {
      return plan.readNodeAmbiguousUsed(transaction, id);
    },
    incrementNodeAmbiguousUsed(transaction, input) {
      return plan.incrementNodeAmbiguousUsed(transaction, input);
    },
```

**The build proves the two members exist and no more than that.** `PlanStore` gains two members, so
`test/helpers/plan.ts:67` — `wrapped` fails `tsc` without them — but a forward that returned `0`, or
`null`, or nothing at all still compiles. Case 8 is the value oracle.

**Neither is recorded.** `test/helpers/plan.ts:56` — `RecordedPlanCall` names `"mutateGraph"` and
`"setNodeState"` alone, and `setNodeAssignment` is already forwarded unrecorded. A third recorded
method has no reader in this epic, and EPIC 054.1 observes both calls through
`test/helpers/sequence-conformance.ts` rather than through this wrapper.

## Constraints

- `readNodeAmbiguousUsed` returns `null` for an unknown id, never `0`.
- Both statements are module constants with a bound `?` parameter. No value is interpolated:
  `src/services/plan/sqlite.test.ts:2548` — `the module interpolates no value into SQL and selects no star` scans this file and refuses both.
- `SELECT COALESCE(ambiguous_used, 0) AS ambiguous_used` names its column and selects no star, for the
  same case.
- The increment has no `WHERE ambiguous_used = ?` clause and no `RETURNING` clause.
- Neither method opens a transaction. Both take the caller's `Transaction`, per
  `src/services/plan/index.ts:1` — `Transaction`.
- Do not add `ambiguous_used` to `src/services/plan/sqlite.ts:27` — `NODE_COLUMNS`.

## Verify

```
node --test src/services/plan/sqlite.test.ts
```

Extend `src/services/plan/sqlite.test.ts`, whose suite is at
`src/services/plan/sqlite.test.ts:271` — `describe`. Build with its own
`src/services/plan/sqlite.test.ts:108` — `seedAll` inside
`createMigratedStorage` from `test/helpers/database.ts:32`, and seed the graph with
`seedGraph` at `test/helpers/rows.ts:102`. `seedGraph` writes no `ambiguous_used` value, so a freshly
seeded node carries null, which is the fixture cases 1 and 3 need. Use
`lintCase` at `test/helpers/lint.ts:7` for case 5, in the idiom of
`src/domain/layout.test.ts`.

Add, each as a separate `it`:

1. `"the increment moves a null counter to one and a counter of one to two"` — over a seeded task
   node whose `ambiguous_used` is null, call `incrementNodeAmbiguousUsed` once and assert
   `SELECT ambiguous_used FROM node WHERE id = ?` is `1` by value, then call it again and assert `2`.
   Read the raw column, not the method, so the case cannot pass on a read that also defaults. This is
   the epic's gate row 8.

2. `"the increment from an explicit zero moves to one"` — seed `ambiguous_used = 0` with
   `transaction.run("UPDATE node SET ambiguous_used = 0 WHERE id = ?", [id])`, increment, and assert
   `1`. This is the control that `COALESCE` treats a stored zero and a stored null alike, which case 1
   alone does not show.

3. `"the read of a null column answers zero and the read of an unknown id answers null"` — assert
   `readNodeAmbiguousUsed(transaction, fixtureIds.task)` is `0` on a freshly seeded node, then assert
   `readNodeAmbiguousUsed(transaction, "task_01ZZZ3NDEKTSV4RRFFQ69G5FAV")` is `null`. Both by value,
   and `assert.notEqual(read, 0)` on the second so a `0` returned for an unknown id fails. This is the
   epic's gate row 8.

4. `"the increment writes no other node column and no other node row"` — snapshot
   `SELECT * FROM node ORDER BY id` before the increment, increment the task node, snapshot again, and
   assert the two arrays deep-equal except for `ambiguous_used` on that one row. This is what proves
   the statement carries no second `SET` clause and no widened `WHERE`.

5. `"an UPDATE node outside the plan store is a lint error"` — call
   `lintCase({ filePath: "src/commands/node/claim-node.ts", code: '...UPDATE node SET ambiguous_used = 1...' })`
   with the statement in a string literal, and assert the returned rule ids include
   `"no-restricted-syntax"`. The control is the same code at
   `filePath: "src/services/plan/sqlite.ts"`, which must return an array not holding that rule id.
   Both directions are asserted, because the exemption list is what the epic relies on and an
   assertion that only the violation fails cannot detect an exemption added by mistake. This is the
   epic's gate row 8.

6. `"the increment is deterministic across two calls in one transaction"` — increment twice inside one
   `storage.transact` callback and assert the stored value is `2`, then in a second transaction
   increment once and assert `3`. This is the case that states the epic's no-compare-and-set decision
   as behaviour: two writes in one transaction both land, so no zero-row result exists to guard.

7. `"the recording wrapper forwards both members by value"` — build a real
   `SqlitePlanStore` through `createPlanStore` at `test/helpers/plan.ts:50`, wrap it with
   `createRecordingPlanStore` at `test/helpers/plan.ts:62`, and drive the **wrapper**: assert
   `readNodeAmbiguousUsed` answers `0` on a freshly seeded node, call `incrementNodeAmbiguousUsed`
   through the wrapper, assert the wrapper's next read answers `1`, and assert the raw column is `1`.
   The control is that `calls` at `test/helpers/plan.ts:64` stays empty, which is what states the
   two members are forwarded and deliberately unrecorded. Without this case a wrapper that dropped
   the increment on the floor would compile and pass every other case of this story, because every
   other case drives the store directly.

8. `"the plan store declares no other ambiguous member"` — read
   `src/services/plan/index.ts` as text, and assert the `PlanStore` slice holds exactly the two names
   `readNodeAmbiguousUsed` and `incrementNodeAmbiguousUsed` and holds no `setNodeAmbiguousUsed` and no
   `resetNodeAmbiguousUsed`, in the idiom of
   `src/services/plan/sqlite.test.ts:1196` — `MutateGraphInput declares no trigger member`. The reset
   is EPIC 056's, on a worker switch, and a reset added here would clear the counter with no epic
   asking for it.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/plan/sqlite.test.ts` in `PASS EPIC-054`.
