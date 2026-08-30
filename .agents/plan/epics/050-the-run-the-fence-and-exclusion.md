# EPIC 050 — The run, the fence and exclusion

Status: **draft**. It follows EPIC 049 by sequence order. It consumes EPIC 047's pair table and EPIC 048's registry.

## Goal

A claim opens exactly one run, and a fence guards every later write:

- `run.kind` admits `structural`, `execution` and `review`, selected by the node deliverable;
- the daemon writes the `assignment` and opens the run in one operation, at the first claim on an unassigned node;
- a run covers the claimed node and every descendant, and at most one run is active over a node;
- every write asserts the run is active, unexpired, bound to the target, and carrying the current fence;
- a run expires against the daemon clock, and a renew is one operation.

## Non-goals

- **No checkpoint.** A report is accepted in EPIC 051, 052 and 053, one per checkpoint type. This epic opens, renews, expires and ends a run.
- **No attempt classification.** `termination` lands in EPIC 054. An ended run here records `outcome` only.
- **No grant.** `authorized` comes from a fixed caller record. EPIC 055 replaces it with a grant lookup.
- **No worker switch, and no operator handoff.** EPIC 056 owns both. A switch is the only operation that changes an assignment, and this epic defines no standalone handoff, because a handoff outside a switch is a state `worker.md` does not describe.
- **No workspace, and no `run_base` row.** The workspace record and the branch cut belong to EPIC 051, and `worker.md` section 8 says the run's `base` is the workspace `head` at claim time. This epic creates the `run_base` table and its cardinality rule. EPIC 051 writes the row inside the same claim.
- **No column drop, and no non-null constraint.** `worker.md` section 13 puts enforcement and legacy removal at step 8. Migration `12` is additive only. `run.base_oid` and `run.lease_fence` survive this epic, and EPIC 057 removes them.
- **No node-lease removal.** The `lease` table keeps its node rows until EPIC 057, and the two mechanisms run side by side inside one transaction.

## Decisions

- **The node deliverable selects the run kind, and the worker metadata does not.** `runKindFor(deliverable)` in `src/domain/run-kind.ts` maps `expansion` to `structural`; `test`, `implementation` and `research` to `execution`; `review` to `review`. `worker.md` section 5 states this table. The function is total over the five deliverables, so no default branch exists.

- **Migration `12` is additive, per `worker.md` section 13.** It widens the `run.kind` CHECK to admit five values — the two shipped and the three new — and it drops nothing. Step 3 of section 13 deploys the writers, step 8 enforces. A migration that dropped `base_oid` and `lease_fence` here would reverse the document's own compatibility strategy, and every in-flight external-drive client would fail at once.

  | column            | migration `12`                                                        | EPIC 057                          |
  | ----------------- | --------------------------------------------------------------------- | --------------------------------- |
  | `kind`            | CHECK admits `objective`, `task`, `structural`, `execution`, `review` | CHECK admits the three new values |
  | `fence`           | added, nullable, backfilled from `lease_fence`                        | `NOT NULL`                        |
  | `lease_fence`     | kept, written in step with `fence`                                    | dropped                           |
  | `base_oid`        | kept, written in step with `run_base`                                 | dropped                           |
  | `graph_revision`  | added, nullable                                                       | unchanged, stays nullable         |
  | `agents_json`     | added, nullable                                                       | `NOT NULL`                        |
  | `expires_at`      | added, nullable                                                       | `NOT NULL`                        |
  | `max_lifetime_at` | added, nullable                                                       | `NOT NULL`                        |
  | `run_base`        | table created                                                         | unchanged                         |

- **The migration refuses to run while a run is active.** A schema change under a live run leaves that run holding a fence the new writers do not read. Migration `12` counts rows where `state = 'active'` and aborts, naming the count and the run ids, in the temp-table-and-trigger pattern of `migration-0009-one-branch.ts:7`. The operator cancels or lets the runs end, then migrates. That makes every backfill question below apply to ended rows only.

