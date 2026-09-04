# EPIC 050 — The run row and exclusion

Status: **draft**. It follows EPIC 049 by sequence order, and it runs before EPIC 050.1. It consumes EPIC 047's pair table and EPIC 048's registry.

## Goal

The vocabulary of the run, and the rules that decide who may hold one, are written and proven:

- `run.kind` admits `structural`, `execution` and `review`, selected by the node deliverable;
- `runRow` and `runBaseRow` state the final run shape and the base cardinality;
- `assignment` is published on the node row and on the two node projections;
- a run covers the claimed node and every descendant, and one objective branch holds at most one active run;
- both run budgets are configuration, and both are validated at startup.

## Non-goals

- **No schema change, and no claim seam.** EPIC 050.1 lands migration `12`, creates `run_base`, registers it in `src/domain/rows.ts`, and implements `plan.setNodeAssignment`, `execution.activeRunsOfNodes` and `execution.expireDueRuns`. This epic changes no table, because `src/services/execution/sqlite.ts:88` `openRun` writes `parent_run_id`, `lease_fence`, `base_oid`, a null `worker` and the `kind` values `objective` and `task`, and writes none of the four new `NOT NULL` columns. EPIC 050.1 rewrites that insert, and the schema and its only writer therefore change in one epic. The three seams read `run.fence` and `run.expires_at`, so they move with the migration.
- **No claim change.** EPIC 050.1 rewrites `node.claim`, opens the run, wires the exclusion rules into the command and carries the whole `node.claim` wire. This epic writes the vocabulary, the pure rules and the proposal, and it changes no drawn path.
- **No expiry pass.** `src/commands/run/expire-runs.ts` and `execution.expireDueRuns` both land in EPIC 050.1.
- **No renew, no release and no report.** EPIC 050.2 rewrites those three commands, wires `assertRunAuthority` into them, and carries the whole wire and capability announcement.
- **No checkpoint.** A report is accepted in EPIC 051, 052 and 053, one per checkpoint type.
- **No attempt classification.** `termination` lands in EPIC 054. An ended run records `outcome` only.
- **No grant.** The claiming worker comes from a fixed, server-owned caller record, which EPIC 050.1 declares. EPIC 055 replaces that record with a grant lookup.
- **No worker switch, and no operator handoff.** EPIC 056 owns both. A switch is the only operation that changes an assignment.
- **No workspace, and no `run_base` row.** The workspace record and the branch cut belong to EPIC 051, and `worker.md` section 8 says the run's `base` is the workspace `head` at claim time. This epic states the cardinality rule as a zod refine on `runRow`. EPIC 050.1 creates the table, and EPIC 051 writes the row inside the same claim.
- **No node-lease removal.** EPIC 050.3 replaces the plan-write lease guard with a run guard, and EPIC 050.4 removes the node rows of the `lease` table. This epic keeps the lease **mechanism** untouched.

## Decisions

- **The node deliverable selects the run kind, and the worker metadata does not.** `runKindFor(deliverable)` in `src/domain/run-kind.ts` maps `expansion` to `structural`; `test` and `implementation` to `execution`; `review` to `review`. `worker.md` section 5 states this table, and it lists `research` under `execution`; EPIC 047 defers `research` out of the deliverable enum, so the function has no row for it. The function is total over the four deliverables, so no default branch exists. The epic that restores `research` adds its `execution` row.

- **The run owns the fence, and the column is `fence`.** `worker.md` section 7 states the fence is a counter on the run. `runRow` carries `fence` and carries no `lease_fence`; nothing reads `lease_fence`, because there is no legacy reader, and EPIC 050.1's migration `12` drops the column. The daemon raises the fence when it ends a run, and nowhere else.

- **`base` is a set qualified by repository, and it lives in its own table.** `runBaseRow` states `run_base (run_id, repository_id, oid)`, keyed by `(run_id, repository_id)`, and EPIC 050.1's migration `12` creates the table and registers it in `src/domain/rows.ts`. The cardinality is fixed per run kind: an `execution` run holds at most one row, and a `structural` or `review` run holds none. A structural run claims an initiative, which owns no repository, so a mandatory base would make the commonest structural claim illegal.

