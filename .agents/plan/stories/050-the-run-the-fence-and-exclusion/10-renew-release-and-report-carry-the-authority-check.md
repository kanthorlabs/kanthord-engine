# Story 10 — Renew, release and report carry the authority check

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 7 (`expireRuns`), Story 9 (`assertRunAuthority`), Story 12 (`runTtlMs` and `runMaxLifetimeMs`), Story 13 (`runId` and `fence` on the three requests).

## Change

### 1 — the rename

Move `src/commands/node/heartbeat-node.ts` to `src/commands/run/renew-run.ts` with `git mv`, and its test to `src/commands/run/renew-run.test.ts`. Rename every exported symbol:

| old                         | new                    |
| --------------------------- | ---------------------- |
| `heartbeatNode`             | `renewRun`             |
| `HeartbeatNodeDependencies` | `RenewRunDependencies` |
| `HeartbeatNodeInput`        | `RenewRunInput`        |
| `HeartbeatNodeResult`       | `RenewRunResult`       |
| `HeartbeatNodeError`        | `RenewRunError`        |
| `HeartbeatRefusal`          | `RenewRefusal`         |

Update the importers: `src/http/server/node/heartbeat-node.ts` (move it to `src/http/server/node/renew-node.ts`), its test, `src/main.ts:560-573`, `src/main.test.ts:169-184`, and `src/cli/node/heartbeat.ts` (move to `src/cli/node/renew.ts`, and change its Commander registration from `heartbeat` to `renew`; `src/cli/node/heartbeat.ts:27` carries the description "renew the lease of a node", and `:60` prints `kanthord: renewed …`, so the wording already fits). One vocabulary survives: `worker.md` names claim, report, close and renew.

`release` keeps its name and its file. It has no verb in `worker.md`, and it is retained with one stated meaning: a worker voluntarily ends its run with no checkpoint. Removing it would make an abandoned claim block a node for a full run lifetime.

### 2 — the renew body

`renewRun` keeps the shipped node-lease renewal at `heartbeat-node.ts:81-107` and adds the run renewal beside it. Inside the one `storage.transact`:

1. `const now = dependencies.clock.now();` — first statement, per `src/commands/node/claim-node.ts:105`.
2. `dependencies.expireRuns(transaction, { now });` — every run operation evaluates expiry first. Sweeping only at the next claim would leave an expired run able to renew itself back to life.
3. Read the run named by `input.runId`.
4. `assertRunAuthority({ run, runId: input.runId, fence: input.fence, targetNodeId: input.nodeId, subtreeIds, caller, now })`. On a refusal, throw `RenewRunError(refusal.refusal, ..., { runId: refusal.runId })`. Step 2 is what makes an expired run reach step 4 already `ended`, so it refuses `run-ended` rather than `run-expired`; both are refusals and the order in Story 9 governs whichever state the row is in.
5. `lifetime-exceeded` — if `now >= run.max_lifetime_at`, throw and write nothing. The comparison is `>=`, so the boundary instant is exceeded.
6. Otherwise `UPDATE run SET expires_at = ? WHERE id = ?` with `Math.min(now + dependencies.runTtlMs, run.max_lifetime_at)`.

**A renew never touches the fence.** The fence rises when a run ends, and nowhere else. A renew that rotated the fence would invalidate the run id and fence pair the worker already holds, which is the authority of that run.

Add `"lifetime-exceeded"` and the six `RunAuthorityRefusalCode` values to `RenewRefusal`.

### 3 — release and report

`src/commands/node/release-node.ts` and `src/commands/outcome/report-outcome.ts` each gain the same three steps at the top of their existing `storage.transact` (`release-node.ts:62-63`, `report-outcome.ts:107-108`):

1. read the clock;
2. call `dependencies.expireRuns(transaction, { now })`;
3. read the run named by `input.runId` and call `assertRunAuthority`, throwing the command's own error class with `{ runId }` as details.

Add `expireRuns`, `runTtlMs` and `runMaxLifetimeMs` to each command's dependencies record as needed, and `runId: string` and `fence: number` to each command's input. `ReleaseNodeInput` at `release-node.ts:33-38` and `ReportOutcomeInput` at `report-outcome.ts:70-75` already carry a `fence`; that field is the **node lease** fence and it stays. Add `runId` and a separate `runFence` field rather than overloading the existing one, and thread `runFence` into `assertRunAuthority`. The two mechanisms run side by side inside one transaction until EPIC 057.

Add the six authority codes to `ReleaseRefusal` at `release-node.ts:11-17` and to `ReportOutcomeRefusal` at `report-outcome.ts:79-85`.

