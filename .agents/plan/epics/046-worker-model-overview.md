# EPIC 046 — Worker model overview

Status: **ready**. The epic list and the goals are agreed. Each epic file is finalised just before `/author` runs on it.

Source: `docs/workflow/worker.md` of the `kanthord` superproject. That document is the design. This block is its delivery order.

Block goal: the graph describes what to do, a worker describes how to do it, and an agent is who does it. A plan document names no worker, no agent, no harness and no provider.

Exit criterion: a node declares a `deliverable` and a `verify` block, the daemon routes a claim to one worker from a code-derived registry, a run carries a fence and a kind, and a checkpoint is accepted per kind against pinned evidence.

## What phase 1 already shipped, and what this block rewrites

EPICs 001 to 045 are shipped. Phase 2 (EPICs 100 to 116) is drafted, and only 101, 102 and 103 hold story sets. No phase-2 epic is implemented. This block therefore rewrites a phase-1 domain that a phase-2 epic assumes, and it lands before any phase-2 epic runs.

| Shipped                                                                    | This block                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `node.worker`, a closed `workerKinds` enum, and worker binding precedence. | `node.deliverable` plus a runtime `assignment`. A plan document names no worker.                          |
| `run.kind` in `('objective', 'task')`, derived from the node kind.         | `run.kind` in `('structural', 'execution', 'review')`, derived from the node `deliverable`.               |
| A node lease with a fence, in the `lease` table.                           | A fence on the run. The `lease` table keeps repository leases only.                                       |
| An objective `candidate` row as the only accepted artifact.                | One `checkpoint` table with three kinds.                                                                  |
| `attempt.outcome` alone.                                                   | `attempt.termination` in `('semantic', 'infrastructure', 'ambiguous')`, with a separate ambiguous budget. |
| An external actor with a token, scoped by lease hierarchy.                 | A grant that names one worker, one root subtree, and its operation list.                                  |

## Supersession

These epics restate earlier text. This block does not edit the earlier files. Each epic below names, in its Decisions, the exact sentence it replaces, and EPIC 057 removes the dead field.

| Superseded                                                                                     | By         | What changes                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EPIC 041, and the harness-qualified paragraph of `docs/proposal/phase-2/agents-and-workers.md` | 048        | A worker id is `<name>@<version>`. `claude.swe@1` is not a worker id. The harness is a registry field, not a prefix.                                                                                                                                                                                                                                                             |
| Row 106 of `100-phase-2-overview.md`                                                           | 048        | The agent role contract is data in this block. 106 keeps the `pi-coding-agent` adapter only.                                                                                                                                                                                                                                                                                     |
| Row 110 of `100-phase-2-overview.md`                                                           | 050 to 054 | The run, the fence, the checkpoint and the attempt classification move here. 110 keeps the scheduler loop only.                                                                                                                                                                                                                                                                  |
| Row 111 of `100-phase-2-overview.md`                                                           | 056        | `node.abandon` becomes the worker switch.                                                                                                                                                                                                                                                                                                                                        |
| The in-process dispatcher of EPIC 110                                                          | 054        | A human ruled that a worker runs as a separate process. `worker.md` section 10 states it: the supervisor spawns the worker and owns its process tree, and a later worker runs on another machine. EPIC 110 submits its worker loop to an in-process dispatcher, which contradicts that. 110 is finalised before `/author` runs on it, and the dispatcher is the thing to change. |
| Row 112 of `100-phase-2-overview.md`                                                           | 051        | The objective gate reads a `checkpoint` row, not a `candidate` row.                                                                                                                                                                                                                                                                                                              |

## Order

| #   | Epic                                      | Capability at close                                                                                                      |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 047 | The deliverable and the node pair         | A node declares a deliverable and a `verify` block, and an illegal pair is refused.                                      |
| 048 | The worker registry and routing           | Three eligible sets resolve to one worker, or the daemon answers `unroutable`.                                           |
| 049 | Dual-read plan parsing and the conversion | Both frontmatter shapes parse, and the conversion emits a report and a document set.                                     |
| 050 | The run, the fence and exclusion          | A task claim opens or reuses an objective run, opens a task run, writes the assignment, and a stale fence fails a write. |
| 051 | The execution checkpoint                  | An ingested commit lands on the objective branch by compare and swap.                                                    |
| 052 | The structural checkpoint                 | A staged graph patch lands against a graph revision, and creates a child.                                                |
| 053 | The review checkpoint and state ownership | An attestation binds to a pinned commit, and aggregation owns a parent state.                                            |
| 054 | Attempt classification and the supervisor | A termination is classified by the driver, and an ambiguous budget bounds a loop.                                        |
| 055 | The grant and the external client         | A grant bounds a client to one root, one worker and its operation list.                                                  |
| 056 | The worker switch and human controls      | A human switches a worker in one operation, and closes an objective.                                                     |
| 057 | Non-null enforcement and legacy removal   | The nullable columns become mandatory, and the legacy fields are gone.                                                   |

