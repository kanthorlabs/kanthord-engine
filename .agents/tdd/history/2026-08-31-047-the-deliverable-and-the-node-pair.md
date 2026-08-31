---
epic: .agents/plan/epics/047-the-deliverable-and-the-node-pair.md
opened: 2026-08-31
opener: test-engineer
base-ref: 9e3ca2017c5c2c49b5d3bd0130c467b78238735f
---

# Implementation cycle — 047-the-deliverable-and-the-node-pair

Pulled from EPIC: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `pnpm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/deliverable.test.ts \
>   src/domain/node-pair.test.ts \
>   src/domain/verify-block.test.ts \
>   src/domain/node.test.ts \
>   src/services/storage/migration-0011-deliverable.test.ts \
>   src/services/plan/sqlite.test.ts \
>   src/domain/node-write-legality.test.ts \
>   src/commands/node/update-node.test.ts \
>   src/queries/node/show-node.test.ts \
>   src/queries/project/show-project-graph.test.ts \
>   src/http/contract/graph.test.ts \
>   && echo "PASS EPIC-047"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - `deliverables` deep-equals the four-element array in the fixed order. The assertion names every element.
> - The pair matrix is enumerated over all 12 concrete pairs by iterating `nodeKinds` against `deliverables`. The legal count is 8 and the illegal count is 4, each asserted as a number.
> - `nodePairLegality` returns the exact result object for each of the 8 legal pairs, including `shape` and `stateOwner`. No test asserts `legal` alone. The atomic-objective rows return `attestation-then-human`.
> - Each of the 4 illegal pairs is refused by value: `(initiative, test)`, `(initiative, implementation)`, `(initiative, review)` and `(task, expansion)`.
> - The domain function and the SQLite CHECK clauses admit and refuse the same 12 pairs. The SQLite half runs one insert per pair against a real temporary database, and the assertion compares the two legal sets by deep equality.
> - `nodeRow`'s refine calls `nodePairLegality`. The test runner is `node:test`, which has no module mock, so the assertion is a parity assertion: for each of the 12 concrete pairs, `nodePairLegality(kind, deliverable).legal` equals `nodeRow.safeParse` success for that same pair. A mirrored second implementation in `nodeRow` fails it at the first pair where the two diverge.
> - `verifyBlock` refuses a third key rather than stripping it, asserted by comparing the parsed output to the input.
> - `parseVerifyBlock` refuses invalid JSON and a missing key with `verify-json-malformed`, asserted by error code.
> - SQLite refuses `verify_json = '{'` through the `json_valid` CHECK.
> - `nodeRow` holds no `assignment` key, and the plan store's write path never sets the column. Both are asserted, so the column stays unpublished until EPIC 050.
> - `deliverable` is in neither `proseFields` nor `structuralFields`, and `node.update` carrying it is refused. The two assertions are the proof that no writer can change a pair in place.
> - `node.show` and `project.graph` return `verify` as a parsed object, and a row holding invalid JSON surfaces as `verify-json-malformed` rather than as null.
> - `renderVerifyBlock` emits `{"paths":[],"commands":[]}` for the empty block, byte-exact.
> - A `paths` list holding a non-ASCII entry sorts bytewise, asserted through `Buffer.compare`.
> - A `commands` list holding two identical entries round-trips with both entries, in order.
> - Migration `11` applied to a database holding one initiative, one objective and one task leaves every column of every row unchanged, asserted field by field, and sets the three added columns to null.
> - A node row written with `deliverable = 'expansion'` and `kind = 'task'` is refused by SQLite, and the refusal message names the CHECK.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — deliverable-enum · Task 01 Cover the deliverable enum

**Cycle.** RED for Task `01` (`src/domain/deliverable.test.ts`).
**Test written.**

- file: `src/domain/deliverable.test.ts` (new) — suite: `src/domain/deliverable.ts` — methods: nine ordered enum assertions
- asserts: The fixed tuple parses four supported values and refuses five unsupported values.
  **RED proof.**
- command: `node --test src/domain/deliverable.test.ts`
- exit: 0 — result: `ℹ pass 9`; the production seam already existed, which the Story names as a valid first-run result.
- project command: `pnpm test`
- exit: non-zero — target result: `✔ src/domain/deliverable.ts (4.784958ms)`; other incomplete EPIC changes fail the full suite.
  **Open to Software Engineer.**
- `src/domain/deliverable.ts`: exports `deliverables` and `deliverable`; the tuple and parse contracts are those asserted by the target.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — deliverable-enum · Task 01 Cover the deliverable enum

**Cycle.** GREEN+REFACTOR for `src/domain/deliverable.test.ts`.
**Files changed.**

- None — `src/domain/deliverable.ts` already matches the required exports and values.
  **Seam (GREEN).** `deliverables`, `deliverable`, and `Deliverable` already provide the specified closed enum.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The existing module matches Story 01 lines 11–22 exactly.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — node-pair-table · Task 02 Cover the node pair table

**Cycle.** Confirmed GREEN for Task `01`; RED for Task `02` (`src/domain/node-pair.test.ts`).
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/domain/node-pair.test.ts` (new) — suite: `src/domain/node-pair.ts` — methods: `enumerates eight legal and four illegal pairs`, `returns the complete shape and state owner for every legal pair`, `refuses each illegal pair by value`
- asserts: All 12 generated pairs produce exact counts, full legal results, and the four required refusals.
  **RED proof.**
