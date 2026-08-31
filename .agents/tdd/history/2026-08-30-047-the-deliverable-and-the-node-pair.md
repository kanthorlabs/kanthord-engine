---
epic: .agents/plan/epics/047-the-deliverable-and-the-node-pair.md
opened: 2026-08-30
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

## TEST-ENGINEER — 01-deliverable-enum · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 01.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/01-deliverable-enum.md`
**Tasks forwarded to Software Engineer.**

- 01: `src/domain/deliverable.ts` — add the fixed four-value deliverable domain enum.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- `src/domain/deliverable.ts`: implement GREEN+REFACTOR per Story 01.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-deliverable-enum · Add the deliverable enum

**Cycle.** GREEN-ONLY implementation for Tasks: 01.
**Files changed.**

- `src/domain/deliverable.ts` (new) — `deliverables`, `deliverable`, and `Deliverable`
  **Seam (GREEN).** The domain module exports the fixed tuple, its Zod enum, and its inferred type.
  **Refactor.** Mirrored `src/domain/worker.ts` with no extra exports.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 01 names the four tuple values and their fixed order.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 02-node-pair-table · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 02.
**Prior Task verification.** Task 01 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/02-node-pair-table.md`
**Tasks forwarded to Software Engineer.**

- 02: `src/domain/node-pair.ts` — add the complete node-kind and deliverable legality contract.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- `src/domain/node-pair.ts`: export `NodePairLegal`, `NodePairIllegal`, `NodePairResult`, and `nodePairLegality(kind: NodeKind, deliverable: Deliverable): NodePairResult`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 02-node-pair-table · Add the node pair legality table

**Cycle.** GREEN-ONLY implementation for Tasks: 02.
**Files changed.**

- `src/domain/node-pair.ts` (new) — `nodePairLegality` and its discriminated result types
  **Seam (GREEN).** `nodePairLegality` returns the exact legal or refusal result for every concrete pair.
  **Refactor.** Encoded all 12 pairs in one compile-time complete lookup.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 02 defines eight legal pairs and four illegal pairs.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 03-verify-block · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 03.
**Prior Task verification.** Task 02 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/03-verify-block.md`
**Tasks forwarded to Software Engineer.**

- 03: `src/domain/verify-block.ts` — add the strict verify-block schema, canonical renderer, and malformed-JSON reader contract.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- `src/domain/verify-block.ts`: export `verifyBlock`, `VerifyBlock`, `VerifyBlockError`, `renderVerifyBlock(block: VerifyBlock): string`, and `parseVerifyBlock(text: string): VerifyBlock`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 03-verify-block · Add the verify-block contract

**Cycle.** GREEN-ONLY implementation for Tasks: 03.
**Files changed.**

- `src/domain/verify-block.ts` (new) — strict schema, canonical renderer, typed error, and JSON reader
  **Seam (GREEN).** The module validates source paths, renders canonical JSON, and rejects malformed stored values.
  **Refactor.** Kept path sorting and duplicate rejection inside `renderVerifyBlock` while preserving command order.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 03 defines the exact invalid path structures and malformed JSON error code.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 04-migration-11 · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 04.
**Prior Task verification.** Task 03 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/04-migration-11.md`
**Tasks forwarded to Software Engineer.**

- 04: `src/services/storage/migration-0011-deliverable.ts`, `src/services/storage/migrations.ts` — add and register migration 11 with the three nullable node columns and required checks.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- `src/services/storage/migration-0011-deliverable.ts`: export `migration0011Deliverable: Migration` at version 11.
- `src/services/storage/migrations.ts`: register `migration0011Deliverable`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 04-migration-11 · Add and register migration 11

**Cycle.** GREEN-ONLY implementation for Tasks: 04.
**Files changed.**

- `src/services/storage/migration-0011-deliverable.ts` (new) — `migration0011Deliverable`
- `src/services/storage/migrations.ts` (edited) — registered migration version 11
  **Seam (GREEN).** Migration 11 rebuilds `node` with three nullable columns and the required pair and JSON checks.
  **Refactor.** Preserved every existing node constraint and recreated `node_project` after the table rebuild.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 04 defines the exact seven-statement migration order and requires `rebuild: true`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 05-node-row-fields · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 05.
**Prior Task verification.** Task 04 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/05-node-row-fields.md`
**Tasks forwarded to Software Engineer.**