## Dependencies

Sequence order. Epic N depends on epic N-1, per `AGENTS.md`. Two couplings are stronger than sequence, and an epic states them:

- 050 needs 047 and 048. A claim reads the pair to pick the run kind, and the registry to pick the worker.
- 057 needs the `kanthord-apps` plan tree converted. The conversion is not engine work. 049 ships the mechanism and the report; a human runs the conversion against the apps tree; 057 then enforces the non-null constraints.

## The conversion boundary

`docs/workflow/worker.md` section 12 converts the apps plan tree. The engine ships the mechanism, and the apps repository runs the conversion.

- 049 ships dual-read parsing, the conversion rule, and `plan convert`, which emits a converted document set and a report and writes no graph row.
- A human runs `plan convert` against `kanthord-apps`, confirms each `verify.commands` entry at its intended commit, and imports the result.
- 057 refuses to enforce a non-null `deliverable` while any node of any project holds a null one. The refusal names the project and the node count.

## The `/v1` compatibility policy is amended in place

`023-version-compatibility-policy.md` D1 and `docs/proposal/api/README.md:93` give a closed list of four changes legal inside `/v1`. This block makes four changes outside it: `runId` and `fence` become required request fields, `node.heartbeat` becomes `node.renew`, `worker-unknown` leaves the published finding enum, and `worker` leaves the node projection.

**A human ruled: there is no `/v2`, and the policy is amended in place.** The amendment does not open the list. It adds one bounded exception built on the mechanism EPIC 023 already shipped for exactly this question.

> The list is closed by default. A change outside it is legal only when a human records the ruling in the epic that makes it, and the capability name covering the affected operations is retired and replaced. A client reads `system.health.capabilities`, so it cannot call a changed shape unknowingly. The daemon still serves one wire version, and there is no `/v2`.

EPIC 023's own goal states the reason: a client "asks what the daemon can do instead of comparing two semver strings". `capabilities` is that handshake, and a retired capability name is the strongest signal the contract can send. `capabilityOperations` at `src/http/contract/capability.ts:5` already binds `external-drive` to the four operations this block changes, so the announcement is exact rather than approximate.

| step                                                                                                                      | owner       |
| ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Amend `docs/proposal/api/README.md` with the exception, and record `023-version-compatibility-policy.md` D1 as superseded | 050         |
| Retire the `external-drive` capability and declare `worker-model` in its place                                            | 050         |
| Make the four changes cleanly, with no compatibility shim                                                                 | 050 and 057 |
| Record each change in the compatibility record                                                                            | 050 and 057 |

No epic in this block keeps a permanently-null field or a duplicate operation id. The earlier compatibility default is withdrawn.

## The build sequence

`docs/workflow/worker.md` held this sequence until the design and the plan were separated. It is plan, so it lives here.

1. Add the worker registry and additive nullable schema.
2. Add dual-read plan parsing, and validate the conversion offline.
3. Implement artifact ingestion, staged graph mutation and landing.
4. Implement the supervisor for an internal worker, the grant for an external client, and termination evidence.
5. Deploy every writer.
6. Convert the apps plan tree atomically.
7. Enable claims per node kind and structural mutation.
8. Enforce the non-null constraints and drop the legacy fields.

Dual-read parsing accepts both frontmatter shapes between step 2 and step 8. It keeps the apps tree readable through the conversion.

| step                                                            | epic                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1 — registry and additive schema                                | 047 the deliverable and the node pair; 048 the worker registry and routing                                                    |
| 2 — dual-read parsing and offline validation                    | 049                                                                                                                           |
| 3 — ingestion, staged mutation and landing                      | 051 the execution checkpoint; 052 the structural checkpoint                                                                   |
| 4 — supervisor, grant and termination evidence                  | 054 attempt classification and the supervisor; 055 the grant and the external client                                          |
| 5 — deploy every writer                                         | 050 the run, the fence and exclusion; 053 the review checkpoint and state ownership; 056 the worker switch and human controls |
| 6 — convert the apps plan tree                                  | not engine work. 049 ships the mechanism, and the apps team runs the conversion. `engine/HANDOFF.md` request 1 carries it.    |
| 7 — enable claims per node kind and structural mutation         | 050, 052                                                                                                                      |
| 8 — enforce the non-null constraints and drop the legacy fields | 057                                                                                                                           |

Step 6 leaves the engine. The engine ships `plan convert`, which runs every generated command at its intended commit and writes only a command that ran. The apps team runs it against its own repositories, finishes each node the report marks `manual`, and imports the result. Step 8 refuses to run until that is done, and it names the project and the count when it refuses.

## Authoring batches