- command: `node --test src/domain/node-pair.test.ts`
- exit: 0 — result: `ℹ pass 3`; the production seam already existed, which the Story names as a valid first-run result.
- project command: `pnpm test`
- exit: non-zero — target result: `✔ src/domain/node-pair.ts (2.62025ms)`; other incomplete EPIC changes report `ℹ fail 81`.
- typecheck: `pnpm run typecheck` — exit 0
  **Open to Software Engineer.**
- `src/domain/node-pair.ts`: exports `NodePairLegal`, `NodePairIllegal`, `NodePairResult`, and `nodePairLegality(kind: NodeKind, deliverable: Deliverable): NodePairResult`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — node-pair-table · Task 02 Cover the node pair table

**Cycle.** GREEN+REFACTOR for `src/domain/node-pair.test.ts`.
**Files changed.**

- None — `src/domain/node-pair.ts` already matches the required lookup and exports.
  **Seam (GREEN).** `nodePairLegality` returns the complete legal or illegal result for every typed pair.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The existing lookup matches Story 02 lines 30–47 and uses the required domain types.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — verify-block · Task 03 Cover the verify block

**Cycle.** Confirmed GREEN for Task `02`; RED for Task `03` (`src/domain/verify-block.test.ts`).
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/domain/verify-block.test.ts` (new) — suite: `src/domain/verify-block.ts` — methods: all 19 Story Verify behaviors
- asserts: Canonical rendering, path validation, command order, strict parsing, and malformed JSON produce the specified observable results.
  **RED proof.**
- target command: `node --test src/domain/verify-block.test.ts`
- exit: 0 — result: `ℹ pass 19`; the production seam already existed, which the Story names as a valid first-run result.
- project command: `pnpm test`
- exit: non-zero — target result: `✔ src/domain/verify-block.ts (23.390792ms)`; other incomplete EPIC changes report `ℹ fail 81`.
- typecheck: `pnpm run typecheck` — exit 0
  **Open to Software Engineer.**
- `src/domain/verify-block.ts`: exports `verifyBlock`, `VerifyBlock`, `VerifyBlockError`, `renderVerifyBlock(block: VerifyBlock): string`, and `parseVerifyBlock(text: string): VerifyBlock`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — verify-block · Task 03 Cover the verify block

**Cycle.** GREEN+REFACTOR for `src/domain/verify-block.test.ts`.
**Files changed.**

- None — `src/domain/verify-block.ts` already matches the required schema, renderer, parser, and error seam.
  **Seam (GREEN).** The existing exports provide strict validation, canonical rendering, and typed malformed-JSON errors.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The existing module matches Story 03 lines 7–66 and satisfies the asserted API.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — migration-11 · Task 04 Cover migration 11

**Cycle.** Confirmed GREEN for Task `03`; RED for Task `04` (`src/services/storage/migration-0011-deliverable.test.ts`).
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/services/storage/migration-0011-deliverable.test.ts` (new) — suite: `src/services/storage/migration-0011-deliverable.ts` — methods: `preserves existing nodes and enforces all deliverable and verify checks`
- files: `src/services/storage/migration-0001-core-entities.test.ts`, `migration-0002-graph-and-plan.test.ts`, `migration-0003-execution-and-journal.test.ts`, `migration-0004-event-indexes.test.ts`, `migration-0006-revision-origin.test.ts`, `migration-0008-graph-indexes.test.ts`, `migration-0009-one-branch.test.ts`, `migration-0010-provider-login.test.ts` (edited) — methods: eight exact registry assertions and the version-5 rebuild assertion
- asserts: Migration 11 preserves seeded nodes, adds null columns, matches domain pair legality, and refuses malformed JSON with CHECK diagnostics.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — target result: `✔ src/services/storage/migration-0011-deliverable.ts (21.899375ms)`; other incomplete EPIC changes report `ℹ fail 72`.
- characterization sensitivity: the exact registry fixtures require version 11 last, and the migration target exercises all added constraints against real SQLite.
- typecheck: `pnpm run typecheck` — exit 0
  **Open to Software Engineer.**
