# EPIC 050 — The run row and exclusion

Status: **draft**. It follows EPIC 049 by sequence order, and it runs before EPIC 050.1. It consumes EPIC 047's pair table and EPIC 048's registry.

## Goal

The run row exists, and the rules that decide who may hold one are written and proven:

- `run.kind` admits `structural`, `execution` and `review`, selected by the node deliverable;
- migration `12` lands the final `run` shape, creates `run_base`, and makes `node.deliverable` and `node.verify_json` non-null;
- `assignment` is published on the node row and on the two node projections;
- a run covers the claimed node and every descendant, and one objective branch holds at most one active run;
- both run budgets are configuration, and both are validated at startup.

## Non-goals

- **No claim change.** EPIC 050.1 rewrites `node.claim`, opens the run, wires the exclusion rules into the command and carries the whole `node.claim` wire. This epic writes the schema, the pure rules, the seams and the proposal, and it changes no drawn path.
- **No expiry pass.** `src/commands/run/expire-runs.ts` lands in EPIC 050.1. This epic declares `execution.expireDueRuns` on the execution interface and implements it.
- **No renew, no release and no report.** EPIC 050.2 rewrites those three commands, wires `assertRunAuthority` into them, and carries the whole wire and capability announcement.
- **No checkpoint.** A report is accepted in EPIC 051, 052 and 053, one per checkpoint type.
- **No attempt classification.** `termination` lands in EPIC 054. An ended run records `outcome` only.
- **No grant.** The claiming worker comes from a fixed, server-owned caller record, which EPIC 050.1 declares. EPIC 055 replaces that record with a grant lookup.
- **No worker switch, and no operator handoff.** EPIC 056 owns both. A switch is the only operation that changes an assignment.
- **No workspace, and no `run_base` row.** The workspace record and the branch cut belong to EPIC 051, and `worker.md` section 8 says the run's `base` is the workspace `head` at claim time. This epic creates the `run_base` table and its cardinality rule. EPIC 051 writes the row inside the same claim.
- **No node-lease removal.** EPIC 050.3 replaces the plan-write lease guard with a run guard, and EPIC 050.4 removes the node rows of the `lease` table. This epic keeps the lease **mechanism** untouched.

## Decisions

- **The node deliverable selects the run kind, and the worker metadata does not.** `runKindFor(deliverable)` in `src/domain/run-kind.ts` maps `expansion` to `structural`; `test` and `implementation` to `execution`; `review` to `review`. `worker.md` section 5 states this table, and it lists `research` under `execution`; EPIC 047 defers `research` out of the deliverable enum, so the function has no row for it. The function is total over the four deliverables, so no default branch exists. The epic that restores `research` adds its `execution` row.

- **Migration `12` lands the final shape, because there is nothing to be compatible with.** There are no deployments, so there is no run row to preserve, no client to break and no additive window to hold open. The compatibility strategy `worker.md` describes solved a problem this product does not have, and building it would mean writing a guard, five backfill rules and their tests, then deleting all of it in EPIC 057.

  Migration `12` rebuilds `run` empty and applies the final constraints at once:

  | column            | migration `12`                                          |
  | ----------------- | ------------------------------------------------------- |
  | `kind`            | `CHECK (kind IN ('structural', 'execution', 'review'))` |
  | `fence`           | `INTEGER NOT NULL`                                      |
  | `graph_revision`  | `TEXT REFERENCES plan_revision(id)`, nullable           |
  | `agents_json`     | `TEXT NOT NULL`, `json_valid`                           |
  | `expires_at`      | `INTEGER NOT NULL`                                      |
  | `max_lifetime_at` | `INTEGER NOT NULL`                                      |
  | `judged_oid`      | `TEXT`, nullable                                        |
  | `lease_fence`     | **dropped**                                             |
  | `base_oid`        | **dropped**                                             |
  | `run_base`        | table created                                           |

  `objective` and `task` leave the `kind` set entirely. `graph_revision` stays nullable because EPIC 052 is the only reader and a run that never reaches a structural checkpoint needs no value.

- **The migration discards every `run` and `attempt` row rather than backfilling one.** No deployment holds them, and a developer's local database is rebuilt from `kanthord db migrate` at will. `DELETE FROM attempt` then `DELETE FROM run` runs before the rebuild, so the `NOT NULL` columns land with no row to violate them and no backfill rule has to be invented. State this in the migration's name and in `docs/proposal/database/run.md`: migration `12` is destructive to run history and to nothing else. It touches no `node`, `edge`, `blob`, `plan_revision`, `project` or `repository` row.

