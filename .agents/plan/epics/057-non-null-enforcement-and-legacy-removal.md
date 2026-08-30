# EPIC 057 — Non-null enforcement and legacy removal

Status: **draft**. It follows EPIC 056 by sequence order, and it closes the worker-model block.

## Goal

The additive window closes and one model remains:

- `node.deliverable`, `node.verify_json` and the deferred run columns become `NOT NULL`, and the migration refuses while any row holds a null one;
- `node.worker`, `workerKinds` and `worker-unknown` are gone from the domain and from the published contract;
- `planFrontmatter` refuses a `worker` key, so dual read ends;
- the unused `candidate` table and the node rows of the `lease` table are gone, and the mechanisms that replaced them are asserted first.

## Non-goals

- **No apps-tree conversion.** The conversion runs in `kanthord-apps` before this epic, per EPIC 046. This epic refuses to migrate a database that still holds an unconverted node.
- **No new capability.** Every behaviour of this block already ships. This epic removes the second way of expressing it.
- **No actor removal, and no repository-lease removal.** The actor and its token stay. The `lease` table keeps `subject_kind = 'repository'`.
- **No phase-2 epic edit.** EPIC 046 records the supersession, and each phase-2 file is amended when it is finalised for `/author`.

## Decisions

- **The migration refuses rather than defaults, and the preflight covers every column it will make `NOT NULL`.** Migration `17` counts, per project: nodes with a null `deliverable`; nodes with a null `verify_json`; runs with a null `fence`, `agents_json`, `expires_at` or `max_lifetime_at`; and attempts with a null `caller` or `subject`. A non-zero total aborts with one message listing each project id and each count, projects sorted by id. `migration-0009-one-branch.ts:7` already uses the temp-table-and-trigger refusal pattern. A column that reaches the schema rebuild with a null produces an incidental constraint error instead of the promised message, so every column is preflighted.

- **The refusal names a sequence a human can actually run.** The migration runs at startup, so the daemon that would serve `plan import` is the one refusing to start. The message therefore reads: stay on the previous release; run `kanthord plan convert <plan-dir> <out-dir> --template <file> --repo <name>=<path> --at <name>=<ref>`; run `kanthord plan import <out-dir>`; then upgrade. Two bare command names are not a remedy.

- **A refusal changes nothing.** The preflight runs before the first `ALTER`, and the migration version is not advanced. A test compares a full schema dump and a full data dump before and after a refused run.

- **`assignment` stays nullable.** It is runtime state, and an unclaimed node holds none.

- **The candidate representation survives; only the unused table goes.** `worker.md` keeps `candidate` as a live concept: a reported head before the daemon accepts it, pinned at step 2, landed at step 6, discarded on contention. EPIC 051 implements exactly that as the candidate ref `refs/kanthord/candidate/<runId>/<attemptNo>`, which the daemon deletes on acceptance, on rejection and on contention. The shipped `candidate` table never gained a writer and represents none of it. This epic drops the table only after asserting the ref mechanism covers the pin, the discard and the promotion to a checkpoint.

- **The node rows of `lease` go only after the run exclusion is proven over the whole matrix.** "The run owns the fence" is a claim about the fence, not about exclusion. Before the delete, a test proves `subtreeExclusion` and the `run_one_active` index cover: the same node; an active ancestor against a descendant claim; an active descendant against an ancestor claim; two non-overlapping siblings both claimable; the objective-branch rule; and a stale fence refused across a daemon restart.

- **The migration refuses while any run is active or any node lease is live.** Deleting a node lease under a live claim would drop the only record another writer is holding. The preflight of the first decision therefore also counts active runs and unexpired node leases, and the same message covers them.

- **The legacy removal is one atomic story, because every intermediate split leaves an invalid contract.** After a reader-only removal, a legacy `worker` still parses but is no longer validated. After a parser-only removal, the published finding enum still advertises `worker-unknown`. Both are the half-removed state the block must not ship. Stories 3 and 4 below therefore each land a complete, valid observable contract.

- **`worker-unknown` leaves the domain, and `pair-illegal` of EPIC 049 covers the fault that survives.** A document naming a `worker` key raises `frontmatter-invalid` with the issue path `worker`, through the unknown-key rule at `src/domain/plan-document.ts:26`.