- **The cardinality rule lands here at its upper bound, and EPIC 051 tightens the lower bound.** This epic states the rule, and EPIC 051 writes the row inside the same claim. An `execution` run therefore holds no row for the whole of this range, so a rule stating _exactly_ one would refuse every run EPIC 050.1 opens. The refine of `runRow` states _at most_ one for `execution`, and exactly none for `structural` and `review`. EPIC 051 raises `execution` to exactly one in the same epic that writes the row. The refine is a schema statement: `runRow` is parsed only in `src/domain/run.test.ts`, and no production path validates a live `run` row against it.

- **`graph_revision` is recorded on every run, and it is enforced only where it is compared.** `worker.md` section 5 now states it: every run records the graph it read, and the daemon compares the value at the structural compare and swap of EPIC 052 and nowhere else. EPIC 050.1's migration `12` therefore adds the column with no kind-conditional CHECK.

- **`graph_revision` is a plan revision identity.** `runRow` types it as a nullable plan revision identity, and EPIC 050.1's migration `12` declares `graph_revision TEXT REFERENCES plan_revision(id)`, nullable. The integer in the `worker.md` YAML example is illustrative and not normative: this schema has no monotonic counter on `plan_revision`, and adding one would create a second version space for the same graph that every import, node write and structural acceptance would have to allocate atomically. A compare and swap needs an immutable token for the snapshot read, the current token read inside the write transaction, and equality between the two. It needs no ordering, so a ULID identity is sufficient and EPIC 052 compares by equality alone — never by `<`, `>` or lexical adjacency, which do not express ancestry. EPIC 050.1 decides which revision the claim records.

- **`provenance` is two columns, not a blob.** `run.worker` keeps the worker id, and `agents_json` holds the agent list from the registry entry. An external run writes `[]`, because a self-managed harness selects its own agents and the daemon observes none. `worker.md` section 5 states the daemon knows both at claim time and asks the worker for neither.

- **This epic publishes `assignment`.** EPIC 047 created the column and left it out of every schema, because the worker id grammar did not exist. `nodeRow`, `StoredNode`, the plan store read path and the `node.show` and `project.graph` projections gain it here, typed as `workerId.nullable()`. The write path is the claim of EPIC 050.1, and the switch of EPIC 056.

- **Exclusion is a subtree rule, and one partial index cannot express it.** `run_one_active` at `src/services/storage/migration-0007-external-execution.ts:33` is unique on `node_id` where `state = 'active'`. That refuses a second run on the same node and admits one on a descendant. The subtree rule is `subtreeExclusion` in `src/domain/run-exclusion.ts`, a pure function the claim evaluates inside its transaction. The index is the last defence for the same-node case only, and the epic does not claim it defends the subtree case.

- **One active run per objective branch, and a task claim is refused, not queued.** `worker.md` section 7 now states the refusal directly: the daemon holds no queue, and a blocking wait would hold one request open for a run lifetime. The rule is `objectiveBusy` in `src/domain/run-exclusion.ts`. The refusal is `objective-busy`, naming the sibling node id, its run id and that run's `expires_at`, so a client knows what it waits on and until when.

- **An expired run is not live, and one predicate decides that for both rules.** A run whose `expires_at` has passed is counted by neither `subtreeExclusion` nor `objectiveBusy`. The boundary instant is expired, and a module-private `isLive(run, now)` helper governs both functions, so the two can never disagree about it.

- **Both budgets are configuration, and both are validated at startup.** `runTtlMs` defaults to 300000 and `runMaxLifetimeMs` to 14400000, in `src/services/config/`. Startup refuses a `runTtlMs` below 1000, a `runMaxLifetimeMs` below `runTtlMs`, and a non-integer. The claim writes `expires_at = now + runTtlMs` and `max_lifetime_at = now + runMaxLifetimeMs`. EPIC 050.2 owns the renew formula and the `lifetime-exceeded` refusal.