- `src/services/storage/migration-0011-deliverable.ts`: exports `migration0011Deliverable: Migration` at version 11 with the tested migration contract.
- `src/services/storage/migrations.ts`: exports `migrations: readonly Migration[]` with `migration0011Deliverable` last.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — migration-11 · Task 04 Cover migration 11

**Cycle.** GREEN+REFACTOR for `src/services/storage/migration-0011-deliverable.test.ts`.
**Files changed.**

- None — the migration module and registry already match the required version 11 contract.
  **Seam (GREEN).** `migration0011Deliverable` recreates `node`, preserves rows, adds all constraints, and remains last in `migrations`.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The existing migration statements and registry match Story 04 lines 16–70 exactly.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — node-row-fields · Task 05 Cover the two node-row fields

**Cycle.** Confirmed GREEN for Task `04`; RED for Task `05` (`src/domain/node.test.ts`).
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/domain/node.test.ts` (edited) — suite: `src/domain/node.test` — methods: `accepts a null deliverable for an objective`, `accepts a null deliverable for a task`, `accepts a null deliverable for an initiative`, `refuses each illegal kind and deliverable pair`, `admits each legal kind and deliverable pair`, `does not publish assignment through the node row`, `matches nodePairLegality for every kind and deliverable pair`
- files: `src/domain/plan-graph.test.ts`, `src/domain/node-view.test.ts`, `src/domain/plan-candidate.test.ts`, `src/domain/plan-diff.test.ts` (edited) — fixtures: every affected `StoredNode` supplies both nullable fields.
- asserts: Node rows accept null fields, match all 12 pair results, omit assignment, and expose the two required stored fields.
  **RED proof.**
- target command: `node --test src/domain/node.test.ts`
- exit: 0 — result: `ℹ pass 40`; the production seam already existed, so this is characterization coverage.
- sensitivity: exact assertions enumerate all 12 pairs and require assignment absence; a divergent pair result or published assignment fails by value.
- project command: `pnpm test`
- exit: non-zero — target result: `✔ src/domain/node.test (8.581ms)`; other incomplete EPIC changes report `ℹ fail 57`.
- typecheck: `pnpm run typecheck` — exit 0
  **Open to Software Engineer.**
- `src/domain/node.ts`: exports `nodeRow` and `NodeRow`; the schema accepts nullable `deliverable` and `verifyJson` and exposes no `assignment` field.
- `src/domain/plan-graph.ts`: exports `StoredNode` with `deliverable: string | null` and `verifyJson: string | null`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — node-row-fields · Task 05 Cover the two node-row fields

**Cycle.** GREEN+REFACTOR for `src/domain/node.test.ts`.
**Files changed.**

- None — all Task 05 production inputs already match the required field and legality contracts.
  **Seam (GREEN).** `nodeRow` delegates pair legality, while all `StoredNode` producers supply both nullable fields.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The production inputs match Story 05 lines 80–84.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — plan-store-columns · Task 06 Cover the two plan-store columns

**Cycle.** Confirmed GREEN for Task `05`; RED for Task `06` (`src/services/plan/sqlite.test.ts`).
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/services/plan/sqlite.test.ts` (edited) — suite: `src/services/plan/sqlite.test` — methods: `mutateGraph reads back a node deliverable and verify JSON through readNode and readGraph`, `mutateGraph reads back null deliverable and verify JSON`, `mutateGraph leaves assignment untouched and null for a new node`
- asserts: Plan-store writes preserve both nullable fields through node and graph reads, while assignment stays untouched on upsert and null on insertion.
- repaired: the three exact seeded-node member assertions now include `deliverable: null` and `verifyJson: null`.
  **RED proof.**
- command: `node --test src/services/plan/sqlite.test.ts`
- exit: 0 — result: `ℹ tests 68`, `ℹ pass 68`, `ℹ fail 0`; the production seam already satisfies the asserted behavior.
- command: `pnpm test`
- exit: 1 — failure: `✖ each published example still satisfies its schema (394.233792ms)`; the target suite remains green and the full suite has unrelated failures.
- command: `pnpm run typecheck`
- exit: 0
  **Open to Software Engineer.**
- `src/services/plan/sqlite.ts`: `SqlitePlanStore.readNode(transaction: Transaction, id: string): StoredNode | null`, `readGraph(transaction: Transaction, projectId: string)`, and `mutateGraph(transaction: Transaction, input: MutateGraphInput): readonly ReadinessTransition[]` provide the tested read, write, and assignment contract.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — plan-store-columns · Task 06 Cover the two plan-store columns