- **`worker-unknown` and `worker` are removed from the published contract, under the amended policy.** `docs/proposal/api/README.md:100` forbids removing an enum member and removing a response field. A human ruled there is no `/v2`, and EPIC 050 amended the policy in place: a change outside the list is legal when a human records the ruling in the epic that makes it, and the capability name covering the affected operations is retired and replaced. This epic records the ruling and performs the swap. No permanently-null field and no never-emitted enum member survives.

- **The capability swap for this epic covers the graph read.** `worker` leaves the node projection, which `project-graph` names at `src/http/contract/capability.ts:14` through `project.nodes` and `project.graph`, and the finding enum reaches a client through `plan.validate` and `plan.import`. `project-graph` is retired and `project-graph-2` is declared in its place, naming the same two operations. A capability name is the only signal the contract can send about a removed field, and a client that reads `capabilities` sees the change before it parses a response.

- **`KANTHORD_VERSION` is not bumped again.** EPIC 050 moved it to `28.0.0` for this block, and the policy states the package version describes a build. One build number covers the block, and the capability list is what describes the wire.

- **The absence guard is a scanner with a root parameter, tested hermetically.** `scanForIdentifiers(root, identifiers)` in `src/domain/legacy-absence.ts`. One case runs it against a `mktemp` tree it creates and removes, asserting a hit and a miss. A second case runs it against the real `src/`, asserting no hit. Writing a fixture into the repository's own `src/` races the linter and can leave residue, which the `AGENTS.md` hermetic rule forbids.

- **The scanner is a textual backstop, and the epic says so.** A rename to an equivalent mechanism passes it. The primary enforcement is that the code the identifiers named no longer exists and its tests are gone.

## Stories

1. **The exclusion matrix is proven before anything is deleted.** Add cases to `src/domain/run-exclusion.test.ts` and `src/commands/node/claim-node.test.ts` covering the six situations of the Decisions, including the restart case. No production file changes.

2. **The candidate ref mechanism is proven before the table is dropped.** Add cases to `src/commands/checkpoint/accept-execution.test.ts` asserting the candidate ref is created by the worker, deleted on acceptance, deleted on rejection and deleted on contention, and that an accepted candidate becomes a `checkpoint` row naming the same oid. No production file changes.

3. **The legacy model leaves the domain, atomically.** In one story: delete `src/domain/worker.ts` and its test; delete the `workerKinds` field from `ValidationContext` at `src/domain/plan-graph.ts:51`; delete the membership checks at `src/domain/plan-candidate.ts:153` and `src/domain/plan-validate.ts:286`; delete the context construction at `src/services/plan/sqlite.ts:251`; delete `worker` from `planFrontmatterKeys` at `src/domain/plan-document.ts:7`, from `planFrontmatter` at line 22 and from `ParsedDocument` at line 38; delete the `worker` branch of `renderDocument` at `src/domain/plan-render.ts:55` and the field from `RenderInput` at line 6; delete `worker-unknown` from `findingCodes` at `src/domain/plan-finding.ts:6` and `findingScope` at line 42; delete `worker` from `structuralFields` at `src/domain/node-write-legality.ts:7` and `differingFields` at line 14; and repoint the `workerKind` import at `src/domain/run.ts:6` to `workerId`. Add cases asserting a document carrying `worker` raises exactly one `frontmatter-invalid` on path `worker`, and asserting a new-shape plan still imports and exports byte-identically.

4. **The published contract loses both values.** Remove `worker-unknown` from `src/http/contract/plan-finding.ts` and `worker` from the node projection in `src/http/contract/graph.ts`. Retire `project-graph` from `capabilityOperations` at `src/http/contract/capability.ts:14` and declare `project-graph-2` naming the same two operations. Add this epic's two removals to the compatibility record in `docs/proposal/api/README.md`. Update `src/http/contract/plan-finding.test.ts`, `src/http/contract/capability.test.ts`, `src/http/contract/runtime-matrix.test.ts`, the example literals, and `src/http/contract/graph.test.ts`.

5. **The lease and the candidate go.** Delete `src/domain/lease-hierarchy.ts`, its test and the call at `src/commands/node/claim-node.ts:139`. Delete `src/domain/candidate.ts`, its test and every non-migration reference to the `candidate` table.

6. **Migration 17.** Add `src/services/storage/migration-0017-enforce.ts` at version `17`: the full preflight of the Decisions, including active runs and live node leases; `deliverable` and `verify_json` to `NOT NULL`; the four run columns to `NOT NULL`; `attempt.caller` and `attempt.subject` to `NOT NULL`; `run.kind` narrowed to the three new values; `node.worker`, `run.base_oid` and `run.lease_fence` dropped; the `candidate` table dropped; the `subject_kind = 'node'` lease rows deleted and the CHECK narrowed. Register it at `src/services/storage/migrations.ts:13`.

