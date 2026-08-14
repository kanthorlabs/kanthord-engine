# EPIC 017 — Per-node graph write — stories

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Prereq: EPIC 016 (sequence order). EPICs 014, 015 and 016 are authored but not yet landed; every fact this epic relies on from them is listed under Facts.

A `human` or a `harness` creates, updates and deletes one node over HTTP without an import; each write mints a `node-write` plan revision whose `accepted_blob` is the whole re-rendered graph, so `plan.export` stays byte-identical to it and every revision is a valid import base.

## Dispatch order

1. `01-proposal-amendment` — first, because `src/http/contract/parity.test.ts` reads the route matrix. It leaves that test red until Story 13.
2. `02-migration-0006-revision-origin` and `03-migration-parity` — **a coupled pair.** Story 2 turns the 0002 parity test red and Story 3 is the only fix. No verify gate between them.
3. `04-plan-store-origin`
4. `05-structural-validity`
5. `06-node-write-legality`
6. `07-services-revision`
7. `08-concurrency-classes`
8. `09-create-node`
9. `10-update-node`
10. `11-delete-node`
11. `12-project-binding-invariant` — independent of every other story; may run any time after Story 4.
12. `13-contract-handlers-actors`
13. `14-readiness-corrected` — assertions only; it adds no production code.
14. `15-cli`

`npm run verify` first exits 0 at Story 13. Stories 1 to 12 are verified by their own named test files.

## Stories

- 1 — The proposal amendment: three routes, two amended sentences, the precondition rows and the widened `binding-in-use` → `01-proposal-amendment.md`
- 2 — Migration 0006 rebuilds `plan_revision` with `origin` and three conditional columns → `02-migration-0006-revision-origin.md`
- 3 — Migration parity splits into a frozen-history question and a live-document question → `03-migration-parity.md`
- 4 — `RevisionRecord` carries `origin`, and `mutateGraph` gains `nodeDeletes` → `04-plan-store-origin.md`
- 5 — `validateCandidateStructural` and `validateCandidateCompleteness`; completeness stops refusing → `05-structural-validity.md`
- 6 — `nodeWriteLegality` extracted once, and `choiceVerdict` calls it → `06-node-write-legality.md`
- 7 — `services/revision`: one shared projection and one revision mint → `07-services-revision.md`
- 8 — The two concurrency classes and the shared `NodeWriteError` → `08-concurrency-classes.md`
- 9 — `createNode` → `09-create-node.md`
- 10 — `updateNode` → `10-update-node.md`
- 11 — `deleteNode`, with `readSubtreeExecutionFacts` and the closed blocker set → `11-delete-node.md`
- 12 — `project.repositories` refuses a drop a stored objective needs → `12-project-binding-invariant.md`
- 13 — The contract rows, the three handlers, the harness set and the acceptance test → `13-contract-handlers-actors.md`
- 14 — Readiness, corrected: no `setNodeState`, no trigger, the full transition inventory → `14-readiness-corrected.md`
- 15 — The CLI: `node create`, `node update`, `node delete` → `15-cli.md`

## Facts (needed for implementation)

### Greenfield today — these land with EPICs 014, 015 and 016, not with this epic