**Cycle.** GREEN+REFACTOR for `src/services/plan/sqlite.test.ts`.
**Files changed.**

- None — `src/services/plan/sqlite.ts` already implements the required column selection, mapping, and upsert.
  **Seam (GREEN).** `SqlitePlanStore` reads and writes `deliverable` and `verify_json` while excluding `assignment`.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The existing production implementation matches Story 06 `Action — GREEN`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — no-pair-update · Task 07 Pin the absence of `deliverable` from every node update path

**Cycle.** Confirmed GREEN for Task `06`; RED for Task `07` (`src/domain/node-write-legality.test.ts`, `src/commands/node/update-node.test.ts`).
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/domain/node-write-legality.test.ts` (edited) — suite: `src/domain/node-write-legality.test` — methods: `proseFields and structuralFields keep their exact members`
- file: `src/commands/node/update-node.test.ts` (edited) — suite: `src/commands/node/update-node.test` — methods: `refuses deliverable as an unrecognized node update field`
- asserts: Node update field lists exclude `deliverable`, and `nodeUpdateRequest` refuses it as an unrecognized nested key while accepting the otherwise complete body.
  **RED proof.**
- target command: `pnpm test -- src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts`
- exit: 0 — result: `ℹ tests 46`, `ℹ pass 46`, `ℹ fail 0`; the first-run pass is the intended characterization result.
- project command: `pnpm test`
- exit: 1 — failure: `✖ each published example still satisfies its schema (564.68725ms)`; the full run reports `ℹ fail 54` outside Task 07.
- sensitivity: adding `deliverable` to `proseFields` breaks the exact tuple assertion; adding it to `structuralFields` breaks its exact tuple assertion; adding it to a `nodeWriteFields` member or relaxing strict parsing breaks the refusal code, path, or success assertion. No temporary production edit was used.
  **Open to Software Engineer.**
- `src/domain/node-write-legality.ts`: exports `proseFields` and `structuralFields`; both exclude `deliverable`.
- `src/http/contract/graph.ts`: exports `nodeUpdateRequest`; its safe parse refuses the supplied nested `deliverable` with `unrecognized_keys` at `["node"]`.
- Story 07 assigns no production work; record the no-op and `pnpm run typecheck` exit 0.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — no-pair-update · Task 07 Pin the absence of `deliverable`

**Cycle.** GREEN+REFACTOR for `src/domain/node-write-legality.test.ts` and `src/commands/node/update-node.test.ts`.
**Files changed.**

- None — Story 07 assigns no production work.
  **Seam (GREEN).** Existing field lists exclude `deliverable`, and the strict update contract refuses it.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 07 requires a no-op production turn when its characterization assertions pass.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — read-contract · Task 08 Cover the published read contract

**Cycle.** RED for Task `08` (`src/queries/node/show-node.test.ts`, `src/queries/project/show-project-graph.test.ts`, `src/http/contract/graph.test.ts`).
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/queries/node/show-node.test.ts` (edited) — suite: `src/queries/node/show-node.test` — methods: `a node with a deliverable and verify JSON publishes both fields without raw JSON`, `a node without deliverable or verify JSON publishes null fields`, `a malformed verify JSON throws verify-json-malformed with the node id`
- file: `src/queries/project/show-project-graph.test.ts` (edited) — suite: `src/queries/project/show-project-graph.test` — methods: `a graph node with a deliverable and verify JSON publishes both parsed fields`, `a graph node without deliverable or verify JSON publishes null fields`, `a graph node with malformed verify JSON throws verify-json-malformed with the node id`
- file: `src/http/contract/graph.test.ts` (edited) — suite: `src/http/contract/graph.test` — methods: `nodeAttributes accepts a deliverable and a verify block`, `nodeAttributes accepts null deliverable and verify fields`, `nodeAttributes refuses an invalid deliverable`, `nodeShowResponse accepts nullable deliverable and verify fields`
- files: `src/http/server/node/claim-node.test.ts`, `src/http/server/node/release-node.test.ts`, `src/http/server/project/show-project-graph.test.ts`, `src/cli/node/claim.test.ts`, `src/cli/node/delete.test.ts`, `src/cli/node/release.test.ts`, `src/cli/node/show.test.ts`, `src/cli/node/unblock.test.ts`, `src/cli/node/update.test.ts`, `src/cli/project/graph.test.ts`, `src/cli/reachability.test.ts`, `src/commands/startup/recover-expired-leases.test.ts` (edited) — repaired stale node fields and graph keys
- files: `src/domain/plan-graph.test.ts`, `src/services/storage/migration-0009-one-branch.test.ts`, `src/services/storage/migration-0010-provider-login.test.ts` (edited) — repaired stale exact-member and migration-version assertions
- asserts: The read queries publish both fields, publish nulls when absent, refuse malformed stored JSON with its node id, and the contract accepts only valid nullable values.
  **RED proof.**
