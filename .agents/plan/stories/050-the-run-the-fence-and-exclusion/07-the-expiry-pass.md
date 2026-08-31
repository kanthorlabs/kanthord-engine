# Story 7 — The expiry pass

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 2 (`run.fence` and `run.expires_at` exist), Story 13 (the `run.expired` event type and its payload). Implement Story 13's `src/domain/event-type.ts` and `src/http/contract/event-payload.ts` edits before this story, or the event append fails its schema.

## Change

**Create `src/commands/run/expire-runs.ts`** (greenfield). `src/commands/run/` does not exist; create the directory.

```ts
export type ExpireRunsDependencies = Readonly<{
  events: EventLog;
  instanceId: string;
}>;

export type ExpireRunsInput = Readonly<{ now: number }>;

export type ExpiredRun = Readonly<{
  runId: string;
  nodeId: string;
  fence: number;
}>;

export function expireRuns(
  dependencies: ExpireRunsDependencies,
  transaction: Transaction,
  input: ExpireRunsInput,
): readonly ExpiredRun[];
```

The signature takes the caller's `transaction` as its second parameter, matching `sweepExpiredExternalLeases` at `src/commands/startup/recover-expired-leases.ts`, which `claim-node.ts:107-110` already calls the same way. `expireRuns` opens no transaction of its own; the four callers of Story 8 and Story 10 each open one.

**Body, in this order:**

1. One conditional update, returning the affected rows:

```sql
UPDATE run SET state = 'ended', fence = fence + 1, ended_at = ?, outcome = 'expired'
 WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
RETURNING id, node_id, fence
```

Bind `input.now` twice. The `state = 'active'` predicate in the `WHERE` is what makes the raise idempotent: two racing sweeps cannot both affect the same row, because the second sees `state = 'ended'`. `expires_at IS NOT NULL` protects a legacy row that carries no budget. `<=` makes the boundary instant expired, matching Story 5.

`RETURNING fence` yields the **raised** value, because SQLite's `RETURNING` on an `UPDATE` reports the new row.

2. Sort the returned rows by `id`, bytewise via `Buffer.compare`, so the event order is reproducible.

3. For each row in that order, append one event through `dependencies.events.append(transaction, ...)`:

```ts
{
  subjectKind: "run",
  subjectId: row.id,
  type: "run.expired",
  actorKind: "daemon",
  actorId: dependencies.instanceId,
  payload: { runId: row.id, nodeId: row.node_id, fence: row.fence, expiredAt: input.now },
}
```

The update and every append sit in the caller's one transaction, so a failure at any append rolls the whole pass back and the run stays `active` with its original fence.

4. Return the rows as `ExpiredRun[]` in the same sorted order.

**Do not delete a candidate ref here.** The ref namespace `refs/kanthord/candidate/<runId>/<attemptNo>` is introduced by EPIC 051, nothing in EPIC 050 creates one, and `services/git` carries no ref-delete primitive — `RefUpdateInput.nextOid` at `src/services/git/index.ts:51` is a non-null `string`. EPIC 051 already deletes the ref on acceptance, on rejection and on contention, and owns the startup sweep; it adds the expiry path as a fourth caller of the same deletion. This story ends runs and raises the fence.

**Do not change `node.assignment`, `node.state`, the `lease` table, or any `attempt` row.** An ordinary failure never changes the assignment (Story 11), attempt classification is EPIC 054, and the node-lease mechanism runs beside this one until EPIC 057.

## Constraints

- `expireRuns` runs inside the caller's transaction. It never calls `storage.transact`.
- `outcome = 'expired'` is the only outcome this story writes. `run.outcome` carries no CHECK (`migration-0007-external-execution.ts:25`), so the value is free; pin it to `'expired'`.
- The fence rises by exactly one per run, once. Do not write a second `UPDATE`.
- Do not read the clock. `now` is an input, and the caller reads `dependencies.clock.now()` once as the first statement inside its transaction, per `src/commands/node/claim-node.ts:105`.
- `actorKind: "daemon"` and `actorId: dependencies.instanceId`, matching the ancestor `node.running` appends at `src/commands/node/claim-node.ts:319-333`.

## Verify

```
node --test src/commands/run/expire-runs.test.ts
```

Create `src/commands/run/expire-runs.test.ts`. Suite name `"src/commands/run/expire-runs.test"`. Mirror `src/commands/node/claim-node.test.ts` for the fixture: `createMigratedStorage()` and `databaseBytes` from `test/helpers/database.ts`, `SqliteEventLog` with `createMockIdGenerator`, `seedRegistry` and `seedGraph` from `test/helpers/rows.ts`, `seedRunRow` at `test/helpers/rows.ts:658` for run rows, and `t.after(() => fixture.dispose())`. `const NOW = 1700000000000;` and `const INSTANCE = "daemon_instance_a";`.

Seed run rows through `seedRunRow` extended with the new columns, or by direct `t.run("INSERT INTO run ...")` inside `storage.transact`.

Assert, each as a separate `it`:

1. `"the fence rises by exactly one"` — seed one active run with `fence: 3` and `expires_at: NOW - 1`. Call `expireRuns` inside a `storage.transact`. Read the row and assert `fence === 4`, `state === "ended"`, `outcome === "expired"`, `ended_at === NOW`.

2. `"a second call raises nothing and appends nothing"` — after case 1, call `expireRuns` again in a second transaction with the same `now`. Assert the returned array is empty, assert `fence` is still `4`, and assert the count of `run.expired` events is still `1`. Both halves are asserted, per the EPIC's gate.

3. `"a run whose expires_at is exactly now is expired"` — `expires_at: NOW`. Assert the run ends and the fence rises.

4. `"a run whose expires_at is one millisecond after now is untouched"` — `expires_at: NOW + 1`. Assert the returned array is empty, `state === "active"` and `fence` is unchanged. Cases 3 and 4 pin the boundary from both sides.

5. `"an already ended run is untouched"` — seed `state: "ended"`, `fence: 5`, `expires_at: NOW - 1000`. Assert the returned array is empty and `fence` is still `5`.

6. `"a run with a null expires_at is untouched"` — assert the returned array is empty and the run stays `active`.

7. `"one run.expired event is appended per expired run, carrying the raised fence"` — seed one run with `fence: 3`. After the pass, read the event log and assert exactly one `run.expired` event whose payload deep-equals `{ runId: "<id>", nodeId: "<node id>", fence: 4, expiredAt: NOW }`. The fence in the payload is the raised value, not the stale one.

8. `"two expired runs produce events in bytewise run id order"` — seed active runs `run_b` and `run_a`, both expired. Assert the returned array's `runId` values deep-equal `["run_a", "run_b"]` and the two `run.expired` events appear in that order.

9. `"a failure injected at the event append leaves the run active and the fence unchanged"` — build an `EventLog` whose `append` throws on the first call. Wrap the `storage.transact` in `assert.throws`. Then read the run row in a fresh transaction and assert `state === "active"` and `fence === 3`. Also assert `databaseBytes(storage)` deep-equals the snapshot taken before the call. This proves the transition and the event are one transaction.

10. `"expireRuns writes no node row"` — snapshot `SELECT id, state, assignment FROM node ORDER BY id` before and after a successful pass and assert deep equality. The assignment is unchanged after an expiry, which Story 11 asserts again at the command level.

11. `"expireRuns writes no lease row"` — snapshot `SELECT * FROM lease ORDER BY subject_kind, subject_id` before and after and assert deep equality.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/run/expire-runs.test.ts` in `PASS EPIC-050`.