- 05: `src/domain/node.ts`, `src/domain/plan-graph.ts` — carry nullable `deliverable` and `verifyJson` fields and refuse illegal non-null pairs.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- `src/domain/node.ts`: `nodeRow` accepts `deliverable` and `verifyJson`, both nullable, and rejects illegal non-null pairs.
- `src/domain/plan-graph.ts`: `StoredNode` exposes `deliverable: string | null` and `verifyJson: string | null`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 05-node-row-fields · Carry deliverable and verify JSON

**Cycle.** GREEN-ONLY implementation for Tasks: 05.
**Files changed.**

- `src/domain/node.ts` (edited) — nullable fields and delegated pair-legality refine
- `src/domain/plan-graph.ts` (edited) — required nullable `StoredNode` fields
  **Seam (GREEN).** `nodeRow` accepts nullable fields and delegates each non-null pair to `nodePairLegality`.
  **Refactor.** Kept pair legality in `node-pair.ts`; neither domain shape exposes `assignment`.
  **Build check.**
- typecheck: exit 1 — existing `StoredNode` producers and test fixtures omit the new required fields
  OPEN: `src/commands/node/create-node.ts` and `src/services/plan/sqlite.ts` must populate `deliverable` and `verifyJson`; neither path is a Task 05 input.
  OPEN: `src/domain/node-view.test.ts`, `src/domain/plan-candidate.test.ts`, `src/domain/plan-diff.test.ts`, and `src/domain/plan-graph.test.ts` require updated fixtures in the test-engineer lane.

ATTEMPT-FAILED: 05 — required `StoredNode` fields expose stale producers and test fixtures outside this Task's inputs

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 05-node-row-fields · build remains red

**Cycle.** Blocked — Task 05 remains red after GREEN-only implementation.
**Handoff verification.** `pnpm run verify:handoff` → `VERIFY: FAIL — npm run typecheck exited 2`.
**Test fixtures repaired.**

- `src/domain/node-view.test.ts` (edited) — existing `StoredNode` fixtures now include both nullable fields.
- `src/domain/plan-candidate.test.ts` (edited) — the shared `StoredNode` fixture now includes both nullable fields.
- `src/domain/plan-diff.test.ts` (edited) — the stored-node fixture now includes both nullable fields.
- `src/domain/plan-graph.test.ts` (edited) — the exact member assertion now includes `deliverable` and `verifyJson`.
  **Verification result.**
- command: `pnpm run typecheck`
- exit: 2 — `src/commands/node/create-node.ts(161,7): error TS2322: Type ... is missing the following properties ...: deliverable, verifyJson`
- failure: `src/services/plan/sqlite.ts(81,80): error TS2739: Type ... is missing the following properties ...: deliverable, verifyJson`
  **Open to Software Engineer.**
- `src/commands/node/create-node.ts`: each produced `StoredNode` exposes `deliverable: string | null` and `verifyJson: string | null`.
- `src/services/plan/sqlite.ts`: each read `StoredNode` exposes `deliverable: string | null` and `verifyJson: string | null`.

ATTEMPT-FAILED: 05 — typecheck remains red because two production StoredNode producers omit deliverable and verifyJson

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 05-node-row-fields · Complete production StoredNode producers

**Cycle.** GREEN-ONLY follow-up for Task 05.
**Files changed.**

- `src/commands/node/create-node.ts` (edited) — initializes both nullable fields
- `src/services/plan/sqlite.ts` (edited) — exposes both nullable fields on current reads
  **Seam (GREEN).** Both production `StoredNode` producers now provide required `deliverable` and `verifyJson` members.
  **Refactor.** Deferred database column round-tripping to Story 06, which owns the plan-store read and write paths.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: EPIC 047 makes both fields nullable, and Story 06 owns their plan-store persistence.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 06-plan-store-columns · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 06.
**Prior Task verification.** Task 05 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/06-plan-store-columns.md`
**Tasks forwarded to Software Engineer.**

- 06: `src/services/plan/sqlite.ts` — round-trip nullable `deliverable` and raw `verifyJson` without reading or writing `assignment`.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- `src/services/plan/sqlite.ts`: plan-store node reads and writes preserve `deliverable: string | null` and `verifyJson: string | null` byte-identically.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 06-plan-store-columns · Round-trip deliverable and verify JSON

**Cycle.** GREEN-ONLY implementation for Tasks: 06.
**Files changed.**

- `src/services/plan/sqlite.ts` (edited) — node column projection, mapper, and upsert parameters
  **Seam (GREEN).** Plan-store reads and writes preserve nullable deliverable values and raw verify JSON strings.
  **Refactor.** Kept `assignment` outside all plan-store projections and writes while preserving existing upsert state behavior.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 06 assigns raw verify JSON parsing to the query layer and excludes `assignment` from this store.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 07-no-pair-update · blocked

**Cycle.** Task 06 GREEN; Task 07 cannot enter a valid lane cycle.
**Prior Task verification.** Task 06 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/07-no-pair-update.md`
**No RED phase.** The Story has no `Action — RED:` block, so the test-engineer cannot add its assertions.
**Lane proof.** `scripts/lane-check.sh software-engineer` rejects both Story targets because test files are outside the software-engineer lane.