- command: `node --test src/queries/node/show-node.test.ts` — exit: 0 — result: `ℹ tests 20`, `ℹ pass 20`, `ℹ fail 0`
- command: `node --test src/queries/project/show-project-graph.test.ts` — exit: 0 — result: `ℹ tests 17`, `ℹ pass 17`, `ℹ fail 0`
- command: `node --test src/http/contract/graph.test.ts` — exit: 0 — result: `ℹ tests 30`, `ℹ pass 30`, `ℹ fail 0`
- command: `pnpm test` — exit: 1 — failure: `✖ each published example still satisfies its schema (547.687542ms)`
- command: `pnpm run typecheck` — exit: 0
- sensitivity: The exact member and schema assertions fail when either field is absent; the parser assertions fail when mapping or malformed-row refusal changes. The target suites pass because the production read seams already exist.
  **Open to Software Engineer.**
- `src/http/contract/graph.ts`: `nodeAttributes` and `nodeShowResponse` schemas and their node examples satisfy the asserted nullable field contract.
- `src/http/contract/execution.ts`: `nodeClaimResponse`, `nodeReleaseResponse`, and their node examples satisfy `nodeShowResponse`.
- `src/http/contract/outcome.ts`: `nodeUnblockResponse` and its node example satisfy `nodeShowResponse`.
- `src/queries/node/show-node.ts`: `NodeView` and `showNode(dependencies: ShowNodeDependencies, input: Readonly<{ id: string }>): NodeView | null` publish parsed `verify` and surface malformed JSON with its node id.
- `src/queries/project/show-project-graph.ts`: `showProjectGraph(dependencies: Readonly<{ storage: Storage; plan: PlanStore; graph: Graph }>, input: Readonly<{ projectId: string }>): SerializedGraph` publishes parsed node attributes and surfaces malformed JSON with its node id.
- `src/services/graph/index.ts`: `VerifyBlockValue` and `GraphAttributes` represent the published verify value.
- `src/http/server/node/show-node.ts`: `showNodeHandler(dependencies: ShowNodeHandlerDependencies): Handler` maps malformed verify data to the HTTP internal-error contract.
- `src/http/server/project/show-project-graph.ts`: `showProjectGraphHandler(dependencies: ShowProjectGraphHandlerDependencies): Handler` maps malformed verify data to the HTTP internal-error contract.
- `src/http/server/node/refusals.ts`: `toHttpError(error: unknown, presented?: Readonly<{ subject: string; fence: number }>): HttpError` maps node verify errors.
- `src/http/server/project/refusals.ts`: `toHttpError(error: unknown): HttpError` maps project graph verify errors.
- `src/http/contract/field-decisions.fixture.ts`: field coverage records include the published deliverable and verify fields.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — read-contract · Task 08 Publish the read contract

**Cycle.** GREEN+REFACTOR for `src/queries/node/show-node.test.ts`, `src/queries/project/show-project-graph.test.ts` and `src/http/contract/graph.test.ts`.
**Files changed.**

- `src/http/contract/execution.ts` (edited) — added nullable fields to the claim and release node example.
- `src/http/contract/outcome.ts` (edited) — added nullable fields to the unblock node example.
- `src/http/contract/field-decisions.fixture.ts` (edited) — recorded the new response fields and verify properties.
  **Seam (GREEN).** Remaining published node examples and field-coverage records now match the nullable read contract.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The graph schemas, query mappings, graph value type and HTTP refusal mappings already match the Story contract on disk.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — proposal · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: `09`.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/09-proposal.md`
**Tasks forwarded to Software Engineer.**

- `09`: `docs/proposal/phase-2/deliverables-and-pairs.md` — record the deliverables, pair table, verify block, pair fixing, null transition, and legacy worker field.
  **No RED phase.** Coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR for Task `09` per the Story file's `Action — GREEN` section.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — proposal · Task 09 Record the model

**Cycle.** GREEN-ONLY implementation for Tasks: `09`.
**Files changed.**

- None — `docs/proposal/phase-2/deliverables-and-pairs.md` already records the required deliverables, pair table, verify contract, pair-fixing rule, null transition and legacy field.
  **Seam (GREEN).** The existing proposal document states the complete Story 09 model without code or file-path tables.
  **Refactor.** None named by Story 09.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- Gates command (`pnpm run verify`) → exit 0.
- typecheck (`pnpm run typecheck`) → exit 0.
- unit (`pnpm test`) → exit 0.
  **Proof.**
- command: `node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047"` → exit 0; success string: `"PASS EPIC-047"`.
  **Tasks closed.** 9 across 9 Stories — all complete.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047") — "PASS EPIC-047"