- `src/domain/revision-guard.ts` — EPIC 014 Story 11. `revisionGuardFor(kind: NodeWriteKind): RevisionGuardClass`; `nodeWriteKinds` is `["create", "update-fields", "update-topology", "delete"]`; `revisionGuardClasses` is `["node", "project"]`; `update-fields` returns `node` and the other three return `project`.
- `findingScope` in `src/domain/plan-finding.ts` — EPIC 014 Story 10. Total over the 24 codes of `src/domain/plan-finding.ts:3-28`. Exactly two are `completeness`: `initiative-without-objective` and `objective-without-task`.
- `src/domain/plan-completeness.ts` and `completenessFindings` — EPIC 014 Story 10.
- `origin` in `src/domain/plan-revision.ts`, `revisionOrigins = ["import", "node-write"]`, and the `.refine` whose message is the SQL `CHECK` expression Story 2 repeats — EPIC 014 Story 9.
- `src/services/storage/migration-0005-actor.ts` at version 5 — EPIC 015 Story 3. The highest migration on disk today is `0004-event-indexes`.
- `context.actor` as an `ActorRow` on `HandlerContext`, and commands taking `actor: ActorRow` — EPIC 015 Story 5 and Story 10. Today a handler passes `actor: string`.
- `harnessOperations` in `src/http/contract/registry.test.ts`, nine ids sorted bytewise: `blob.show`, `edge.list`, `node.list`, `node.show`, `plan.export`, `project.list`, `project.show`, `project.status`, `system.health` — EPIC 015 Story 7. This epic raises it to twelve.
- `mutateGraph` and `setNodeState` on `PlanStore`, and the deletion of `upsertNode`, `insertEdge` and `deleteEdge` — EPIC 016 Story 4. Today `src/services/plan/index.ts:75-77` still holds the three old methods.
- `MutateGraphInput` is `{ projectId, nodes, insertEdges, deleteEdgeIds, at, cause }` and declares **no** `trigger`. This epic adds `nodeDeletes`.
- `ReadinessCause` is `{ revision: string; importId: string | null }` — EPIC 016 Story 3.
- `deriveReadiness` returns `{ nodeId, from, to, trigger }` sorted by `nodeId` through `Buffer.compare`, with `readiness-promoted` on a promotion and `readiness-demoted` on a demotion — EPIC 016 Story 2.
- `src/services/readiness/dependency.ts` appends `node.ready` or `node.pending` with `actorKind: "daemon"` for each transition — EPIC 016 Story 9.
- `src/main.readiness.test.ts` — EPIC 016. The only `src/main*.test.ts` on disk today is `src/main.test.ts`.
- `src/domain/layout.test.ts:101` counts capabilities: fourteen today, fifteen after EPIC 015, sixteen after EPIC 016, seventeen after this epic. The directory list is asserted at `:108-124`.

### Load-bearing facts about the code as it stands