OPEN: Task 07 specifies only test-lane changes but has no `Action — RED:` block; GREEN-only forwarding cannot assign any software-engineer-lane work.

ATTEMPT-FAILED: 07 — the Story has no valid owner under its missing RED block and test-only change

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 07-no-pair-update · Test-only Story blocker

**Cycle.** GREEN-ONLY implementation for Tasks: 07.
**Files changed.**

- None — Story 07 assigns no production change.
  **Seam (GREEN).** Existing production schemas already exclude `deliverable` from update fields; the Story requires assertions only.
  **Refactor.** None; production edits would duplicate test-only proof or widen Task scope.
  **Build check.**
- typecheck: exit 0
  OPEN: `src/domain/node-write-legality.test.ts` and `src/commands/node/update-node.test.ts` require the Story 07 assertions in the test-engineer lane.

ATTEMPT-FAILED: 07 — Story 07 contains only test-engineer-lane changes and no production work

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 07-no-pair-update · protocol owner blocked

**Cycle.** Blocked — Task 07 still has no valid protocol owner.
**Handoff verification.** `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
**Story conflict.** The Story declares no production change and only names test-engineer-lane assertions, but it has no `Action — RED:` block.
**Lane proof.** `scripts/lane-check.sh` rejects the Story path for both `software-engineer` and `test-engineer` because the plan tree is locked.

OPEN: OUT-OF-LANE — .agents/plan/stories/047-the-deliverable-and-the-node-pair/07-no-pair-update.md — add an `Action — RED:` block that assigns the named test assertions to the test-engineer

ATTEMPT-FAILED: 07 — the locked test-only Story still lacks the RED block required to assign its work

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 07-no-pair-update · Preserve the closed update schema

**Cycle.** GREEN no-op for Task 07.
**Files changed.**

- None — Story 07 assigns no production work.
  **Seam (GREEN).** Existing field lists and strict request schemas exclude `deliverable` from node updates.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 07 assigns its regression assertions to the RED phase and requires no production edit.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 07-no-pair-update · Pin closed node updates

**Cycle.** Characterization RED for Task `07` (`src/domain/node-write-legality.test.ts`, `src/commands/node/update-node.test.ts`).
**Test written.**

- file: `src/domain/node-write-legality.test.ts` (edited) — suite: `src/domain/node-write-legality.test` — method: `proseFields and structuralFields keep their exact members`
- file: `src/commands/node/update-node.test.ts` (edited) — suite: `src/commands/node/update-node.test` — method: `refuses deliverable as an unrecognized node update field`
- asserts: Neither update field tuple includes `deliverable`, and the strict request schema refuses it only as an unrecognized node key.
  **Characterization proof.**
- command: `pnpm test`
- intended target result: `✔ refuses deliverable as an unrecognized node update field (10.852833ms)` and `✔ proseFields and structuralFields keep their exact members (0.095333ms)`
- suite exit: non-zero — unrelated existing coverage remains stale after earlier Tasks: `ℹ fail 42`
- sensitivity: Adding `deliverable` to `proseFields` breaks assertion 1; adding it to `structuralFields` breaks assertion 2.
- sensitivity: Adding `deliverable` to a `nodeWriteFields` member, or relaxing its strict schema, breaks assertion 3.
- typecheck: `pnpm run typecheck` → exit 0.
  **Open to Software Engineer.**
- `src/domain/node-write-legality.ts`: `proseFields` and `structuralFields` remain closed tuples without `deliverable`.
- `src/http/contract/graph.ts`: `nodeUpdateRequest.safeParse(input)` refuses `deliverable` inside `node` with `unrecognized_keys` at `["node"]`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 07-no-pair-update · Preserve closed node updates

**Cycle.** GREEN+REFACTOR for `src/domain/node-write-legality.test.ts` and `src/commands/node/update-node.test.ts`.
**Files changed.**

- None — Story 07 assigns no production work.
  **Seam (GREEN).** Existing closed tuples and strict request schemas already exclude `deliverable` from node updates.
  **Refactor.** None.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The latest TEST-ENGINEER turn reports both characterization targets pass.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 08-read-contract · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 08.
**Prior Task verification.** Task 07 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
**Task 07 targets.** `pnpm test` confirmed `✔ refuses deliverable as an unrecognized node update field (4.437291ms)` and `✔ proseFields and structuralFields keep their exact members (0.122042ms)`; the full suite retains 42 unrelated stale assertions.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/08-read-contract.md`
**Tasks forwarded to Software Engineer.**