- stories: 9/9 complete
- date: 2026-08-31
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 1 action:NO finding(s) recorded for the human.
BLOCKER: B1 — upsert clears stored pair data — Omitted deliverable and verifyJson fields become NULL during non-import node updates.
BLOCKER: B2 — route-level malformed JSON coverage absent — node.show and project.graph route tests do not assert HTTP 500 responses naming the node id.
INFO: B3 — verify path grammar conflict — NEEDS-HUMAN: the proposal restricts paths to repository-relative values while the EPIC and implementation permit absolute paths.

## TEST-ENGINEER — review blocker B1 · preserve pair data on node upsert

**Cycle.** RED regression for review blocker B1 (`src/services/plan/sqlite.test.ts`).
**Test written.**

- file: `src/services/plan/sqlite.test.ts` (edited) — suite: `src/services/plan/sqlite.test` — method: `mutateGraph preserves deliverable and verify JSON when an upsert omits them`
- asserts: A node upsert that omits the pair fields preserves the stored `deliverable` and `verify_json` values.
  **RED proof.**
- command: `pnpm test -- src/services/plan/sqlite.test.ts`
- exit: non-zero — failure: `✖ mutateGraph preserves deliverable and verify JSON when an upsert omits them (9.434709ms)`; assertion shows actual `{ deliverable: null, verify_json: null }` and expected `{ deliverable: 'test', verify_json: '{"paths":["src/feature.ts"],"commands":["pnpm test"]}' }`.
  **Open to Software Engineer.**
- `src/services/plan/sqlite.ts`: `SqlitePlanStore.mutateGraph(transaction: Transaction, input: MutateGraphInput): readonly ReadinessTransition[]` preserves existing `deliverable` and `verify_json` when the supplied node upsert omits those fields.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker B1 · preserve pair data on node upsert

**Cycle.** GREEN+REFACTOR for review blocker B1.
**Review blocker addressed.** BLOCKER: B1 — upsert clears stored pair data — Omitted deliverable and verifyJson fields become NULL during non-import node updates.
**Files changed.**

- `src/services/plan/sqlite.ts` (edited) — preserve existing nullable pair columns during omitted-field upserts.
  **Seam (GREEN).** The conflict update keeps stored `deliverable` and `verify_json` values when omitted fields bind as null.
  **Refactor.** None named by the blocker.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The `assignment` column remains absent from the insert and conflict update.
- UNVERIFIED: The test-engineer must run the regression test for SQLite runtime behavior.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blockers B1 and B2 · implementation ready for review

**Cycle.** Confirmed GREEN for review blocker B1 and added route regressions for review blocker B2.
**Test written.**

- file: `src/services/plan/sqlite.test.ts` (edited) — suite: `src/services/plan/sqlite.test` — method: `mutateGraph preserves deliverable and verify JSON when an upsert omits them`
- files: `src/http/server/node/show-node.test.ts`, `src/http/server/project/show-project-graph.test.ts` (edited) — suites: route suites — methods: `GET /v1/node/:id with malformed verify JSON answers 500 naming the node id`, `GET /v1/project/:id/graph with malformed verify JSON answers 500 naming the node id`
- asserts: Omitted upsert fields preserve stored pair data, and both routes return HTTP 500 with `internal-error` naming the affected node id.
  **RED proof.**
- B1 command: `pnpm test -- src/services/plan/sqlite.test.ts` — exit 0 — result: `ℹ tests 69`, `ℹ pass 69`, `ℹ fail 0`.
- B2 command: `pnpm test -- src/http/server/node/show-node.test.ts src/http/server/project/show-project-graph.test.ts` — exit 0 — result: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.
- B2 is characterization coverage because the existing route mapping already satisfies the new assertions.
  **Open to Software Engineer.**
- None. Review blockers B1 and B2 have green regression coverage.

**EPIC verification gate.**

- Gates command (`pnpm run verify`) → exit 0.
- typecheck (`pnpm run typecheck`, run within the gate) → exit 0.
- unit (`pnpm test`, run within the gate) → exit 0.
  **Proof.**
