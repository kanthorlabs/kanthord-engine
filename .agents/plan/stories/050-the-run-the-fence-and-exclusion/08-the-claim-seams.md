# Story 8 — The claim seams

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 2 (the run columns), Story 3 (`runRow`), Story 4 (`StoredNode.assignment`).
Kind: story-foundation

Three seam names the diagrams of EPIC 050.1 Story 2 to Story 5 draw do not exist yet. This story declares them
and implements them. It draws no path: declaring an interface moves no call.

## Change

**`src/services/plan/index.ts`** gains one method:

```ts
setNodeAssignment(
  transaction: Transaction,
  input: Readonly<{ id: string; assignment: string | null }>,
): void;
```

A node write happens in the plan store — `no-restricted-syntax` enforces it with an enumerated
exemption list — so the claim's assignment write is a plan store method and never an inline update.
The implementation writes `UPDATE node SET assignment = ?, updated_at = ? WHERE id = ?` and touches no
other column.

**`src/services/execution/index.ts`** gains two methods:

```ts
activeRunsOfNodes(
  transaction: Transaction,
  nodeIds: readonly string[],
): readonly RunRecord[];

expireDueRuns(
  transaction: Transaction,
  now: number,
): readonly RunRecord[];
```

`activeRunsOfNodes` is one read serving both pure rules. `subtreeExclusion` passes the subtree ids
from `plan.readSubtree`, and `objectiveBusy` passes the sibling ids from the graph read. A method
named after the objective hierarchy would put plan topology inside the execution capability, which
owns runs and not the tree. `activeRunOfNode` answers a different question — one node, one run — and
cannot answer this one.

`expireDueRuns` performs the conditional update of the epic:

```sql
UPDATE run SET state = 'ended', fence = fence + 1, ended_at = ?, outcome = 'expired'
 WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
RETURNING id, node_id, fence
```

The SQL lives in the execution implementation, because SQL lives where the capability is implemented.
EPIC 050.1 Story 2 wraps it in the command that appends the events.

## Constraints

- No implementation of one capability imports an implementation of another. Both new execution methods live in the execution implementation, and `setNodeAssignment` lives in the plan store.
- Every method takes the caller's `transaction` as its first parameter. None opens one.
- `activeRunsOfNodes` returns no ended and no expired run, and it holds the input order. An empty input returns an empty array without a query.
- `expireDueRuns` returns the **raised** fence, because SQLite's `RETURNING` on an `UPDATE` reports the new row.
- Do not add `activeRunsOfNodes` to any read path outside the claim. EPIC 050.2 has its own seams.

## Verify

```
node --test src/services/plan/sqlite.test.ts src/services/execution/sqlite.test.ts
```

Add, each as a separate `it`:

1. `"setNodeAssignment writes the assignment and touches no other column"` — snapshot the node row before and after and assert only `assignment` and `updated_at` differ.

2. `"setNodeAssignment accepts null"` — assert the column is cleared. No command in this epic calls it with null; EPIC 056 does.

3. `"activeRunsOfNodes returns no ended run"` — seed one active and one ended run and assert only the active one is returned.

4. `"activeRunsOfNodes returns no run the expiry pass already ended"` — call `expireDueRuns` over a due run, then `activeRunsOfNodes` over its node, and assert the result is empty. The method filters on `state = 'active'` alone; the caller's expiry pass is what guarantees no due run still carries that state.

5. `"activeRunsOfNodes holds the input order"` — pass ids in a non-sorted order and assert the result order matches.

6. `"activeRunsOfNodes on an empty input returns an empty array"`.

7. `"expireDueRuns returns the raised fence"` — seed `fence: 3`, `expires_at: NOW - 1`. Assert the returned record carries `fence: 4`.

8. `"expireDueRuns returns zero records on a second call"` — the conditional update makes the raise idempotent.

9. `"expireDueRuns leaves a run whose expires_at is one millisecond after now"` — asserts the boundary from the other side.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts` in `PASS EPIC-050`.