- 08: `src/http/contract/graph.ts`, `src/http/contract/example-literal.ts`, `src/queries/node/show-node.ts`, `src/queries/project/show-project-graph.ts`, `src/services/graph/index.ts`, and affected `src/http/server/**` handlers — publish nullable `deliverable` and parsed `verify`, while malformed verify JSON names its node in a server error.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR for Task 08 per the Story file across the listed production seams.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 08-read-contract · Publish deliverable and verify

**Cycle.** GREEN+REFACTOR for Task 08 GREEN-only production seams.
**Files changed.**

- `src/http/contract/graph.ts` (edited) — nullable contract fields and examples
- `src/queries/node/show-node.ts` (edited) — parsed verify mapping without raw JSON
- `src/queries/project/show-project-graph.ts` (edited) — parsed graph attributes
- `src/services/graph/index.ts` (edited) — targeted `VerifyBlockValue` attribute type
- `src/http/server/node/show-node.ts` (edited) — query error translation
- `src/http/server/node/refusals.ts` (edited) — malformed verify JSON 500 mapping
- `src/http/server/project/refusals.ts` (edited) — malformed verify JSON 500 mapping
  **Seam (GREEN).** Both reads publish nullable deliverables and parsed verify blocks while malformed rows retain their node IDs.
  **Refactor.** Removed raw `verifyJson` from `NodeView` and widened graph attributes only for verify blocks.
  **Build check.**
- typecheck: exit 2 — `test/helpers/graph.ts(18,5)` retains the old primitive-only attribute record
  OPEN: `test/helpers/graph.ts` must include `VerifyBlockValue` in `sortAttributes` storage; the file is in the test-engineer lane.
  **Assumptions.**
- VERIFIED: `src/http/contract/example-literal.ts` contains constants only, so no node example exists there to update.

ATTEMPT-FAILED: 08 — the test graph helper does not accept the Story-required nested verify attribute

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 09-proposal · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 09.
**Test written.**

- file: `test/helpers/graph.ts` (edited) — updated the graph fake to retain `VerifyBlockValue` attributes from Task 08.
  **Prior Task verification.** Task 08 handoff after the test-helper repair: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
  **Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/09-proposal.md`
  **Tasks forwarded to Software Engineer.**
- 09: `docs/proposal/phase-2/deliverables-and-pairs.md` — record the deliverable model, complete pair table, verify contract, pair-fixing rule, null transition, and legacy worker status.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned by the Story verification gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR for Task 09 per the Story file in `docs/proposal/phase-2/deliverables-and-pairs.md`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 09-proposal · Resolve the pair-count contradiction

**Cycle.** GREEN-ONLY implementation for Tasks: 09.
**Files changed.**

- None — the Story contradicts the EPIC and its own required table counts.
  **Seam (GREEN).** Deferred because 12 concrete pairs with 8 legal pairs permit exactly 4 illegal pairs, not 5.
  **Refactor.** Deferred until the locked Story states a consistent pair count.
  **Build check.**
- typecheck: exit 0
  OPEN: OUT-OF-LANE — .agents/plan/stories/047-the-deliverable-and-the-node-pair/09-proposal.md — change “five illegal pairs” to “four illegal pairs”

ATTEMPT-FAILED: 09 — the Story requires five illegal pairs while the binding EPIC defines eight legal and four illegal pairs

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 09-proposal · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: 09.
**Prior Task verification.** Task 09 handoff: `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; build-only `pnpm run typecheck` → exit 0.
**Story file.** `.agents/plan/stories/047-the-deliverable-and-the-node-pair/09-proposal.md`
**Tasks forwarded to Software Engineer.**