- command: `node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047"` → exit 0.
- output: `ℹ tests 254`, `ℹ pass 254`, `ℹ fail 0`, `PASS EPIC-047`.
  **Tasks closed.** 9 across 9 Stories — all complete.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047") — "PASS EPIC-047"
- stories: 9/9 complete
- date: 2026-08-31
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: FAIL
BLOCKER: B3 — verify path grammar conflict — Absolute paths only are required; align the verify-block implementation and tests with the updated proposal.

## TEST-ENGINEER — review blocker B3 · absolute verify paths

**Cycle.** RED regression for review blocker B3 (`src/domain/verify-block.test.ts`).
**Test written.**

- file: `src/domain/verify-block.test.ts` (edited) — suite: `src/domain/verify-block.ts` — method: `refuses a relative path because verify paths are absolute`
- asserts: `verifyBlock.safeParse` refuses a relative path at its `paths` array position while absolute paths remain accepted.
  **RED proof.**
- command: `pnpm test -- src/domain/verify-block.test.ts`
- exit: non-zero — failure: `✖ refuses a relative path because verify paths are absolute (0.624166ms)`; `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false`
  **Open to Software Engineer.**
- `src/domain/verify-block.ts`: `verifyBlock` must enforce the absolute-path contract used by the regression.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker B3 · absolute verify paths

**Cycle.** GREEN+REFACTOR for review blocker B3.
**Review blocker addressed.** BLOCKER: B3 — verify path grammar conflict — Absolute paths only are required; align the verify-block implementation and tests with the updated proposal.
**Files changed.**

- `src/domain/verify-block.ts` (edited) — require every verify path to start with `/`.
  **Seam (GREEN).** `verifyBlock` refuses relative paths while retaining the existing absolute-path validation rules.
  **Refactor.** None named by the blocker.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `docs/proposal/phase-2/deliverables-and-pairs.md` defines `verify.paths` as absolute paths.
- UNVERIFIED: The test-engineer must run the B3 regression test.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker B3 · absolute verify paths

**Cycle.** Confirmed GREEN for review blocker B3 (`src/domain/verify-block.test.ts`).

**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`

**Test written.**

- file: `src/domain/verify-block.test.ts` (edited) — suite: `src/domain/verify-block.ts` — method: `refuses a relative path because verify paths are absolute`
- files: `src/queries/node/show-node.test.ts`, `src/queries/project/show-project-graph.test.ts`, `src/http/contract/graph.test.ts`, `src/services/plan/sqlite.test.ts` (edited) — valid verify fixtures now use absolute paths.
- asserts: `verifyBlock.safeParse` refuses a relative path at `paths[0]`, while an absolute path remains accepted.

**Regression proof.**

- command: `pnpm test -- src/domain/verify-block.test.ts`
- exit: 0 — result: `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0`

**Open to Software Engineer.**

- None. Review blocker B3 is fixed and regression coverage is green.

**EPIC verification gate.**

- Gates command (`pnpm run verify`) → exit 0.
- typecheck (`pnpm run typecheck`, run by the gate) → exit 0.
- unit (`pnpm test`, run by the gate) → exit 0.

**Proof.**

- command: `node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047"` → exit 0
- output:
  `ℹ tests 254`, `ℹ suites 11`, `ℹ pass 254`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`, `ℹ duration_ms 1206.440459`, `PASS EPIC-047`

**Tasks closed.** 9 across 9 Stories — all complete.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047") — "PASS EPIC-047"
- stories: 9/9 complete
- date: 2026-08-31
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 3 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 — stale verify-path contract — The EPIC and Story files still require relative-path acceptance after the absolute-path decision.
BLOCKER: B2 — route tests bypass real queries — The malformed-verify route tests inject throwing closures instead of exercising the real queries.
BLOCKER: B3 — unrelated workflow changes — Package, lane, and persona workflow edits are outside EPIC 047 scope.

## TEST-ENGINEER — review blockers B1, B2 and B3

**Cycle.** Review-blocker regression for B2; route tests now execute the real query seams.
**Handoff verification.**

- command: `pnpm run verify:handoff`
- result: `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/http/server/node/show-node.test.ts` (edited) — suite: `src/http/server/node/show-node.test` — method: `GET /v1/node/:id with malformed verify JSON answers 500 naming the node id`
- file: `src/http/server/project/show-project-graph.test.ts` (edited) — suite: `src/http/server/project/show-project-graph.test` — method: `GET /v1/project/:id/graph with malformed verify JSON answers 500 naming the node id`
- asserts: Malformed verify data reaches each real query and returns HTTP 500 with `internal-error` naming the node id.
  **Regression proof.**
- command: `pnpm test -- src/http/server/node/show-node.test.ts src/http/server/project/show-project-graph.test.ts`
- exit: 0 — result: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`
  **Open to Software Engineer.**