- **Every backfill is a stated rule, and none is inferred.** `fence` takes `lease_fence`. `agents_json`, `expires_at`, `max_lifetime_at` and `graph_revision` take null, which the additive columns admit. `run_base` takes one row per ended run whose `base_oid` is not null, with `repository_id` read from the run's node, or from that node's nearest objective ancestor, because `node.repository_id` is non-null exactly for an objective. A run whose `base_oid` is null gets no row. `kind` takes `execution` for every shipped row, because the shipped enum held `objective` and `task`, both of which drove a commit.

- **The run owns the fence, and the column is `fence`.** `worker.md` section 7 states the fence is a counter on the run. `lease_fence` is written in step with `fence` through this epic so a legacy reader still works, and EPIC 057 drops it. The daemon raises the fence when it ends a run.

- **`base` is a set qualified by repository, and it lives in its own table.** Migration `12` creates `run_base (run_id, repository_id, oid, PRIMARY KEY (run_id, repository_id))`. The cardinality is fixed per run kind: an `execution` run holds exactly one row, and a `structural` or `review` run holds none. A structural run claims an initiative, which owns no repository, so a mandatory base would make the commonest structural claim illegal.

- **`graph_revision` is recorded on every run, and it is enforced only where it is compared.** `worker.md` section 5 now states it: every run records the graph it read, and the daemon compares the value at the structural compare and swap of EPIC 052 and nowhere else. Migration `12` therefore adds the column with no kind-conditional CHECK.

- **A review run records the commit it will judge at claim time.** `worker.md` section 8 states a review checkpoint is bound to the pinned commit it judged. Migration `12` adds `run.judged_oid TEXT`, written at claim for a `review` run from the objective workspace head. EPIC 053 binds the attestation to it. Without a claim-time pin, the reviewer chooses what it reviewed.

- **`provenance` is two columns, not a blob.** `run.worker` keeps the worker id, and `agents_json` holds the agent list from the registry entry. An external run writes `[]`, because a self-managed harness selects its own agents and the daemon observes none. `worker.md` section 5 states the daemon knows both at claim time and asks the worker for neither.

- **The assignment and the run open in one storage transaction.** `claimNode` writes `node.assignment` and inserts the `run` row inside the single `storage.transact` block it already opens at `src/commands/node/claim-node.ts:99`. Two operations would let a crash leave an assignment with no run, and the next claim would then read an assignment nobody holds.

- **This epic publishes `assignment`.** EPIC 047 created the column and left it out of every schema, because the worker id grammar did not exist. `nodeRow`, `StoredNode`, the plan store read path and the `node.show` and `project.graph` projections gain it here, typed as `workerId.nullable()`. The write path is the claim, and the switch of EPIC 056.

- **The caller asserts availability, and the daemon never probes.** `worker.md` section 4 states a worker runs a self health check before it claims and declines to claim when the check fails. The daemon therefore takes `available` from the caller: an internal worker self-checks after the supervisor spawns it and reports the result to the supervisor, and an external client self-checks before it claims. A daemon that probed would have to reach into a worker process it does not own, and for a remote worker it could not. The claim request carries `available: boolean`. A `false` value refuses `unroutable` with `failedSet: "available"`. A caller that asserts `true` when it is not available is trusted, and `worker.md` section 11 lists that.

- **A claim is legal only when the assignment equals the claiming worker.** An unassigned node routes through `routeWorker` of EPIC 048 and takes the first worker of the intersection. An assigned node compares. A mismatch refuses with `assignment-held`, and the refusal details name the assignment and state that a human may switch it. `worker.md` section 4 states the offer.

- **An ordinary failure never changes the assignment.** Ending a run writes `run.state = 'ended'` and raises the fence. It does not clear `node.assignment`. A test asserts the assignment is unchanged after an expiry and after a rejection. EPIC 056 adds the only writer that changes it, and it does so as one switch.