- **There is no `commit` table.** Commit OIDs are plain `TEXT` columns. The `commit` blocker of Story 11 is backed by `candidate.node_id` at `src/services/storage/migration-0003-execution-and-journal.ts:79`.
- **`lease` carries no foreign key onto `node`.** It is the polymorphic subject at `migration-0003-execution-and-journal.ts:21-22`, keyed `(subject_kind, subject_id)`.
- **`attempt` carries no `node_id`.** It reaches `node` only through `run_id` at `migration-0003-execution-and-journal.ts:49`.
- Direct foreign keys onto `node(id)` are exactly five: `workspace.node_id` `:9`, `run.node_id` `:33`, `candidate.node_id` `:79`, `check_result.node_id` `:106`, `git_operation.node_id` `:131`. The last two are nullable.
- `node.revision` at `migration-0002-graph-and-plan.ts:30` is `TEXT NOT NULL REFERENCES plan_revision(id)` with no `ON DELETE` clause. That is why every command records the revision before it writes the node.
- **The migration registry is pinned in four places**, so adding migration 0006 turns all four red: `src/services/storage/migrations.ts`, `migration-0002-graph-and-plan.test.ts:232-239`, `migration-0003-execution-and-journal.test.ts:438` and `migration-0004-event-indexes.test.ts:35-49`.
- `src/services/storage/sqlite.ts:78-80` runs each migration statement through `transaction.run`, which is `database.prepare(sql).run(...)`. A multi-statement string fails. `src/services/storage/connection.ts:35` opens `BEGIN IMMEDIATE` first, and `connection.ts:6-11` sets `PRAGMA foreign_keys = ON` at connect.
- `proposalStatements(table)` at `test/helpers/proposal.ts:8-27` reads the **first** ` ```sql ` fence of `docs/proposal/database/<table>.md`, strips `--` comments outside single quotes, splits on `;`, and collapses whitespace. Indentation is free; tokens are not.
- `docs/proposal/database/migration.md` lists versions 1 to 3 only, in a plain-text fence at `:17-22`. It was never updated for 0004.
- `canonicalDocumentsJson` lives in `src/domain/plan-hash.ts:5-12`, **not** in `plan-render.ts`. `CanonicalNode` lives in `src/domain/plan-canonical-path.ts:7-13`.
- `renderDocumentSet` at `src/domain/plan-render.ts:72` sorts by canonical path, so the input node order never reaches its output.
- `choiceVerdict` starts at `src/domain/plan-choice.ts:45`; its structural branch is `:86-112`. The EPIC cites `:86-112`, which is the branch, not the function.
- `containmentMovable` at `src/domain/plan-containment.ts:4` declares a `kind` parameter it never reads. Do not fix that here.
- `structuralFields` at `src/domain/plan-choice.ts:6-12` is `["depends_on", "parent", "repo", "worker"]`; `proseFields` is `["body", "title"]`. Only `parent` and `repo` consult containment.
- `repairSuggestions` at `src/domain/plan-candidate.ts:273` sets `cap = verdicts.size` and throws `repairSuggestions exceeded its iteration cap` at `:307-311`.
- `readSubtreeContainmentFacts` at `src/services/plan/sqlite.ts:253` holds the recursive CTE at `:257-260`; Story 11 reuses the same CTE text.
- `dependencyMap` at `src/services/plan/sqlite.ts:88-105` already dedupes and sorts dependencies by `Buffer.compare`, so a stored node's `dependencies` array is bytewise sorted.
- Error codes `stale-revision`, `illegal-transition` and `binding-in-use` already map to `409` at `src/http/contract/errors.ts:13-15`.
- `src/http/contract/parity.test.ts:16` asserts 54 comparable rows and `:25` asserts 58 total rows. Both rise by three.
- `src/http/server/plan/refusals.ts:5-40` is the refusal-mapper pattern: one exhaustive switch, ending in `throw error`.
- `src/http/server/node/` holds `list-node.ts` and `show-node.ts` today. `src/commands/node/` does not exist.
- `src/cli/inventory.ts` entries are `{ path: readonly string[]; operationIds: readonly string[] }`, sorted by `path`.
- `launchDaemon` at `test/helpers/daemon.ts:29` takes `{ configPath?, home?, cwd?, env? }` and spawns `src/main.ts` with `serve`.
- **`validateCandidate` never checks the parent's kind.** It checks only that an initiative has no parent, that an objective or task has one, and that the parent exists (`src/domain/plan-candidate.ts:95-119`). On the import path `src/domain/plan-path.ts:132-139` carries the rule through the path shape. A per-node write carries typed fields and no path, so Story 5 adds the rule.
- **The migrations array is pinned in four test files**, not three: `migration-0001-core-entities.test.ts:186`, `0002:232`, `0003:438`, `0004:35`.
- **Five fixture files insert `plan_revision` through raw SQL against the current schema** and need the `origin` column: `test/helpers/rows.ts`, `test/helpers/recovery.ts`, `src/commands/startup/recover-expired-leases.test.ts`, `src/queries/project/read-project-status.test.ts`, `src/commands/provider/remove-provider.test.ts`. `migration-0002-graph-and-plan.test.ts:584-657` inserts against the **version-2** schema and must not change.
- **`exportPlan` has 28 call sites**, one in `src/main.ts:320` and the rest in five test files. Story 7 owns every one.
- **`insertRevision` has one production call site**, `src/commands/plan/import-plan.ts:395`, and six in tests. Story 4 owns every one.
- `tsconfig.json` sets `"strict": true` and no `noUnusedLocals`, so an unused object-type property is never diagnosed. A story that says "remove it if unused" decides nothing.
- `PRAGMA legacy_alter_table` is **connection-scoped**, not transaction-scoped. A migration failure rolls the data back and leaves the pragma on.
- `readContainmentFacts` filters leases on `owner IS NOT NULL`; the delete blocker query deliberately does not, because a released lease row survives with `owner = NULL` and `lease.subject_id` has no foreign key.
- Test conventions: real SQLite through `createMigratedStorage` of `test/helpers/database.ts`; a migration test builds version N−1 by handing `SqliteStorage` a truncated migration array, in the pattern of `migration-0002-graph-and-plan.test.ts:50-63`; `assertRefused` at `:72-93` asserts `errcode & 0xff === 19`.

### Scope fences this epic must not cross

- No `node.discard`, no `discard_reason`, no dependent moved to `blocked`.
- No completeness refusal anywhere. EPIC 018 owns the one refusal, at the claim.
- No `state` field on any of the three requests, and no explicit transition. Readiness is the only state write, and it happens inside `mutateGraph`.
- No aggregation, no outcome, no claim, no lease, no `node.list` filter.
- No merge of two concurrent writes. A stale token is a hard `409`.
- No kind change, no identity change, no project move.
- No matrix amendment and no readiness derivation — EPICs 014 and 016 own them.
- No composition-root sweep. EPIC 020 owns it, and the registry-wide authorization total.