## Sequence

This epic draws no diagram. Every story of this epic is a `story-foundation`: a migration, a schema,
a pure function, a service interface, a configuration budget or a proposal document. A path is drawn
by the story that changes it, under `.agents/plan/authoring.md`, and the paths of the claim are drawn
by EPIC 050.1.

## Stories

Each entry is a name and the output it contributes. The story file holds the change and the tasks,
and it declares its kind. `.agents/plan/authoring.md` is the standard.

1. **The run kind** — `src/domain/run-kind.ts` exports `runKindFor`, total over the four deliverables. `story-foundation`.

2. **The run row** — `runRow` and `runBaseRow` in `src/domain/run.ts`, with the cardinality refine at its upper bound. `story-foundation`.

3. **`assignment` is published** — `assignment: workerId.nullable()` on `nodeRow`, `StoredNode`, the plan store read path and the `node.show` and `project.graph` projections. `story-foundation`.

4. **Subtree exclusion** — `subtreeExclusion` in `src/domain/run-exclusion.ts`. `story-foundation`.

5. **The objective-branch rule** — `objectiveBusy` in `src/domain/run-exclusion.ts`, returning the sibling node id, its run id and its `expires_at`. `story-foundation`.

6. **Configuration** — `runTtlMs` and `runMaxLifetimeMs` in `src/services/config/`, with the startup refusals. `story-foundation`.

7. **The proposal records the run model** — `docs/proposal/phase-2/runs-and-exclusion.md` is created, stating the three run kinds and their selection rule, the fence counter, the subtree rule, the objective-branch refusal, the base set, the provenance, the two budgets and the final run shape `runRow` states. The claim half of the document is EPIC 050.1 Story 9, and the authority half is EPIC 050.2 Story 9. `story-foundation`.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/run-kind.test.ts \
  src/domain/run.test.ts \
  src/domain/node.test.ts \
  src/domain/run-exclusion.test.ts \
  src/domain/worker-id.test.ts \
  src/services/plan/sqlite.test.ts \
  src/services/config/convict.test.ts \
  src/services/config/refusals.test.ts \
  src/http/contract/graph.test.ts \
  src/http/contract/parity.test.ts \
  test/helpers/proposal.test.ts \
  && echo "PASS EPIC-050"
```

Hermetic coverage required beyond the Proof:

- `runKindFor` is asserted for all four deliverables by iterating the `deliverables` tuple, so a fifth deliverable fails the test. Story 1.
- A `structural` run holding a `run_base` row is refused by the cardinality refine, a `review` run holding one is refused, and an `execution` run holding two is refused. An `execution` run holding none passes, because EPIC 051 writes the row. Every direction is asserted. Story 2.
- `nodeRow` refuses an `assignment` value outside the worker id grammar, asserted by value. Story 3.
- A second run on a node with an active run is refused by `subtreeExclusion` as a pure function. The index case is EPIC 050.1's. Story 4.
- An expired run in the exclusion input does not refuse. Story 4.
- No refusal object holds a fence value. The assertion scans the refusal details key set. Story 5.
- `objectiveBusy` and `subtreeExclusion` agree on the liveness boundary, asserted over `now - 1`, `now` and `now + 1`, so the shared predicate cannot drift. Story 5.
- `runTtlMs` below 1000, `runMaxLifetimeMs` below `runTtlMs`, and a non-integer are each refused at startup, asserted by value, and `runMaxLifetimeMs` equal to `runTtlMs` starts. Both directions of the boundary. Story 6.
- The run model document names the `refusal` value of each exclusion rule, built by calling the two pure functions rather than restating a literal, so the document and the code cannot drift. The claim refusals are EPIC 050.1's and the authority refusals are EPIC 050.2's; this epic's gate asserts neither. Story 7.