- **Run authority is four conditions, not one.** `worker.md` section 11 lists an active run and a matching fence as separate guarantees. `assertRunAuthority({ run, runId, fence, targetNodeId, subtreeIds, caller, now })` refuses in this fixed order: `run-not-found`, `run-ended`, `run-expired`, `run-caller-mismatch`, `target-outside-run`, `fence-stale`. An ended run presented with its own last fence must fail, and a fence comparison alone admits it.

- **A refusal never returns the current fence.** `worker.md` section 5 states the run id and the fence hold the authority of that run. Handing the replacement value to a writer that just proved it holds a stale one gives that writer the authority the raise was meant to remove. The refusal names the run id and the reason only.

- **Every run operation evaluates expiry first, in its own transaction.** Sweeping only at the next claim leaves an expired run able to renew itself back to life. `claim`, `renew`, `release` and `report` each call the same expiry pass before anything else. `src/commands/node/claim-node.ts:104` already holds that sweep, and it is lifted into `src/commands/run/expire-runs.ts` and called by all four.

- **An expiry deletes the candidate ref of the run it ends.** EPIC 051 deletes it on acceptance, on rejection and on contention. An expiry is the fourth path, and without it an abandoned run leaves a ref that keeps a rejected object alive and that a later report could name. The delete happens after the expiry transaction commits, for the reason EPIC 051 gives: a git write cannot join a SQLite transaction. A ref left by a crash is removed by the startup pass of EPIC 051.

- **Expiry is a conditional update, so a concurrent sweep cannot raise the fence twice.** The statement is `UPDATE run SET state = 'ended', fence = fence + 1 WHERE id = ? AND state = 'active' AND expires_at <= ?`, and the transition is recorded only when the update affected one row. Two racing sweeps would otherwise raise the fence twice and append two `run.expired` events.

- **Exclusion is a subtree rule, and one partial index cannot express it.** `run_one_active` at `migration-0007-external-execution.ts:33` is unique on `node_id` where `state = 'active'`. That refuses a second run on the same node and admits one on a descendant. The subtree rule is `subtreeExclusion` in `src/domain/run-exclusion.ts`, evaluated inside the claim transaction. The index is the last defence for the same-node case only, and the epic does not claim it defends the subtree case.

- **The exclusion sets are read inside the claim transaction, from the plan store, and an expired run is not active.** `claimNode` already reads every node at `src/commands/node/claim-node.ts:105`. The ancestor, descendant and sibling sets derive from that read. A run whose `expires_at` has passed is not counted, because the expiry pass above ended it in the same transaction.

- **The claim transaction is an immediate write transaction, so two sibling claims serialise.** `services/storage` opens `BEGIN IMMEDIATE`. Without it, two concurrent claims each read no active sibling run and each insert one. A pure function cannot fix that, and the epic states the isolation requirement rather than assuming it.

- **One active run per objective branch, and a task claim is refused, not queued.** `worker.md` section 7 now states the refusal directly: the daemon holds no queue, and a blocking wait would hold one request open for a run lifetime. The refusal is `objective-busy`, naming the sibling node id, its run id and that run's `expires_at`, so a client knows what it waits on and until when.

- **The refusal order is fixed.** `node-not-found`, `pair-illegal`, `plan-incomplete`, `assignment-held`, `unroutable`, `objective-busy`, `subtree-busy`. A claim that fails two conditions reports the earlier one, so a client sees the cause it can act on first.

- **`node.claim` returns the run id and the fence; it never receives them.** `worker.md` section 5 states a claim comes before the run and the daemon returns both. `runId` and `fence` are response fields on `node.claim`, and request fields on `node.renew`, `node.release` and `node.report`.

- **This epic amends the `/v1` policy, because a human ruled there is no `/v2`.** `docs/proposal/api/README.md:100` forbids adding a required request field and closes its list. EPIC 046 records the ruling. This epic writes the amendment into the proposal: a change outside the list is legal when a human records the ruling in the epic that makes it, and the capability name covering the affected operations is retired and replaced. `023-version-compatibility-policy.md` D1 is superseded by that sentence and by nothing else.