- **`node.deliverable` and `node.verify_json` become `NOT NULL` here, and `node.worker` is dropped.** The dual-read window of EPIC 049 exists to keep a legacy plan document readable during a conversion. With no deployment there is nothing to convert in place: the `kanthord-apps` tree is converted before this epic lands, by `plan convert`, and the engine then reads one shape. Migration `12` therefore refuses to run while any node holds a null `deliverable`, naming the project id and the count, in the temp-table-and-trigger pattern of `migration-0009-one-branch.ts:7`. That refusal is the whole of what EPIC 057's preflight was going to do.

- **The run owns the fence, and the column is `fence`.** `worker.md` section 7 states the fence is a counter on the run. `lease_fence` is dropped by migration `12`; nothing reads it, because there is no legacy reader. The daemon raises the fence when it ends a run, and nowhere else.

- **`base` is a set qualified by repository, and it lives in its own table.** Migration `12` creates `run_base (run_id, repository_id, oid, PRIMARY KEY (run_id, repository_id))`. The cardinality is fixed per run kind: an `execution` run holds at most one row, and a `structural` or `review` run holds none. A structural run claims an initiative, which owns no repository, so a mandatory base would make the commonest structural claim illegal.

- **The cardinality rule lands here at its upper bound, and EPIC 051 tightens the lower bound.** This epic creates the table and the rule, and EPIC 051 writes the row inside the same claim. An `execution` run therefore holds no row for the whole of this range, so a rule stating _exactly_ one would refuse every run EPIC 050.1 opens. The refine of `runRow` states _at most_ one for `execution`, and exactly none for `structural` and `review`. EPIC 051 raises `execution` to exactly one in the same epic that writes the row. The refine is a schema statement: `runRow` is parsed only in `src/domain/run.test.ts`, and no production path validates a live `run` row against it.

- **`graph_revision` is recorded on every run, and it is enforced only where it is compared.** `worker.md` section 5 now states it: every run records the graph it read, and the daemon compares the value at the structural compare and swap of EPIC 052 and nowhere else. Migration `12` therefore adds the column with no kind-conditional CHECK.

- **`graph_revision` is a plan revision identity.** Migration `12` declares `graph_revision TEXT REFERENCES plan_revision(id)`, nullable. The integer in the `worker.md` YAML example is illustrative and not normative: this schema has no monotonic counter on `plan_revision`, and adding one would create a second version space for the same graph that every import, node write and structural acceptance would have to allocate atomically. A compare and swap needs an immutable token for the snapshot read, the current token read inside the write transaction, and equality between the two. It needs no ordering, so a ULID identity is sufficient and EPIC 052 compares by equality alone — never by `<`, `>` or lexical adjacency, which do not express ancestry. EPIC 050.1 decides which revision the claim records.

- **`provenance` is two columns, not a blob.** `run.worker` keeps the worker id, and `agents_json` holds the agent list from the registry entry. An external run writes `[]`, because a self-managed harness selects its own agents and the daemon observes none. `worker.md` section 5 states the daemon knows both at claim time and asks the worker for neither.

- **This epic publishes `assignment`.** EPIC 047 created the column and left it out of every schema, because the worker id grammar did not exist. `nodeRow`, `StoredNode`, the plan store read path and the `node.show` and `project.graph` projections gain it here, typed as `workerId.nullable()`. The write path is the claim of EPIC 050.1, and the switch of EPIC 056.

- **Exclusion is a subtree rule, and one partial index cannot express it.** `run_one_active` at `migration-0007-external-execution.ts:33` is unique on `node_id` where `state = 'active'`. That refuses a second run on the same node and admits one on a descendant. The subtree rule is `subtreeExclusion` in `src/domain/run-exclusion.ts`, a pure function the claim evaluates inside its transaction. The index is the last defence for the same-node case only, and the epic does not claim it defends the subtree case.

- **One active run per objective branch, and a task claim is refused, not queued.** `worker.md` section 7 now states the refusal directly: the daemon holds no queue, and a blocking wait would hold one request open for a run lifetime. The rule is `objectiveBusy` in `src/domain/run-exclusion.ts`. The refusal is `objective-busy`, naming the sibling node id, its run id and that run's `expires_at`, so a client knows what it waits on and until when.

- **An expired run is not live, and one predicate decides that for both rules.** A run whose `expires_at` has passed is counted by neither `subtreeExclusion` nor `objectiveBusy`. The boundary instant is expired, and a module-private `isLive(run, now)` helper governs both functions, so the two can never disagree about it.

- **The three claim seams are declared here, and their implementations ship here.** `plan.setNodeAssignment`, `execution.activeRunsOfNodes` and `execution.expireDueRuns` go on their interfaces with one implementation each. A diagram nobody implements and a story that implements something nobody drew are the same defect, so the seams the diagrams of EPIC 050.1 draw exist before that epic draws them.

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