7. **The migration is proven both ways.** Add `src/services/storage/migration-0017-enforce.test.ts` asserting: the refusal for a null `deliverable`, for a null `verify_json`, for both together, for an active run, for a live node lease, and for two affected projects with the message listing both, projects sorted; that a refused run leaves the schema dump, the data dump and the migration version identical; that the success path drops each named column and table; that each surviving `node`, `run`, `attempt` and `lease` column, index and trigger is present afterwards with its data intact, compared field by field; and that an insert of a `subject_kind = 'node'` lease is refused by the narrowed CHECK.

8. **The absence guard.** Add `src/domain/legacy-absence.ts` with `scanForIdentifiers(root, identifiers)` and `src/domain/legacy-absence.test.ts` with the two cases of the Decisions, over the identifiers `workerKinds`, `worker-unknown`, `candidateRow` and `lease-hierarchy`. Nothing in the tree keeps any of the four after this epic.

9. **The proposal drops the legacy model.** Delete the `node.worker`, worker-kind and worker-binding-precedence text from `docs/proposal/phase-2/agents-and-workers.md` and `docs/proposal/phase-2/instructions-and-profiles.md`. Delete the legacy paragraph from `docs/proposal/phase-1/plan-format.md` and state that one frontmatter shape exists. Amend `docs/proposal/phase-2/deliverables-and-pairs.md` to state that dual read is closed. Add this epic's two removals and its capability swap to the compatibility record in `docs/proposal/api/README.md`.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/plan-document.test.ts \
  src/domain/plan-render.test.ts \
  src/domain/plan-finding.test.ts \
  src/domain/node-write-legality.test.ts \
  src/domain/run-exclusion.test.ts \
  src/domain/legacy-absence.test.ts \
  src/http/contract/plan-finding.test.ts \
  src/http/contract/capability.test.ts \
  src/http/contract/graph.test.ts \
  src/services/storage/migration-0017-enforce.test.ts \
  src/services/plan/sqlite.test.ts \
  src/commands/plan/import-plan.test.ts \
  src/queries/plan/export-plan.test.ts \
  src/commands/checkpoint/accept-execution.test.ts \
  src/commands/node/claim-node.test.ts \
  && echo "PASS EPIC-057"
```

Hermetic coverage required beyond the Proof:

- The exclusion matrix is proven over all six situations before `lease-hierarchy` is deleted, including a stale fence refused across a daemon restart.
- The candidate ref is deleted on acceptance, on rejection and on contention, and an accepted candidate becomes a `checkpoint` row naming the same oid. Four assertions, before the `candidate` table is dropped.
- Migration `17` aborts for a null `deliverable`, for a null `verify_json`, for both, for an active run and for a live node lease. Five cases, each asserting the message names the project and the count.
- With two affected projects the message lists both, sorted by project id.
- A refused run leaves the schema dump, the data dump and the migration version identical, asserted by three comparisons.
- After a successful run, `node.worker`, `run.base_oid`, `run.lease_fence` and the `candidate` table are absent, asserted by reading `sqlite_master` and the table info.
- After a successful run, every surviving column, index and trigger of `node`, `run`, `attempt` and `lease` is present, and every surviving row is unchanged field by field. A destructive rewrite is proven by what it kept, not only by what it dropped.
- An insert of a `subject_kind = 'node'` lease is refused by the narrowed CHECK.
- `deliverable`, `verify_json` and the four run columns each refuse a null insert after the migration.
- A document carrying a `worker` key raises exactly one `frontmatter-invalid`, with the issue path `worker`.
- A new-shape plan imports and exports byte-identically after the removal.
- `worker-unknown` is absent from the published finding enum and from `src/domain/plan-finding.ts`. Both are asserted.
- The node projection holds no `worker` field, asserted by comparing the schema key set by deep equality.
- `declaredCapabilities` omits `project-graph` and includes `project-graph-2`, which is the client-visible announcement of the two removals.
- `structuralFields` and `differingFields` each deep-equal their shortened tuples.
- The scanner reports a hit and a miss against a temporary tree it creates and removes, and reports no hit against the real `src/`. No fixture is written into the repository tree.
