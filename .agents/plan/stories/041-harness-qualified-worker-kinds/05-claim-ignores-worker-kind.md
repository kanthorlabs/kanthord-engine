# Story 5 — Claim is indifferent to the worker kind on a task node

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`
Depends on: Story 1

## Change

No production file changes. One new test in `src/commands/node/claim-node.test.ts`, and one new
seed helper in `test/helpers/rows.ts`.

### Why this is a test-only story

`claimNode` in `src/commands/node/claim-node.ts` never reads `node.worker` and never
calls `ids.mint()`. The regression is observable without any production code change;
Story 1 expands the allowed set in the domain, and the existing claim path is
already unconditional. This test pins that invariant.

### `src/commands/node/claim-node.test.ts`

All fixtures, helpers, and constants cited below already exist in this file, except
`seedNodeWorker`, which this Story adds to `test/helpers/rows.ts`.

- `createClaimFixture()` — line 93, builds storage + plan + lease + events
- `seedReadyFixture(fixture)` — line 118, seeds registry, graph (`worker = null`), and
  sets initiative/objective/task to state `"ready"` via `seedNodeState` (SQL UPDATE)
- `claim(fixture, clock, { nodeId, actorId })` — line 215, the test helper; passes
  `createMockIdGenerator({ ulids: [] })` which is safe because `ids.mint()` is never
  called inside `claimNode`
- `ACTOR_A` — `"actor_alpha"`
- `NOW` — `1700000000000`
- `TTL` — `300000`
- `fixtureIds.task`, `fixtureIds.objective` — the ULID IDs for the seeded task and
  objective nodes

### `test/helpers/rows.ts`

**New helper**, added after `seedNodeState`:

```ts
export function seedNodeWorker(
  transaction: Transaction,
  id: string,
  worker: string | null,
): void {
  transaction.run("UPDATE node SET worker = ? WHERE id = ?", [worker, id]);
}
```

Both fixtures use it, so neither carries an inline SQL string.

**New test** — add inside `describe("src/commands/node/claim-node.test")`, after the
last test in the initial "ready task" block (after line 429):

```ts
it("a task whose worker is opencode.te@1 is claimed identically to a task whose worker is general@1", (t) => {
  const fixtureA = createClaimFixture();
  t.after(() => fixtureA.dispose());
  seedReadyFixture(fixtureA);
  fixtureA.storage.transact((transaction) =>
    seedNodeWorker(transaction, fixtureIds.task, "general@1"),
  );

  const fixtureB = createClaimFixture();
  t.after(() => fixtureB.dispose());
  seedReadyFixture(fixtureB);
  fixtureB.storage.transact((transaction) =>
    seedNodeWorker(transaction, fixtureIds.task, "opencode.te@1"),
  );

  const clock = createMockClock({ start: NOW });
  const resultA = claim(fixtureA, clock, {
    nodeId: fixtureIds.task,
    actorId: ACTOR_A,
  });
  const resultB = claim(fixtureB, clock, {
    nodeId: fixtureIds.task,
    actorId: ACTOR_A,
  });

  assert.deepEqual(resultB.lease, resultA.lease);
  assert.deepEqual(resultB.objectiveLease, resultA.objectiveLease);
  assert.equal(resultB.node.state, resultA.node.state);
  assert.equal(resultB.attemptNo, resultA.attemptNo);
});
```

The expected value for both leases (the ground truth from the test at line 410):

```
resultA.lease  = { subjectId: fixtureIds.task,      owner: ACTOR_A, ownerKind: "actor", fence: 1, expiresAt: NOW + TTL }
resultA.objectiveLease = { subjectId: fixtureIds.objective, owner: ACTOR_A, ownerKind: "actor", fence: 1, expiresAt: NOW + TTL }
resultA.node.state = "running"
resultA.attemptNo  = 1
```

Both fixtures use the same `createMockClock({ start: NOW })` instance, so
`expiresAt` is identical. `fixtureA` has `worker = "general@1"`; `fixtureB` has
`worker = "opencode.te@1"`. The assertion `deepEqual(resultB.lease, resultA.lease)` passes when the
worker field has no effect. The baseline names a worker kind, not `null`, so the case also fails a
claim guard that treats an unassigned node and an external kind alike but a local kind differently.
The null case keeps its own coverage: every other test in this file claims a node whose `worker` is
`null`.

## Constraints

- Do not edit any production file.
- Set `fixtureA` to `general@1` explicitly. Do not leave the `seedGraph` null in place; the EPIC
  names `general@1` as the baseline.
- Each `seedNodeWorker` call runs inside that fixture's `storage.transact` after
  `seedReadyFixture`. It targets `fixtureIds.task`, not a hardcoded string literal.
- Two independent fixture instances ensure the two claims do not share lease state.

## Verify

```bash
node --test src/commands/node/claim-node.test.ts
```

The new test fails the moment `claimNode` reads `worker`. It proves claim behaviour for a stored
value only; Story 1 owns the enum and Story 4 owns the import path.

Proof: delivers `src/commands/node/claim-node.test.ts` line of `PASS EPIC-041`.
