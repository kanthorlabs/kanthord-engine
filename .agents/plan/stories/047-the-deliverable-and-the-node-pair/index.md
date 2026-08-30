# EPIC 047 — The deliverable and the node pair — stories

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Prereq: EPIC 046 (sequence order). EPIC 046 stories not yet authored — warn only.

A node declares a `deliverable` outcome; the `(kind, deliverable)` pair is validated by a pure function and a SQLite CHECK; `verify` is stored as a JSON column and published on `node.show` and `project.graph`.

## Dispatch order

1. Story 01 — no dependencies
2. Story 03 — no dependencies (parallel with 01)
3. Story 09 — no dependencies (parallel with 01 and 03)
4. Story 02 — depends on Story 01
5. Story 04 — depends on Stories 01 and 02
6. Story 05 — depends on Stories 01, 02, and 03
7. Story 06 — depends on Stories 04 and 05
8. Story 07 — depends on Story 05
9. Story 08 — depends on Stories 03, 05, and 06

Stories 01, 03, and 09 may run concurrently. Story 02 waits on 01. Stories 04, 05 wait on their respective deps. Story 07 waits on 05 and may run concurrently with 06. Story 08 waits on 06.

## Stories

- 01 — The deliverable enum → `01-deliverable-enum.md`
- 02 — The node pair table → `02-node-pair-table.md`
- 03 — The verify block → `03-verify-block.md`
- 04 — Migration 11 → `04-migration-11.md`
- 05 — The node row carries the two fields → `05-node-row-fields.md`
- 06 — The plan store reads and writes the two columns → `06-plan-store-columns.md`
- 07 — No writer can change a pair in place → `07-no-pair-update.md`
- 08 — The read contract publishes the two fields → `08-read-contract.md`
- 09 — The proposal records the model → `09-proposal.md`

## Facts (needed for implementation)

- `src/domain/node.ts:9` — `nodeRow` is `z.object({...})` with fields at lines 11–24; seven `.refine()` calls follow at lines 26–49. New fields append after line 24 inside the object; new refines append after line 49.
- `src/domain/plan-graph.ts:3–19` — `StoredNode` is a `Readonly<{...}>` type with 18 fields. `deliverable` and `verifyJson` append after line 17 (`updatedAt`), before `dependencies` at line 18.
- `src/domain/plan-path.ts:106` — `comparePaths(left: string, right: string): number` — Unicode code-point lexicographic comparator. `parseSubmittedPath` at line 30 is NOT reused in `verifyBlock` (it requires `plan/` prefix and `.md` suffix, which is too restrictive for verify paths).
- `src/domain/worker.ts:3` — `workerKinds` tuple is the template for `deliverables`; `deliverable.ts` mirrors its file shape exactly.
- `src/domain/node-write-legality.ts:6` — `proseFields = ["body", "title"] as const`; line 7 — `structuralFields = ["depends_on", "parent", "repo", "worker"] as const`. Neither names `deliverable`.
- `src/services/storage/migrations.ts` — last registered version is 10 (line 23). New import at line 11 position (after the `migration0010ProviderLogin` import at line 11); new array entry appends after line 23.
- `src/services/plan/sqlite.ts:26–27` — `NODE_COLUMNS` string lists 14 columns. `toNode` mapper at lines 81–97 renames snake_case to camelCase. `insertNode` at line 424 uses an `UPSERT`; `state`, `block_reason`, `discard_reason` are NOT in the `ON CONFLICT` update list.
- Actual query files: `src/queries/node/show-node.ts` (not `src/queries/plan/read-node.ts`) and `src/queries/project/show-project-graph.ts` (not `src/queries/plan/read-project-graph.ts`). EPIC naming is wrong; use actual paths. The EPIC's Proof `node` command is therefore non-runnable as written — the stories use the correct paths.
- `src/queries/node/show-node.ts:13–34` — `NodeView` type; `showNode` at line 61 spreads `StoredNode` fields (`...stored`) then adds blob text and computed fields. `deliverable` and `verifyJson` spread automatically once `StoredNode` gains them, but `verify` must replace `verifyJson` in the return.
- `src/queries/project/show-project-graph.ts:33–43` — `nodeAttributes` function maps 7 `StoredNode` fields to `GraphAttributes`. `deliverable` and `verify` append to the return object.
- `src/http/contract/graph.ts:183–191` — `nodeAttributes` strict schema (7 fields); `nodeShowResponse` at lines 155–167 extends `nodeListItem`. Both gain `deliverable` (nullable enum) and `verify` (nullable strict two-key object).
- `src/http/contract/example.test.ts` asserts the exact sorted list of 43 covered operation IDs. Adding fields to existing responses does not change that list.
- Migration test convention: `createStorageAtVersion(N-1)` + `storage.migrate()` + `PRAGMA table_info` + `assert.throws` for CHECK violations. Import helpers from `test/helpers/database.ts`.
