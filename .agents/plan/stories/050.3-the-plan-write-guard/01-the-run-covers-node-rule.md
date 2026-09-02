# Story 1 — The run-covers-node rule

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: EPIC 050 Story 2 (02-the-run-row), for the `run` row; EPIC 050 Story 4 (04-subtree-exclusion), for `subtreeExclusion` and `SubtreeExclusionRefusal`, whose shape this read returns; EPIC 050.1's migration `12`, drafted at `.agents/plan/pending/050.1-migration-12.md`, which gives `run` its `state` and `expires_at` columns and declares `expires_at` `NOT NULL`; EPIC 050.2 Story 1 (01-run-authority), for `assertRunAuthority`, which cases 19 and 20 compare against.
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

1. Expand the seed to its **descendants** with the recursive walk `readSubtreeContainmentFacts` already uses at `src/services/plan/sqlite.ts:302 — `WITH RECURSIVE``:
   `WITH RECURSIVE descendant(id) AS (SELECT ? UNION ALL SELECT n.id FROM node n JOIN descendant d ON n.parent_id = d.id) SELECT id FROM descendant`.
2. Expand the seed to its **ancestors** with the mirror walk over `parent_id`.
3. Read every covering run over the closure:
   `SELECT id AS run_id, node_id, expires_at FROM run WHERE node_id IN (...) AND state = 'active' AND expires_at > ? ORDER BY node_id ASC, id ASC`.
4. Return `null` when the result is empty. Otherwise select the winning row by **relation class
   first**: the first row whose `node_id` is in the seed, else the first row whose `node_id` is an
   ancestor of a seed member, else the first row. Return it as
   `{ refusal: "subtree-busy", relation, nodeId, runId, expiresAt }`.

**`relation` has a precedence, and it decides before the byte order does.** A multi-id seed makes one
covering node two things at once: with `seedIds` of `[O, T]` a run on `O` is `self` for the first
member and `ancestor` of the second. So does a multi-run result on a single-id seed: with `seedIds`
of `[T]`, runs on `T` and on `I` are `self` and `ancestor`, and `ORDER BY node_id` alone puts
`initiative_a` first and answers `ancestor`. The rule is evaluated over the seed set as a whole, in
this order: a covering node **inside** the seed is `"self"`; otherwise a covering node **above** any
seed member is `"ancestor"`; otherwise it is `"descendant"`. Step 4 applies that order to the ordered
rows, so the class picks the group and `ORDER BY node_id ASC, id ASC` picks the row inside it.

That is exactly the order `subtreeExclusion` evaluates at `src/domain/run-exclusion.ts:88 — `firstMatch``: `self`
before `ancestor` before `descendant`, each class resolved by `compareBytewise` on the node id and
then on the run id. One input always names the same run, so a refusal message is reproducible and a
test asserts it by value.

The liveness predicate is `state = 'active' AND expires_at > ?`, which makes `expires_at <= now`
expired. That is `isLive` of `src/domain/run-exclusion.ts:41 — `isLive`` and the boundary of
`assertRunAuthority` in EPIC 050.2. `expires_at` carries no null branch: EPIC 050.1's migration `12`
declares the column `INTEGER NOT NULL`, so a run with no budget cannot exist and a predicate that
admitted one would be a branch no test could seed.

**The two rules disagree on exactly one row, and migration `12` makes that row unseedable.**
`isLive` admits a null `expires_at` at `src/domain/run-exclusion.ts:43 — `run.expiresAt === null``,
because `SubtreeExclusionRefusal.expiresAt` is `number | null` at
`src/domain/run-exclusion.ts:21 — `expiresAt``. SQL answers the other way: `expires_at > ?` is unknown
for a null, so the row does not cover. Never seed a null `expires_at` in case 18. The column is
`NOT NULL` from migration `12`, so the divergence is unreachable rather than untested, and narrowing
the domain type is EPIC 050.5's work with the rest of the mechanism.

**This read and `subtreeExclusion` are two implementations of one decision, so they are asserted to
agree.** Case 18 drives both from one fixture over every relation and both liveness boundaries. Two
implementations nothing compares are two decisions.

## Constraints

- Take the caller's `transaction` as the first parameter. Never call `storage.transact`.
- Take `now` as a parameter. The plan store reads no clock, and the caller passes the one `now` it read at the top of its transaction.
- Expand the closure in SQL. A TypeScript walk would need the whole graph in memory and would make the read depend on a prior `readGraph` the callers do not all make.
- Return the refusal shape of `subtreeExclusion` unchanged. A second shape for one condition would owe a second details schema.
- Decide the relation class before the byte order. A single `ORDER BY node_id ASC` over the whole result answers `ancestor` where the shipped rule answers `self`.
- An empty `seedIds` returns `null` without a query.
- Do not read the `lease` table. This method replaces a lease-derived guard; it never consults one.
- The closure is symmetric for every caller. This method takes no direction argument: a run above a
  seed and a run below it both cover, and a mode whose two values no test could tell apart from a bug
  is not worth the parameter.