- **The capability swap is the announcement, and it is exact.** `capabilityOperations` at `src/http/contract/capability.ts:5` binds `external-drive` to `node.claim`, `node.heartbeat`, `node.release` and `node.report` — precisely the operations this epic changes. `external-drive` is retired, and `worker-model` is declared in its place, naming `node.claim`, `node.renew`, `node.release` and `node.report`. A client reading `system.health.capabilities` sees `external-drive` gone and cannot call the old shape unknowingly, which is the handshake EPIC 023 built.

- **`node.heartbeat` becomes `node.renew`, and the old operation id is removed.** `worker.md` names four verbs: claim, report, close and renew. One vocabulary survives. `release` has no verb in the document, and it is retained with one stated meaning: a worker voluntarily ends its run with no checkpoint. Removing it would make an abandoned claim block a node for a full run lifetime.

- **`runId` and `fence` are required request fields on `node.renew`, `node.release` and `node.report`.** A worker that cannot name its run has no authority to write, so the schema says so rather than a refusal code. `node.claim` returns both and receives neither.

- **`KANTHORD_VERSION` moves to `28.0.0`.** `src/domain/version.ts:1` reads `27.8.1`. The policy states the package version describes a build, so the bump records this block. The capability list is what describes the wire.

- **Both budgets are configuration, and both are validated at startup.** `runTtlMs` defaults to 300000 and `runMaxLifetimeMs` to 14400000, in `src/services/config/`. Startup refuses a `runTtlMs` below 1000, a `runMaxLifetimeMs` below `runTtlMs`, and a non-integer. A renew sets `expires_at = min(now + runTtlMs, max_lifetime_at)` and refuses `lifetime-exceeded` when `now >= max_lifetime_at`. **A renew never touches the fence.** The fence rises when a run ends, and nowhere else. A renew that rotated the fence would invalidate the run id and fence pair the worker already holds, which is the authority of that run. The comparison is `>=`, so the boundary instant is expired.

## Stories

1. **The run kind.** Add `src/domain/run-kind.ts` with `runKindFor`. Add `src/domain/run-kind.test.ts` asserting the mapping for all five deliverables by value, and asserting the function is exhaustive by iterating `deliverables`.

2. **Migration 12.** Add `src/services/storage/migration-0012-run-model.ts` at version `12`, applying the additive table of the Decisions: the widened `kind` CHECK, the six added columns, the `run_base` table, and the active-run refusal guard in the `migration-0009-one-branch.ts:7` pattern. Register it at `src/services/storage/migrations.ts:13`. Add its test asserting: the guard aborts against a database holding one active run, naming the count and the id; the migration succeeds when every run is ended; `fence` equals `lease_fence` for every backfilled row; `run_base` holds one row per ended run with a non-null `base_oid`, with `repository_id` resolved from the objective ancestor; a run with a null `base_oid` gets no row; every shipped row takes `kind = 'execution'`; and `base_oid` and `lease_fence` still exist.

3. **The run row.** Extend `runRow` at `src/domain/run.ts:11` with the widened kind enum, `fence`, `graphRevision`, `judgedOid`, `agents`, `expiresAt` and `maxLifetimeAt`, each nullable, keeping `baseOid` and `leaseFence`. Add a refine asserting the `run_base` cardinality per kind. Update `src/domain/run.test.ts` with a case per refine.

4. **`assignment` is published.** Add `assignment: workerId.nullable()` to `nodeRow` at `src/domain/node.ts:9` and to `StoredNode` at `src/domain/plan-graph.ts:3`, extend the plan store read path, and add the field to the node projection in `src/http/contract/graph.ts`. Add cases asserting a value outside the worker id grammar is refused by `nodeRow`, and asserting `node.show` returns the assignment.

5. **Subtree exclusion.** Add `src/domain/run-exclusion.ts` with `subtreeExclusion`. Add `src/domain/run-exclusion.test.ts` asserting: a run on an ancestor refuses a claim on a descendant, naming the ancestor; a run on a descendant refuses a claim on an ancestor, naming the descendant; a run on an unrelated node admits the claim; a run on the target itself refuses; an expired run in the input set does not refuse.