**Neither release nor report changes `node.assignment`.** Ending a run writes `run.state = 'ended'` and raises the fence, and nothing more.

## Constraints

- The fence rises only when a run ends. No renew path writes `fence`.
- `expireRuns` runs before the authority check in all three commands and in the claim of Story 8. Four callers, one pass.
- Do not delete the shipped node-lease logic in any of the three commands.
- Do not change the existing `fence` field's meaning on release or report.
- Preserve the shipped refusal order in each command. The authority check is inserted at the top, after the node read, before every shipped refusal.

## Verify

```
node --test src/commands/run/renew-run.test.ts src/commands/node/release-node.test.ts src/commands/outcome/report-outcome.test.ts src/http/server/node/renew-node.test.ts src/cli/node/renew.test.ts src/main.test.ts
```

Carry every shipped case in `heartbeat-node.test.ts` across to `renew-run.test.ts` unchanged apart from the renamed symbols. Change the suite name to `"src/commands/run/renew-run.test"`.

Add to `src/commands/run/renew-run.test.ts`:

1. `"a successful renew leaves the fence unchanged and moves expires_at forward"` — seed an active run with `fence: 3` and `expires_at: NOW + 1000`. Renew at `NOW`. In one case assert **both** `fence === 3` and `expires_at === NOW + runTtlMs`. One case, two assertions, so the code cannot drift toward rotating the fence on a renew.

2. `"a renew at exactly max_lifetime_at refuses lifetime-exceeded and leaves expires_at unchanged"` — `max_lifetime_at: NOW`, `expires_at: NOW + 1000`. Assert `error.refusal === "lifetime-exceeded"` and, in the same case, that `expires_at` is still `NOW + 1000`.

3. `"a renew one millisecond before max_lifetime_at succeeds"` — `max_lifetime_at: NOW + 1`. Assert the renew succeeds and `expires_at === NOW + 1`, which is `min(now + runTtlMs, max_lifetime_at)` clamped by the lifetime.

4. `"a renew clamps expires_at to max_lifetime_at"` — `runTtlMs` of `300000` with `max_lifetime_at: NOW + 1000`. Assert `expires_at === NOW + 1000`.

5. `"a renew refuses a stale fence"` — run `fence: 4`, presented `fence: 3`. Assert `error.refusal === "fence-stale"` and `expires_at` is unchanged.

6. `"a renew refuses an ended run"` — assert `error.refusal === "run-ended"`.

7. `"a renew on an expired run refuses and writes nothing"` — seed an active run with `expires_at: NOW - 1` and `fence: 3`. Snapshot `databaseBytes`. Renew. Assert the refusal, then assert the run is still `state: "active"` with `fence: 3` and no `run.expired` event, and assert `databaseBytes` deep-equals the snapshot.

   The expiry pass runs first and ends the run, and the refusal then throws, so `src/services/storage/connection.ts:83` rolls the whole callback back — the expiry included. That is the specified behaviour, not a leak: an expired-but-unswept run authorizes nothing, because every run operation runs the pass before it evaluates authority, and the next operation sweeps it. Do not split the expiry into its own transaction to make it survive, and do not return a sentinel and throw after commit; either would break the rule that a refusal writes nothing.

   The refusal code is `run-expired` when the row is read before the pass ends it and `run-ended` when it is read after; the pass runs first, so assert `run-ended`.

8. `"a renew refusal carries only the run id"` — assert `assert.deepEqual(Object.keys(error.details!), ["runId"])`.

Add to `src/commands/node/release-node.test.ts` and `src/commands/outcome/report-outcome.test.ts`, the same three cases each:

9. `"<command> refuses a stale fence"` — assert `refusal === "fence-stale"` and `databaseBytes` unchanged.

10. `"<command> refuses an ended run"` — assert `refusal === "run-ended"` and `databaseBytes` unchanged.

11. `"<command> on an expired run refuses and writes nothing"` — seed an active run with `expires_at: NOW - 1`. Assert the refusal is `run-ended`, and assert `databaseBytes` deep-equals the snapshot taken before the call: the run stays `active`, its fence is unchanged, and no `run.expired` event survives. The expiry rolls back with the refusal, per the EPIC Decision.

Add one case to each of the three files:

12. `"a refusal carries no fence value"` — assert the details key set is exactly `["runId"]` for each of the six authority refusals reachable through the command.

Add to `src/main.test.ts`:

13. `"node.heartbeat is not wired and node.renew is"` — assert the production handler map at `src/main.test.ts:169-184` names `node.renew` and does not name `node.heartbeat`.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/commands/run/renew-run.test.ts`, `src/commands/node/release-node.test.ts` and `src/commands/outcome/report-outcome.test.ts` in `PASS EPIC-050`.