## Verify

```
node --test src/services/plan/sqlite.test.ts src/commands/node/update-node.test.ts
```

Seed with `test/helpers/rows.ts:102 — `seedGraph``, `test/helpers/rows.ts:184 — `seedSiblingTask``
and `test/helpers/rows.ts:688 — `seedRunRow``, against `createMigratedStorage()`. `seedGraph` inserts
three nodes — initiative `I` (`initiative_a`), objective `O` (`objective_a`) under it and task `T`
(`task_a`) under that — asserted at
`test/helpers/rows.test.ts:86 — `seedGraph after seedRegistry inserts one plan_revision and three nodes``.
`seedSiblingTask` adds task `S` (`task_b`) beside `T`. Both seeders are needed: `seedGraph` alone
holds no `S`.

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

10. `"the bytewise-first covering node of the winning class wins"` — seed active runs on `I` and on `O`, call with `[T]`, and assert the returned `nodeId` is `initiative_a`, the bytewise-first of the two ancestors. Seed the two rows in both insertion orders and assert the same result, so the answer cannot depend on row order.

11. `"a self run beats a bytewise-earlier ancestor run"` — seed active runs on `I` (`initiative_a`) and on `T` (`task_a`), call with `[T]`, and assert `relation === "self"` and `nodeId === "task_a"`, by value. `initiative_a` sorts first, so a read that ordered by node id across the classes answers `ancestor` here. Seed the two rows in both insertion orders.

12. `"a tie on node id breaks by run id"` — two active runs on one node, seeded in both orders. Assert the bytewise-first run id both times.

13. `"two seed orders give a deep-equal result"` — call with `[T, S]` and with `[S, T]` and assert `assert.deepEqual` of the two results.

14. `"an empty seed returns null"`.

15. `"runCoversNode reads no lease row"` — seed a live node lease on `T` with `test/helpers/rows.ts:668 — `seedLeaseOnNode`` and no run, call with `[T]`, and assert `null`.

16. `"self beats ancestor for a multi-id seed"` — run on `O`, call with `[O, T]`. Assert `relation === "self"`, not `"ancestor"`.

17. `"ancestor beats descendant for a multi-id seed"` — run on `O`, call with `[T, I]`. `O` is above `T` and below `I`, so both relations apply. Assert `relation === "ancestor"`.

**This story owns four cross-cutting proofs**, because each is a property of this read rather than of any one command.

18. `"runCoversNode and subtreeExclusion return the same refusal"` — for a single-id seed of `[T]`, drive both from one fixture over eight rows: a run on `T`, on `O`, on `I`, on `S`, none at all, an `ended` run, an `expires_at` of `NOW`, and an `expires_at` of `NOW + 1`. Build the `subtreeExclusion` input from the same graph — `targetId: T`, the ancestor ids, the descendant ids and every run row — and assert `assert.deepEqual` of the two results per row. The SQL and the pure function are two implementations of one decision, and nothing else compares them.

19. `"runCoversNode and assertRunAuthority share one liveness boundary"` — for `expires_at` of `NOW - 1`, `NOW` and `NOW + 1`, assert in one case that `runCoversNode` returns `null` exactly when `assertRunAuthority` refuses the run's own worker with `run-expired`, and returns a refusal exactly when the worker is admitted. Three iterations, both sides asserted, so the two rules cannot drift apart by one millisecond.

20. `"a node left running behind an expired run is still editable"` — seed `T` with `state: 'running'` and a run whose `expires_at` is `NOW - 1`. Assert `runCoversNode` returns `null` and, in the same case, that `assertRunAuthority` refuses that run's worker. Coverage is a property of the run, not of the node state; a rule keyed on `node.state = 'running'` would block edits behind a dead worker until the daemon restarted.

21. `"a concurrent claim and plan write serialise"` — in `src/commands/node/update-node.test.ts`, not in the store file: this case runs two whole commands and belongs where a command's dependencies are already built. Run a claim and an `update-node` against one real database in two transactions and assert the outcome equals one of the two serial orders: either the claim commits and the write refuses `subtree-busy`, or the write commits and the claim then opens its run over the written graph. Assert no interleaved state in either case. `BEGIN IMMEDIATE` serialises the two writers; it does not make one of them lose, and an oracle demanding exactly one winner would fail on a legal execution.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/plan/sqlite.test.ts` in `PASS EPIC-050.3`.