- 09: `docs/proposal/phase-2/deliverables-and-pairs.md` — record the model with the corrected four-illegal-pair requirement.
  **No RED phase.** No `Action — RED:` block exists; coverage is owned by the Story verification gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR for Task 09 per the corrected Story file in `docs/proposal/phase-2/deliverables-and-pairs.md`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 09-proposal · Record the deliverable model

**Cycle.** GREEN-ONLY implementation for Tasks: 09.
**Files changed.**

- `docs/proposal/phase-2/deliverables-and-pairs.md` (new) — deliverables, pair matrix, verify contract, pair fixing, and transition rules
  **Seam (GREEN).** The proposal records all 12 pairs, the corrected counts, and each required model constraint in order.
  **Refactor.** Kept the document to decisions and constraints without implementation history or file-path tables.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The corrected Story defines eight legal pairs and four illegal pairs.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — EPIC verification gate failed

**Cycle.** Task 09 is GREEN; EPIC 047 verification remains red.
**Handoff verification.** `pnpm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
**Task 09 build-only check.** `pnpm run typecheck` → exit 0.
**EPIC verification gate.** `pnpm run verify` → exit 1.

- summary: `ℹ tests 5766`, `ℹ pass 5685`, `ℹ fail 81`.
- first failure: `✖ each published example still satisfies its schema (671.301375ms)`.
  **Proof.** The exact EPIC Proof command → exit 1; `PASS EPIC-047` was not emitted.
- summary: `ℹ tests 201`, `ℹ pass 179`, `ℹ fail 22`.
- failing suites: `src/domain/node.test` (15), `src/queries/node/show-node.test` (3), `src/queries/project/show-project-graph.test` (1), and `src/services/plan/sqlite.test` (3).
- first failure: `✖ accepts a valid objective (1.748584ms)` — `false !== true`.
  **Diagnosis.** The required `deliverable.test.ts`, `node-pair.test.ts`, `verify-block.test.ts`, and `migration-0011-deliverable.test.ts` targets do not exist. Existing exact-shape fixtures also omit the new fields and migration 11.
  **Test-engineer repair.** None. Story 09 requires documentation only, and the earlier affected Stories have no `Action — RED:` blocks.

OPEN: OUT-OF-LANE — .agents/plan/stories/047-the-deliverable-and-the-node-pair/01-deliverable-enum.md — add `Action — RED:` ownership for the required test coverage, with equivalent RED ownership in Stories 02–06 and 08

ATTEMPT-FAILED: 09 — EPIC verification remains red with 81 gate failures and 22 Proof failures

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — EPIC verification · Missing RED ownership

**Cycle.** GREEN-only follow-up for Task 09.
**Files changed.**

- None — the remaining failures require test coverage and fixture changes in the test-engineer lane.
  **Seam (GREEN).** Production typechecks cleanly; no production seam is assigned by the latest TEST-ENGINEER turn.
  **Refactor.** Deferred until the locked Stories assign the required RED coverage.
  **Build check.**
- typecheck: exit 0
  OPEN: OUT-OF-LANE — .agents/plan/stories/047-the-deliverable-and-the-node-pair/01-deliverable-enum.md — add `Action — RED:` ownership for the required test coverage, with equivalent RED ownership in Stories 02–06 and 08

ATTEMPT-FAILED: 09 — EPIC verification failures require unassigned test-engineer work under locked Story files

END: SOFTWARE-ENGINEER

HUMAN_REVIEW: FAIL
BLOCKER: Stories 01-06 and 08 now carry a `### Task` heading with an `Action — RED:` block. Restart the loop at Task 01 and run every Task in dispatch order. Each RED block names its Proof target and the stale fixtures that Task owns.
BLOCKER: Task 04 RED owns the eight migration-count fixtures and the exact `node` DDL snapshot in `src/services/storage/migration-0006-revision-origin.test.ts:199`.
BLOCKER: Task 05 RED owns the `nodeRow` and `StoredNode` fixtures in `src/domain/node.test.ts`, `plan-graph.test.ts`, `node-view.test.ts`, `plan-candidate.test.ts` and `plan-diff.test.ts`.
BLOCKER: Task 06 RED owns the three exact-member assertions in `src/services/plan/sqlite.test.ts`.
BLOCKER: Task 08 RED owns the query, handler and CLI node fixtures. Task 08 GREEN owns the node example literals in `src/http/contract/**` and `src/http/contract/field-decisions.fixture.ts`, which is not a test file and is therefore the software-engineer lane.
BLOCKER: An `Action — RED:` block that passes on its first run is the intended result when the production seam already exists. Do not raise `ATTEMPT-FAILED:` for it.
