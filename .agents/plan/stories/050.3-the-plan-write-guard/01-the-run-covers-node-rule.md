# Story 1 — The run-covers-node rule

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: EPIC 050 Story 3 (`runRow`), EPIC 050 Story 5 (`SubtreeExclusionRefusal`, whose shape this read returns).
Kind: story-foundation

This story adds one read to the plan store. It draws no path: declaring and implementing a store
method moves no call in a command. Stories 2 to 6 each add the call.

## Change

**`src/services/plan/index.ts`** gains one method:

```ts
runCoversNode(
  transaction: Transaction,
  seedIds: readonly string[],
  now: number,
): SubtreeExclusionRefusal | null;
```

The command passes the **seed**, never the closure. The store expands it.

**`src/services/plan/sqlite.ts`** implements it in one statement group, in the caller's transaction:

1. Expand the seed to its **descendants** with the recursive walk `readSubtreeContainmentFacts` already uses at `:300`:
   `WITH RECURSIVE descendant(id) AS (SELECT ? UNION ALL SELECT n.id FROM node n JOIN descendant d ON n.parent_id = d.id) SELECT id FROM descendant`.
2. Expand the seed to its **ancestors** with the mirror walk over `parent_id`.
3. Read every covering run over the closure:
   `SELECT id AS run_id, node_id, expires_at FROM run WHERE node_id IN (...) AND state = 'active' AND expires_at > ? ORDER BY node_id ASC, id ASC`.
4. Return `null` when the result is empty. Otherwise return the first row as
   `{ refusal: "subtree-busy", relation, nodeId, runId, expiresAt }`.

**`relation` has a precedence, because a multi-id seed makes one covering node two things at once.**
With `seedIds` of `[O, T]` a run on `O` is `self` for the first member and `ancestor` of the second.
The rule is evaluated over the seed set as a whole, in this order: a covering node **inside** the
seed is `"self"`; otherwise a covering node **above** any seed member is `"ancestor"`; otherwise it is
`"descendant"`. The bytewise tie-break picks the row; this precedence names it. Only `import-plan`
passes more than one id today.

`ORDER BY node_id ASC, id ASC` is the tie-break the epic states: the bytewise-first covering node,
then the first run id. One input always names the same run, so a refusal message is reproducible and
a test asserts it by value.

The liveness predicate is `state = 'active' AND expires_at > ?`, which makes
`expires_at <= now` expired. That is the boundary of `subtreeExclusion` in EPIC 050 and of
`assertRunAuthority` in EPIC 050.2, and Story 4's test asserts the three of them agree.

## Constraints

- Take the caller's `transaction` as the first parameter. Never call `storage.transact`.
- Take `now` as a parameter. The plan store reads no clock, and the caller passes the one `now` it read at the top of its transaction.
- Expand the closure in SQL. A TypeScript walk would need the whole graph in memory and would make the read depend on a prior `readGraph` the callers do not all make.
- Return the refusal shape of `subtreeExclusion` unchanged. A second shape for one condition would owe a second details schema.
- An empty `seedIds` returns `null` without a query.
- Do not read the `lease` table. This method replaces a lease-derived guard; it never consults one.
- The closure is symmetric for every caller. This method takes no direction argument: a run above a
  seed and a run below it both cover, and a mode whose two values no test could tell apart from a bug
  is not worth the parameter.

## Verify

```
node --test src/services/plan/sqlite.test.ts
```

Seed with `seedGraph` from `test/helpers/rows.ts` and `seedRunRow` at `:658`, against
`createMigratedStorage()`. Fixture: initiative `I` holds objective `O`, which holds tasks `T` and `S`.

Assert, each as a separate `it`:

1. `"a run on the seed refuses with relation self"` — seed a run on `T`, call with `[T]`. Assert `{ refusal: "subtree-busy", relation: "self", nodeId: T, runId, expiresAt }` by `assert.deepEqual`.

2. `"a run on an ancestor refuses and names the ancestor"` — run on `O`, call with `[T]`. Assert `relation === "ancestor"` and `nodeId === O`.

3. `"a run on a grandparent refuses"` — run on `I`, call with `[T]`. The walk is transitive, not one level.

4. `"a run on a descendant refuses and names the descendant"` — run on `T`, call with `[O]`. Assert `relation === "descendant"`.

5. `"a run on an unrelated node admits"` — run on `S`, call with `[T]`. Assert `null`. `S` is a sibling, and a sibling is neither above nor below.

6. `"an ended run admits"` — `state: 'ended'` on `T`, call with `[T]`. Assert `null`.

7. `"an expired run admits"` — `expires_at: NOW - 1`. Assert `null`.

8. `"a run expiring exactly at now admits"` — `expires_at: NOW`. Assert `null`. The boundary instant is expired.

9. `"a run expiring one millisecond after now refuses"` — `expires_at: NOW + 1`. With case 8 the boundary is pinned from both sides.

10. `"the bytewise-first covering node wins"` — seed active runs on `I` and on `O`, call with `[T]`, and assert the returned `nodeId` is the bytewise-first of the two. Seed the two rows in both insertion orders and assert the same result, so the answer cannot depend on row order.

11. `"a tie on node id breaks by run id"` — two active runs on one node, seeded in both orders. Assert the bytewise-first run id both times.

12. `"two seed orders give a deep-equal result"` — call with `[T, S]` and with `[S, T]` and assert `assert.deepEqual` of the two results.

13. `"an empty seed returns null"`.

14. `"runCoversNode reads no lease row"` — seed a live node lease on `T` and no run, call with `[T]`, and assert `null`.

15. `"self beats ancestor for a multi-id seed"` — run on `O`, call with `[O, T]`. Assert `relation === "self"`, not `"ancestor"`.

16. `"ancestor beats descendant for a multi-id seed"` — run on `O`, call with `[T, I]`. `O` is above `T` and below `I`, so both relations apply. Assert `relation === "ancestor"`.

**This story owns three cross-cutting proofs**, because each is a property of this read rather than of any one command.

17. `"runCoversNode and assertRunAuthority share one liveness boundary"` — for `expires_at` of `NOW - 1`, `NOW` and `NOW + 1`, assert in one case that `runCoversNode` returns `null` exactly when `assertRunAuthority` refuses the run's own worker with `run-expired`, and returns a refusal exactly when the worker is admitted. Three iterations, both sides asserted, so the two rules cannot drift apart by one millisecond.

18. `"a node left running behind an expired run is still editable"` — seed `T` with `state: 'running'` and a run whose `expires_at` is `NOW - 1`. Assert `runCoversNode` returns `null` and, in the same case, that `assertRunAuthority` refuses that run's worker. Coverage is a property of the run, not of the node state; a rule keyed on `node.state = 'running'` would block edits behind a dead worker until the daemon restarted.

19. `"a concurrent claim and plan write serialise"` — run a claim and an `update-node` against one real database in two transactions and assert the outcome equals one of the two serial orders: either the claim commits and the write refuses `subtree-busy`, or the write commits and the claim then opens its run over the written graph. Assert no interleaved state in either case. `BEGIN IMMEDIATE` serialises the two writers; it does not make one of them lose, and an oracle demanding exactly one winner would fail on a legal execution.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/plan/sqlite.test.ts` in `PASS EPIC-050.3`.