6. **The objective-branch rule.** Add `objectiveBusy({ objectiveId, siblingRuns })` to `src/domain/run-exclusion.ts`, returning the sibling node id, the sibling run id and its `expires_at`. Add cases asserting a sibling task with an active run refuses with all three fields, and asserting a sibling task with an ended run admits.

7. **The expiry pass.** Add `src/commands/run/expire-runs.ts` performing the conditional update of the Decisions and appending one `run.expired` event per affected row, in the caller's transaction, then deleting the candidate ref of every run it ended after the transaction commits. Add its test asserting: the fence rises by exactly one; a second call raises nothing and appends nothing; a run whose `expires_at` is exactly `now` is expired; a failure injected at the event append leaves the run active and the fence unchanged.

8. **The claim writes the assignment and opens the run.** Extend `src/commands/node/claim-node.ts` to call the expiry pass, read the pair, compute the run kind, route through `routeWorker` with the caller's `available` assertion, write `node.assignment`, insert the run with its provenance and, for a review run, its `judged_oid` — all inside the transaction opened at line 99. Add the refusals of the Decisions to `ClaimRefusal` at line 27, in the fixed order. Add cases to `src/commands/node/claim-node.test.ts` per refusal, asserting the refusal code and the exact details object, plus a case asserting a claim failing two conditions reports the earlier one.

9. **Run authority.** Add `src/domain/run-authority.ts` with `assertRunAuthority` returning `null` or one of the six refusals in the fixed order. Add `src/domain/run-authority.test.ts` asserting each refusal in isolation, asserting the order by an input failing two conditions, asserting an ended run presented with its own last fence refuses `run-ended`, and asserting no refusal carries a fence value.

10. **Renew, release and report carry the authority check.** Rename `src/commands/node/heartbeat-node.ts` to `src/commands/run/renew-run.ts`, implementing `expires_at = min(now + runTtlMs, max_lifetime_at)` and the `lifetime-exceeded` refusal. Wire `assertRunAuthority` into renew, release and report. Add cases asserting each of the three refuses a stale fence, an ended run and an expired run, and asserting a renew at `max_lifetime_at` refuses while `expires_at` stays unchanged.

11. **An ordinary failure never changes the assignment.** Add cases asserting `node.assignment` is unchanged after an expiry, after a release and after an unroutable claim on a different node. No case exercises an operator handoff, which EPIC 056 introduces.

12. **Configuration.** Add `runTtlMs` and `runMaxLifetimeMs` to `src/services/config/` with the defaults and the startup validation of the Decisions. Add cases asserting each refusal by value and asserting the defaults.

13. **The contract carries the run, the fence and the availability assertion.** Add `available` to the `node.claim` request. Add `runId` and `fence` to the `node.claim` response, and as required fields to the `node.renew`, `node.release` and `node.report` requests. Replace the `node.heartbeat` operation id with `node.renew`. Add the new refusal codes to `src/http/contract/errors.ts`. Register the `run.expired` event type in `src/domain/event-type.ts` and its payload in `src/http/contract/event-payload.ts`. Update the registry, parity, coverage and example tests.

14. **The policy amendment and the capability swap.** Amend `docs/proposal/api/README.md:100` with the exception sentence of the Decisions, and record `023-version-compatibility-policy.md` D1 as superseded. Retire `external-drive` from `capabilityOperations` at `src/http/contract/capability.ts:5` and declare `worker-model` naming the four operations. Move `KANTHORD_VERSION` at `src/domain/version.ts:1` to `28.0.0`. Add a compatibility record to `docs/proposal/api/README.md` listing this epic's four changes. Update `src/http/contract/capability.test.ts`, `src/http/contract/runtime-matrix.test.ts` and the `system.health` example literal at `src/http/contract/system.ts:84`.