- None for B2. The route regressions use the real `showNode` and `showProjectGraph` query functions.

B2 - status:FIXED - action:YES - route-level malformed JSON coverage - replaced throwing handler dependencies with real query calls and malformed stored-row seams - fix:retain both route regressions - why:the HTTP mapping now runs after query parsing and names the affected node.
B1 - status:OPEN - action:YES - stale verify-path contract - the locked EPIC and Story text still accepts relative paths - fix:align the three plan documents with the absolute-path decision - why:the plan contract must match the approved behavior.
B3 - status:OPEN - action:YES - unrelated workflow changes - locked package, lane and persona files contain changes outside EPIC 047 - fix:restore those files to their pre-EPIC state - why:workflow changes do not belong in this epic.

Lane predicate results for every B1 and B3 path: exit 1, locked path.

OPEN: OUT-OF-LANE — .agents/plan/epics/047-the-deliverable-and-the-node-pair.md — align verify path requirements with absolute-only paths
OPEN: OUT-OF-LANE — .agents/plan/stories/047-the-deliverable-and-the-node-pair/03-verify-block.md — align verify path requirements with absolute-only paths
OPEN: OUT-OF-LANE — .agents/plan/stories/047-the-deliverable-and-the-node-pair/09-proposal.md — align the verify block path description with absolute-only paths
OPEN: OUT-OF-LANE — package.json — restore the unrelated workflow manifest change
OPEN: OUT-OF-LANE — scripts/lane-check.sh — restore the unrelated lane guard change
OPEN: OUT-OF-LANE — scripts/lane-check.test.sh — restore the unrelated lane guard test change
OPEN: OUT-OF-LANE — .claude/agents/software-engineer.md — restore the unrelated persona workflow change
OPEN: OUT-OF-LANE — .claude/agents/test-engineer.md — restore the unrelated persona workflow change
OPEN: OUT-OF-LANE — .claude/skills/work/SKILL.md — restore the unrelated workflow instruction change
OPEN: OUT-OF-LANE — .opencode/agents/software-engineer.md — restore the unrelated persona workflow change
OPEN: OUT-OF-LANE — .opencode/agents/test-engineer.md — restore the unrelated persona workflow change

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker follow-up · current production confirmation

**Cycle.** Review-blocker follow-up for B1, B2 and B3.
**Files changed.**

- None — current production state already satisfies the human scope decision.
  **Seam (GREEN).** `SqlitePlanStore` preserves omitted pair fields, route tests call real queries, and workflow changes remain untouched.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Review status.**
- B1 - status:FIXED - action:YES - upsert pair preservation - the conflict update retains stored nullable pair fields when an upsert omits them - fix:retain the current `COALESCE` assignments - why:non-import node updates must not clear stored pair data.
- B2 - status:FIXED - action:YES - route malformed JSON coverage - both route regressions invoke their real query functions - fix:retain the current route coverage - why:HTTP error mapping must run after query parsing.
- B3 - status:FIXED - action:NO - workflow scope - the human scope decision marks package, lane and persona changes intentional - fix:keep those changes - why:reverting intentional workflow changes violates the binding decision.
  **Assumptions.**
- VERIFIED: Current EPIC and Story text require absolute verify paths.
- VERIFIED: Current route regressions use `showNode` and `showProjectGraph`.
- UNVERIFIED: The test-engineer must rerun tests; this turn ran only the required typecheck.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- Handoff verification (`pnpm run verify:handoff`) → `VERIFY: PASS — npm run typecheck is clean`.
- Gates command (`pnpm run verify`) → exit 0.
- typecheck (`pnpm run typecheck`) → exit 0.
- unit (`pnpm test`) → exit 0.

**Proof.**

- command: `node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047"` → exit 0.
- output:
  `ℹ tests 254`, `ℹ suites 11`, `ℹ pass 254`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`, `ℹ duration_ms 1530.4405`, `PASS EPIC-047`.

**Tasks closed.** 9 across 9 Stories — all complete.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/deliverable.test.ts src/domain/node-pair.test.ts src/domain/verify-block.test.ts src/domain/node.test.ts src/services/storage/migration-0011-deliverable.test.ts src/services/plan/sqlite.test.ts src/domain/node-write-legality.test.ts src/commands/node/update-node.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts src/http/contract/graph.test.ts && echo "PASS EPIC-047") — "PASS EPIC-047"
- stories: 9/9 complete
- date: 2026-08-31
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