2. **Migration 12** — `src/services/storage/migration-0012-run-model.ts` at version `12`, registered, with the null-deliverable refusal guard and the `run_base` table. `story-foundation`.

3. **The run row** — `runRow` and `runBaseRow` in `src/domain/run.ts`, with the cardinality refine at its upper bound. `story-foundation`.

4. **`assignment` is published** — `assignment: workerId.nullable()` on `nodeRow`, `StoredNode`, the plan store read path and the `node.show` and `project.graph` projections. `story-foundation`.

5. **Subtree exclusion** — `subtreeExclusion` in `src/domain/run-exclusion.ts`. `story-foundation`.

6. **The objective-branch rule** — `objectiveBusy` in `src/domain/run-exclusion.ts`, returning the sibling node id, its run id and its `expires_at`. `story-foundation`.

7. **Configuration** — `runTtlMs` and `runMaxLifetimeMs` in `src/services/config/`, with the startup refusals. `story-foundation`.

8. **The claim seams** — `plan.setNodeAssignment`, `execution.activeRunsOfNodes`, `execution.expireDueRuns` on their interfaces, and one implementation each. `story-foundation`.

9. **The proposal records the run model** — `docs/proposal/phase-2/runs-and-exclusion.md` is created, stating the three run kinds and their selection rule, the fence counter, the subtree rule, the objective-branch refusal, the base set, the provenance, the two budgets and the final shape migration `12` lands. The claim half of the document is EPIC 050.1 Story 9, and the authority half is EPIC 050.2 Story 9. `story-foundation`.

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
  src/services/storage/migration-0012-run-model.test.ts \
  src/services/storage/schema-parity.test.ts \
  src/services/plan/sqlite.test.ts \
  src/services/execution/sqlite.test.ts \
  src/services/config/convict.test.ts \
  src/services/config/refusals.test.ts \
  src/http/contract/graph.test.ts \
  src/http/contract/parity.test.ts \
  test/helpers/proposal.test.ts \
  && echo "PASS EPIC-050"
```

Hermetic coverage required beyond the Proof:

- `runKindFor` is asserted for all four deliverables by iterating the `deliverables` tuple, so a fifth deliverable fails the test. Story 1.
- Migration `12` aborts against a database holding one node with a null `deliverable`, and the message names the project id and the count. Story 2.
- After migration `12`, `run.base_oid`, `run.lease_fence` and `node.worker` are absent, asserted by reading the table info. The removal is the assertion, not a comment. Story 2.
- After migration `12`, `run` and `attempt` hold zero rows, and `node`, `edge`, `blob`, `plan_revision`, `project` and `repository` hold exactly the rows they held before. Both halves are asserted, so the destruction is bounded. Story 2.
- `run.fence`, `run.agents_json`, `run.expires_at` and `run.max_lifetime_at` each refuse a null insert, asserted one column per case against real SQLite. Story 2.
- The `kind` CHECK refuses `objective` and `task`, and admits the three new values. Both directions are asserted. Story 2.
- A `structural` run holding a `run_base` row is refused by the cardinality refine, a `review` run holding one is refused, and an `execution` run holding two is refused. An `execution` run holding none passes, because EPIC 051 writes the row. Every direction is asserted. Story 3.
- `nodeRow` refuses an `assignment` value outside the worker id grammar, asserted by value. Story 4.
- A second run on a node with an active run is refused by `subtreeExclusion` as a pure function. The index case is EPIC 050.1's. Story 5.
- An expired run in the exclusion input does not refuse. Story 5.
- No refusal object holds a fence value. The assertion scans the refusal details key set. Story 6.
- `objectiveBusy` and `subtreeExclusion` agree on the liveness boundary, asserted over `now - 1`, `now` and `now + 1`, so the shared predicate cannot drift. Story 6.
- `runTtlMs` below 1000, `runMaxLifetimeMs` below `runTtlMs`, and a non-integer are each refused at startup, asserted by value, and `runMaxLifetimeMs` equal to `runTtlMs` starts. Both directions of the boundary. Story 7.
- `setNodeAssignment` writes the assignment and touches no other column, `activeRunsOfNodes` returns no ended run and no run the expiry pass already ended, and `expireDueRuns` returns the raised fence and nothing on a second call. All three seams are covered. Story 8.
- The run model document names the `refusal` value of each exclusion rule, built by calling the two pure functions rather than restating a literal, so the document and the code cannot drift. The claim refusals are EPIC 050.1's and the authority refusals are EPIC 050.2's; this epic's gate asserts neither. Story 9.