15. **The proposal records the run model.** Add `docs/proposal/phase-2/runs-and-exclusion.md` stating the three run kinds and their selection rule, the fence, the four authority conditions, the assignment rule, the subtree rule, the objective-branch refusal and its retry contract, the expiry and maximum lifetime formulas, the refusal order, and the additive-then-enforce migration split.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/run-kind.test.ts \
  src/domain/run.test.ts \
  src/domain/node.test.ts \
  src/domain/run-exclusion.test.ts \
  src/domain/run-authority.test.ts \
  src/services/storage/migration-0012-run-model.test.ts \
  src/services/config/config.test.ts \
  src/commands/run/expire-runs.test.ts \
  src/commands/run/renew-run.test.ts \
  src/commands/node/claim-node.test.ts \
  src/commands/node/release-node.test.ts \
  src/commands/outcome/report-outcome.test.ts \
  src/http/contract/graph.test.ts \
  src/http/contract/parity.test.ts \
  && echo "PASS EPIC-050"
```

Hermetic coverage required beyond the Proof:

- `runKindFor` is asserted for all five deliverables by iterating the `deliverables` tuple, so a sixth deliverable fails the test.
- Migration `12` aborts against a database holding one active run, and the message names the count and the run id.
- After migration `12`, `run.base_oid` and `run.lease_fence` still exist, asserted by reading the table info. The additive-only rule is the assertion, not a comment.
- `fence` equals `lease_fence` for every backfilled row, asserted row by row.
- A `run_base` row is written for an ended run with a non-null `base_oid`, its `repository_id` resolved from the objective ancestor, and no row is written for a run whose `base_oid` is null. Both are asserted.
- A `structural` run holding a `run_base` row is refused by the cardinality refine, and an `execution` run holding none is refused. Both directions are asserted.
- A claim on an unassigned node writes `node.assignment` and inserts the run. A test reads both rows after the transaction and asserts the worker id is equal in each.
- `nodeRow` refuses an `assignment` value outside the worker id grammar, asserted by value.
- A claim on an assigned node by a different worker refuses `assignment-held`, and the details name the current assignment.
- A claim failing both `assignment-held` and `objective-busy` reports `assignment-held`, proving the fixed refusal order.
- A second claim on a node with an active run is refused by `subtreeExclusion` as a pure function, and by the `run_one_active` index against real SQLite. Both are proven, and the index case is the same-node case only.
- A claim on a descendant of a node holding an active run refuses, and the refusal names the ancestor node id.
- An expired run in the exclusion input does not refuse a claim.
- A claim on a task refuses `objective-busy` and the refusal names the sibling node id, the sibling run id and its `expires_at`.
- `assertRunAuthority` refuses an ended run presented with that run's own last fence, with code `run-ended`. A fence comparison alone would admit it.
- No refusal object holds a fence value. The assertion scans the refusal details key set.
- A renew at exactly `max_lifetime_at` refuses `lifetime-exceeded`, and `expires_at` is asserted unchanged.
- A successful renew leaves the fence unchanged and moves `expires_at` forward. Both are asserted in one case, so the code cannot drift toward rotating the fence on a renew.
- A claim carrying `available: false` refuses `unroutable` with `failedSet: "available"`, and no run row is written.
- An expiry deletes the candidate ref of the run it ended, asserted against the loopback fixture by reading the ref after the pass.
- `node.heartbeat` is absent from the registry, and `node.renew` is `routed`. Both are asserted, so the rename is complete rather than additive.
- `declaredCapabilities` omits `external-drive` and includes `worker-model`. The assertion reads the function's real output over the real registry, which is the client-visible announcement of the breaking change.
- A `node.report` omitting `runId` fails schema validation with the issue path `runId`. The field is required on the wire, not enforced by a refusal code.
- The expiry pass raises the fence by exactly one, and a second call raises nothing and appends no second event.
- A failure injected at the `run.expired` event append leaves the run `active` and the fence unchanged, proving the transition and the event are one transaction.