`046` is an overview. It carries no `Goal`, no `Stories` and no `Proof:`, so `/author` refuses it and always will. The block to expand is `047` to `057`.

`/author` writes only to `.agents/plan/stories/<epic-slug>/`, one directory per epic. Two authoring agents therefore never collide, even in one working tree. The limit is not the file system. **An epic is safely authorable when every existing file its stories edit is already in the tree.** A file the epic creates needs no anchor, and a symbol a sibling epic creates is pinned by that epic's own text. An epic authored before its predecessor ships gets stories grounded in prose instead of in `file:line`, which is the defect `/author` exists to prevent.

| batch | epics         | may run in parallel | ready when                                                                                  |
| ----- | ------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| A     | 047, 048, 049 | yes, all three      | now. Every file these three edit is shipped code from EPICs 001 to 045.                     |
| B     | 050           | alone               | 047 and 048 are authored. It consumes `nodePairLegality` and `routeWorker`.                 |
| C     | 051           | alone               | 050 is authored. It consumes `assertRunAuthority` and `run_base`.                           |
| D     | 052, 053, 055 | yes, all three      | 051 is authored. Each depends on 051 or 050, and none depends on another in this batch.     |
| E     | 054           | alone               | 052 and 053 are authored. It wires `end-attempt` into every accept path.                    |
| F     | 056           | alone               | 053, 054 and 055 are authored. It consumes `closed_at`, `end-attempt` and the caller kinds. |
| G     | 057           | alone               | every earlier epic is authored. It cites lines in files that 047 to 056 change.             |

Batch A and batch D are the two real parallel wins. Five of the eleven epics expand in two passes.

Author one batch ahead of implementation, and no further. A story set written three waves early describes a tree that does not exist.

## Execution waves

Expansion parallelises by directory. Implementation does not. Seven epics each own one migration, and a migration version is a single sequence that no two epics may share:

`047` is `11`, `050` is `12`, `051` is `13`, `053` is `14`, `054` is `15`, `055` is `16`, `057` is `17`.

Four epics own no migration, and they are the only true parallel candidates: `048`, `049`, `052` and `056`.

| wave | implement together | the constraint                                                                                                                                                                                                    |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 047                | Migration `11`. Every other epic consumes the pair and the `verify` block.                                                                                                                                        |
| 2    | 048 and 049        | No migration in either. Disjoint surfaces: 048 is the registry, the agent contracts and two routes; 049 is the plan document, the renderer and the CLI. Both touch `src/main.ts`, which is the one file to watch. |
| 3    | 050                | Migration `12`. It publishes `assignment` and rewrites the claim.                                                                                                                                                 |
| 4    | 051                | Migration `13`. It creates the `checkpoint` table.                                                                                                                                                                |
| 5    | 052 and 053        | 052 owns no migration and 053 owns `14`. Both touch `src/domain/checkpoint.ts` and an `accept-*` command, so serialise this pair when two agents share one tree.                                                  |
| 6    | 054, then 055      | Migrations `15` then `16`. Strictly ordered.                                                                                                                                                                      |
| 7    | 056                | No migration, and it needs all three of 053, 054 and 055.                                                                                                                                                         |
| 8    | 057                | Migration `17`, and the apps conversion must have run. `engine/HANDOFF.md` request 1 carries that.                                                                                                                |

The apps conversion is the only external gate. It needs nothing after EPIC 049, and `plan convert` writes no database, so run it against the apps tree as soon as 049 lands. The report then names the size of the wave 8 gate seven waves early.

## Two rules every write epic carries

`AGENTS.md` states both. 050, 051, 052, 053, 054 and 056 each write.

- **One transaction per transition.** A state transition and its event append sit in one storage transaction. The transitions added here are claim, report, accept, reject, expire, switch and close.
- **The journal belongs to the epic that writes git.** 051 owns its `merge` journal rows for the compare and swap on the objective branch. A mutation inside a disposable attempt workspace carries no row.

## Deferred out of this block

- **Every internal worker.** A human ruled that `general@1`, `tdd@1`, `poc@1`, `research@1` and `git@1` are all phase-2 work. The registry of EPIC 048 holds two entries, `claude@1` and `opencode@1`, and both are external. EPIC 110 adds `general@1`, and the other four follow it.
- **A routable structural run.** `expansion` is claimable by an internal worker only, because `worker.md` section 10 states an external client submits no graph patch and creates no node. With no internal worker in the registry, an expansion node is `unroutable` in production until phase 2. EPIC 052 ships the structural mechanism and proves it against a registry fixture, so the phase-2 worker is a registry edit rather than a rebuild.
- A holder key on a grant. The daemon and the client run on one trusted machine, per `worker.md` section 10.
- Cross-repository landing. A run records a `base` set qualified by repository, and this block lands one repository per objective.
- The apps plan-tree conversion itself.
