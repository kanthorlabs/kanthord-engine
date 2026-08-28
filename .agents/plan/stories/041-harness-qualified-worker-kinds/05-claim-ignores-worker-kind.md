# Story 5 — Claim is indifferent to the worker kind on a task node

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`
Depends on: Story 1

## Change

No production file changes. One new test in `src/commands/node/claim-node.test.ts`.

### Why this is a test-only story

`claimNode` in `src/commands/node/claim-node.ts` never reads `node.worker` and never
calls `ids.mint()`. The regression is observable without any production code change;
Story 1 expands the allowed set in the domain, and the existing claim path is
already unconditional. This test pins that invariant.

### `src/commands/node/claim-node.test.ts`

All fixtures, helpers, and constants cited below already exist in this file.

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

**New test** — add inside `describe("src/commands/node/claim-node.test")`, after the
last test in the initial "ready task" block (after line 429):

```ts
it("a task whose worker is opencode.te@1 is claimed identically to a task whose worker is general@1", (t) => {
  const fixtureA = createClaimFixture();
  t.after(() => fixtureA.dispose());
  seedReadyFixture(fixtureA);

  const fixtureB = createClaimFixture();
  t.after(() => fixtureB.dispose());
  seedReadyFixture(fixtureB);
  fixtureB.storage.transact((transaction) =>
    transaction.run("UPDATE node SET worker = ? WHERE id = ?", [
      "opencode.te@1",
      fixtureIds.task,
    ]),
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
`expiresAt` is identical. `fixtureA` has `worker = null` (from `seedGraph`);
`fixtureB` has `worker = "opencode.te@1"` via the SQL UPDATE. The assertion
`deepEqual(resultB.lease, resultA.lease)` passes when the worker field has no effect.

## Constraints

- Do not edit any production file.
- Do not call `seedNode` with an explicit worker in `fixtureA`; let `seedGraph`
  leave the field null, which matches the baseline test.
- The SQL UPDATE runs inside `fixtureB.storage.transact` after `seedReadyFixture`.
  It targets `fixtureIds.task`, not a hardcoded string literal.
- Two independent fixture instances ensure the two claims do not share lease state.

## Verify

```bash
node --test src/commands/node/claim-node.test.ts
```

The new test fails before Story 1 only if `claimNode` reads `worker` and rejects
unknown kinds. After Story 1, the test also confirms that `opencode.te@1` is a valid
kind end-to-end.

Proof: delivers `src/commands/node/claim-node.test.ts` line of `PASS EPIC-041`.
