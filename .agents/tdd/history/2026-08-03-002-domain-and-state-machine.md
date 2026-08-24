---
epic: .agents/plan/epics/002-domain-and-state-machine.md
opened: 2026-08-03
opener: test-engineer
base-ref: e25e4e6
---

# Implementation cycle — 002-domain-and-state-machine

Pulled from EPIC: `.agents/plan/epics/002-domain-and-state-machine.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - The transition test enumerates the full cross product of states at all three levels and asserts the matrix cell, so a missing pair fails rather than passes silently.
> - Aggregation is asserted on every combination of child outcomes at both parent levels.
> - Task order is asserted stable across repeated runs on a graph with two unordered tasks.
> - A lint rule proves `domain/` imports neither `ulid` nor a clock, so minting cannot drift back into the pure layer.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — identity · RED for Task 02

Ulrich, the RED test for Story 02 (Identity) is ready.

**Cycle.** RED for Task `02` (`src/domain/identity.test.ts`).
**Test written.**

- file: `src/domain/identity.test.ts` (new) — suite: `"src/domain/identity.test"` — 35 test methods covering all exports: `identityKinds` length, `identityPrefixes` key count, unique prefixes, 5 renamed prefixes exact strings, 17 parseIdentity round-trips, 13 null-return cases, first-underscore split, assertIdentity match/mismatch/unparseable, identity schema accept/reject, memoisation, nodeIdentity 3 kinds + reject, anyIdentity all 17 kinds + reject
- asserts: all 17 identity kinds and prefixes round-trip through `parseIdentity`, invalid inputs return null, `assertIdentity` throws `IdentityError` with correct code/message on mismatch, `identity(kind)` is a memoised zod schema, `nodeIdentity` accepts only node kinds, `anyIdentity` accepts any valid prefixed ULID
  **RED proof.**
- command: `node --test src/domain/identity.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/identity.ts'`
  **Open to Software Engineer.**
- Import seam: `src/domain/identity.ts` (new module)
- Exports to create: `identityKinds`, `IdentityKind`, `identityPrefixes`, `ulidPattern`, `Identity`, `IdentityErrorCode`, `IdentityError`, `parseIdentity`, `assertIdentity`, `identity`, `anyIdentity`, `nodeIdentity`
- Story file: `.agents/plan/stories/002-domain-and-state-machine/02-identity.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — identity · GREEN for Task 02

**Cycle.** GREEN for `src/domain/identity.test.ts`.
**Files changed.**

- `src/domain/identity.ts` (new) — `identityKinds`, `IdentityKind`, `identityPrefixes`, `ulidPattern`, `Identity`, `IdentityErrorCode`, `IdentityError`, `parseIdentity`, `assertIdentity`, `identity`, `anyIdentity`, `nodeIdentity`
  **Seam (GREEN).** All 12 exports match the test import seam. `parseIdentity` splits on first `_`, validates prefix via reverse lookup map, validates ULID suffix against `ulidPattern`. `assertIdentity` delegates to `parseIdentity` and throws `IdentityError` on null or kind mismatch. `identity(kind)` returns a memoised `z.string().refine(...)` schema. `anyIdentity` and `nodeIdentity` are `z.string().refine(...)` schemas with appropriate predicates.
  **Refactor.** N/A — Task 02 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Zod 4.4.3 `z.string().refine()` returns `ZodString` (instance of `ZodType`), confirmed by runtime check — satisfies the `z.ZodType<string>` type annotation.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — worker-and-agent-registries · RED for Task 04

**Cycle.** RED for Task `04` (`src/domain/worker.test.ts`, `src/domain/agent.test.ts`).
**Test written.**

- file: `src/domain/worker.test.ts` (new) — suite: `"src/domain/worker.test"` — methods: `workerKinds deep-equals the expected array`, `workerKind.options deep-equals the expected array`, 3 safeParse accepts (`general@1`, `tdd@1`, `git@1`), 6 safeParse rejects (`general`, `general@2`, `re@1`, `mr@1`, `""`, `GENERAL@1`)
- file: `src/domain/agent.test.ts` (new) — suite: `"src/domain/agent.test"` — methods: `agentKinds deep-equals the expected array`, `agentKind.options deep-equals the expected array`, 4 safeParse accepts (`general@1`, `swe@1`, `te@1`, `re@1`), 5 safeParse rejects (`tdd@1`, `git@1`, `re`, `re@2`, `""`), `agent_invocation DDL CHECK clause matches the enum` (reads `docs/proposal/database/agent_invocation.md` and asserts literal CHECK string)
- asserts: `workerKinds` and `agentKinds` are exact ordered arrays, both zod enums accept their members and reject non-members, agent DDL CHECK matches the enum
  **RED proof.**
- command: `node --test src/domain/worker.test.ts src/domain/agent.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/agent.ts'` (and `worker.ts`)
  **Open to Software Engineer.**
- Import seams: `src/domain/worker.ts` (new) and `src/domain/agent.ts` (new)
- Exports for `worker.ts`: `workerKinds` (const tuple), `workerKind` (zod enum), `WorkerKind` (type)
- Exports for `agent.ts`: `agentKinds` (const tuple), `agentKind` (zod enum), `AgentKind` (type)
- Story file: `.agents/plan/stories/002-domain-and-state-machine/04-worker-and-agent-registries.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — worker-and-agent-registries · GREEN for Task 04

**Cycle.** GREEN for `src/domain/worker.test.ts` and `src/domain/agent.test.ts`.
**Files changed.**

- `src/domain/worker.ts` (new) — `workerKinds`, `workerKind`, `WorkerKind`
- `src/domain/agent.ts` (new) — `agentKinds`, `agentKind`, `AgentKind`
  **Seam (GREEN).** Both modules export the exact symbols the tests import. `workerKinds` and `agentKinds` are `as const` tuples in the exact order the story specifies. `z.enum()` creates the zod enum from each tuple, making `safeParse` accept members and reject non-members. The `agent_invocation` DDL CHECK test reads the real file and asserts the literal string.
  **Refactor.** N/A — Task 04 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — schema-inventory · RED for Task 03

**Cycle.** RED for Task `03` (21 test files covering the schema inventory).
**Test written.**

- files (new): `src/domain/column.test.ts` (13 methods), `src/domain/state.test.ts` (7 methods), `src/domain/blob.test.ts` (7 methods), `src/domain/repository.test.ts` (8 methods), `src/domain/project.test.ts` (5 methods), `src/domain/project-binding.test.ts` (5 methods), `src/domain/provider.test.ts` (11 methods), `src/domain/node.test.ts` (22 methods), `src/domain/edge.test.ts` (5 methods), `src/domain/plan-revision.test.ts` (5 methods), `src/domain/workspace.test.ts` (5 methods), `src/domain/lease.test.ts` (5 methods), `src/domain/run.test.ts` (12 methods), `src/domain/attempt.test.ts` (8 methods), `src/domain/agent-invocation.test.ts` (8 methods), `src/domain/candidate.test.ts` (14 methods), `src/domain/check-result.test.ts` (11 methods), `src/domain/git-operation.test.ts` (9 methods), `src/domain/event.test.ts` (5 methods), `src/domain/migration.test.ts` (4 methods), `src/domain/rows.test.ts` (4 methods)
- asserts: all value schemas (column, state, blob) accept/reject valid/invalid inputs per DDL; all 18 row schemas parse a valid literal row, reject missing required keys, reject wrong identity kinds, accept/reject enum values, and enforce all refinements; the rows inventory has exactly 18 entries sorted lexicographically, and every key appears in `domain.md`
  **RED proof.**
- command: `node --test src/domain/column.test.ts src/domain/state.test.ts src/domain/blob.test.ts src/domain/repository.test.ts src/domain/project.test.ts src/domain/project-binding.test.ts src/domain/provider.test.ts src/domain/node.test.ts src/domain/edge.test.ts src/domain/plan-revision.test.ts src/domain/workspace.test.ts src/domain/lease.test.ts src/domain/run.test.ts src/domain/attempt.test.ts src/domain/agent-invocation.test.ts src/domain/candidate.test.ts src/domain/check-result.test.ts src/domain/git-operation.test.ts src/domain/event.test.ts src/domain/migration.test.ts src/domain/rows.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/blob.ts'` (and all other missing modules)
  **Open to Software Engineer.**
- Import seams (21 new modules): `src/domain/column.ts`, `src/domain/state.ts`, `src/domain/blob.ts`, `src/domain/repository.ts`, `src/domain/project.ts`, `src/domain/project-binding.ts`, `src/domain/provider.ts`, `src/domain/node.ts`, `src/domain/edge.ts`, `src/domain/plan-revision.ts`, `src/domain/workspace.ts`, `src/domain/lease.ts`, `src/domain/run.ts`, `src/domain/attempt.ts`, `src/domain/agent-invocation.ts`, `src/domain/candidate.ts`, `src/domain/check-result.ts`, `src/domain/git-operation.ts`, `src/domain/event.ts`, `src/domain/migration.ts`, `src/domain/rows.ts`
- Story file: `.agents/plan/stories/002-domain-and-state-machine/03-schema-inventory.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — schema-inventory · GREEN for Task 03

**Cycle.** GREEN for 21 test files covering the schema inventory.
**Files changed.**

- `src/domain/column.ts` (new) — `epochMillis`, `bytes`, `jsonText`, `objectId`
- `src/domain/state.ts` (new) — `nodeKinds`, `nodeKind`, `NodeKind`, `nodeStates`, `nodeState`, `NodeState`, `terminalStates`, `TerminalState`, `blockReasons`, `blockReason`, `BlockReason`
- `src/domain/blob.ts` (new) — `blobHash`, `blobRow`, `BlobRow`
- `src/domain/repository.ts` (new) — `repositoryRow`, `RepositoryRow`
- `src/domain/project.ts` (new) — `projectRow`, `ProjectRow`
- `src/domain/project-binding.ts` (new) — `projectBindingRow`, `ProjectBindingRow`
- `src/domain/provider.ts` (new) — `providerRow`, `ProviderRow`
- `src/domain/node.ts` (new) — `nodeRow`, `NodeRow`
- `src/domain/edge.ts` (new) — `edgeRow`, `EdgeRow`
- `src/domain/plan-revision.ts` (new) — `planRevisionRow`, `PlanRevisionRow`
- `src/domain/workspace.ts` (new) — `workspaceRow`, `WorkspaceRow`
- `src/domain/lease.ts` (new) — `leaseRow`, `LeaseRow`
- `src/domain/run.ts` (new) — `runRow`, `RunRow`
- `src/domain/attempt.ts` (new) — `attemptRow`, `AttemptRow`, `attemptOutcomes`, `attemptOutcome`, `AttemptOutcome`
- `src/domain/agent-invocation.ts` (new) — `agentInvocationRow`, `AgentInvocationRow`
- `src/domain/candidate.ts` (new) — `candidateRow`, `CandidateRow`
- `src/domain/check-result.ts` (new) — `checkResultRow`, `CheckResultRow`
- `src/domain/git-operation.ts` (new) — `gitOperationRow`, `GitOperationRow`
- `src/domain/event.ts` (new) — `eventRow`, `EventRow`
- `src/domain/migration.ts` (new) — `migrationRow`, `MigrationRow`
- `src/domain/rows.ts` (new) — `rows`, `TableName`

**Seam (GREEN).** All 21 modules export the exact symbols each test imports. Value schemas (`column`, `state`, `blob`) use zod primitives matching DDL semantics. All 18 row schemas mirror their DDL columns with snake→camel mapping, identity kinds via `identity()`, enum members and order from CHECK clauses, nullable columns via `.nullable()`, and object-level `.refine()` predicates for multi-column CHECKs (repository, node×7, edge, run, candidate, check-result). `rows.ts` aggregates all 18 row schemas in lexicographic order.

**Refactor.** N/A — Task 03 has no `Action — REFACTOR:`.

**Build check.**

- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — profile-row · RED for Task 05

**Cycle.** RED for Task `05` (`src/domain/profile.test.ts`, `src/domain/rows.test.ts`).
**Test written.**

- file: `src/domain/profile.test.ts` (new) — suite: `"src/domain/profile.test"` — methods: `accepts a valid profile row`, `Object.keys(profileRow.shape) deep-equals the four keys in order`, `rejects missing required keys`, `rejects repo_ prefix for id`, `rejects profile_ prefix for repositoryId`, `rejects contentBlob without sha256: prefix`, `extra checks key is stripped by zod passthrough`
- file: `src/domain/rows.test.ts` (edited) — raised count to 19, added `"profile"` to sorted key array
- asserts: `profileRow` accepts valid 4-key row, rejects wrong identity kinds, rejects non-blob-hash contentBlob, strips extra `checks` key; `rows` inventory grows to 19 entries with `profile` in sort position
  **RED proof.**
- command: `node --test src/domain/profile.test.ts src/domain/rows.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/profile.ts'` and `18 !== 19`
  **Open to Software Engineer.**
- Import seam: `src/domain/profile.ts` (new module) — exports `profileRow` and `ProfileRow`
- Story file: `.agents/plan/stories/002-domain-and-state-machine/05-profile-row.md` — full specification in the `## Change` section
- Also edit: `src/domain/rows.ts` to insert `profile: profileRow,` between `plan_revision` and `project`

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — profile-row · GREEN for Task 05

**Cycle.** GREEN for `src/domain/profile.test.ts` and `src/domain/rows.test.ts`.
**Files changed.**

- `src/domain/profile.ts` (new) — `profileRow`, `ProfileRow`
- `src/domain/rows.ts` (edited) — added `profile` import and entry
  **Seam (GREEN).** `profileRow` is a `z.object` with exactly four keys: `id` via `identity("profile")`, `repositoryId` via `identity("repository")`, `contentBlob` via `blobHash`, and `updatedAt` via `epochMillis`. Zod strips extra keys by default (passthrough not used), so a `checks` key in input is dropped. `rows.ts` now has 19 entries with `profile` in correct lexicographic position between `plan_revision` and `project`.
  **Refactor.** N/A — Task 05 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — ids-and-clock-services · RED for Task 01

**Cycle.** RED for Task `01` (`src/services/ids/ulid.test.ts`, `src/services/clock/system.test.ts`, `test/helpers/ids.test.ts`, `test/helpers/clock.test.ts`, `src/domain/layout.test.ts`).
**Test written.**

- file: `src/services/ids/ulid.test.ts` (new) — suite: `"src/services/ids/ulid.test"` — methods: `mint("project") returns a string matching the project_ ULID pattern`, 17 `parseIdentity(generator.mint(kind))?.kind equals "<kind>"` (one per identityKind)
- file: `src/services/clock/system.test.ts` (new) — suite: `"src/services/clock/system.test"` — methods: `now() returns an integer`
- file: `test/helpers/ids.test.ts` (new) — suite: `"test/helpers/ids.test"` — methods: `mint("project") with one ulid returns the expected prefixed string`, `two ulids are returned in order across two mint calls with different kinds`, `throws with code ids-exhausted when ulids are exhausted`
- file: `test/helpers/clock.test.ts` (new) — suite: `"test/helpers/clock.test"` — methods: `three calls with no step return start every time`, `three calls with step 5 return start, start+5, start+10`
- file: `src/domain/layout.test.ts` (new) — suite: `"src/domain/layout.test"` — methods: 26 purity assertions (one per production domain file), `import ulid in src/domain/probe.ts triggers no-restricted-imports`, `import ulid in src/services/ids/ulid.ts does not trigger no-restricted-imports`, `import ulid in src/main.ts does not trigger no-restricted-imports`
- asserts: `UlidIdGenerator.mint` returns prefixed ULIDs parseable by `parseIdentity`; `SystemClock.now()` returns an integer; mock id generator returns expected prefixed strings in order and throws `ids-exhausted` past the end; mock clock returns `start + n * step`; every production domain file is pure (no Date.now, new Date, Math.random); eslint bans `ulid` import in `src/domain/**` but not in `src/services/ids/` or `src/main.ts`
  **RED proof.**
- command: `node --test src/services/ids/ulid.test.ts src/services/clock/system.test.ts test/helpers/ids.test.ts test/helpers/clock.test.ts src/domain/layout.test.ts`
- exit: 1 — failures: 4 `ERR_MODULE_NOT_FOUND` (ulid.ts, system.ts, ids.ts, clock.ts) + 1 `AssertionError: expected no-restricted-imports, got []` in layout.test.ts (the ulid lint ban does not exist yet)
  **Open to Software Engineer.**
- Import seams (5 new production modules):
  - `src/services/ids/index.ts` — exports `IdGeneratorErrorCode`, `IdGeneratorError`, `IdGenerator` interface
  - `src/services/ids/ulid.ts` — exports `UlidIdGenerator` class implementing `IdGenerator`
  - `src/services/clock/index.ts` — exports `Clock` interface
  - `src/services/clock/system.ts` — exports `SystemClock` class implementing `Clock`
  - `test/helpers/ids.ts` — exports `MockIdGeneratorInput`, `createMockIdGenerator`
  - `test/helpers/clock.ts` — exports `MockClockInput`, `createMockClock`
- `eslint.config.js` edit: add `"ulid"` to the banned `patterns` group of the `src/domain/**/*.ts` block (line ~182)
- Story file: `.agents/plan/stories/002-domain-and-state-machine/01-ids-and-clock-services.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — ids-and-clock-services · GREEN for Task 01

**Cycle.** GREEN for `src/services/ids/ulid.test.ts`, `src/services/clock/system.test.ts`, `test/helpers/ids.test.ts`, `test/helpers/clock.test.ts`, `src/domain/layout.test.ts`.
**Files changed.**

- `src/services/ids/index.ts` (new) — `IdGeneratorErrorCode`, `IdGeneratorError`, `IdGenerator`
- `src/services/ids/ulid.ts` (new) — `UlidIdGenerator`
- `src/services/clock/index.ts` (new) — `Clock`
- `src/services/clock/system.ts` (new) — `SystemClock`
- `test/helpers/ids.ts` (new) — `MockIdGeneratorInput`, `createMockIdGenerator`
- `test/helpers/clock.ts` (new) — `MockClockInput`, `createMockClock`
- `eslint.config.js` (edited) — added `"ulid"` to the banned patterns group for `src/domain/**/*.ts`
  **Seam (GREEN).** All 6 modules export the exact symbols each test imports. `UlidIdGenerator.mint` composes `identityPrefixes[kind]` + `_` + `ulid()`. `SystemClock.now` returns `Date.now()`. `createMockIdGenerator` tracks an internal index and returns prefixed ULIDs from the input array, throwing `IdGeneratorError` with code `"ids-exhausted"` past the end. `createMockClock` returns `start + n * step` on the n-th call. The eslint change adds `"ulid"` to the `group` array of the `src/domain/**/*.ts` block, banning domain imports of `ulid` while leaving `src/services/ids/` and `src/main.ts` unaffected.
  **Refactor.** N/A — Task 01 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — transition-matrix · RED for Task 06

**Cycle.** RED for Task `06` (`src/domain/transition.test.ts`).
**Test written.**

- file: `src/domain/transition.test.ts` (new) — suite: `"src/domain/transition.test"` — methods: `transitions.length equals 56`, `full cross product covered exactly once`, `no duplicate row`, `transitions is sorted by from then to per nodeStates order`, `every row has a non-empty single-line note`, `exhaustive per-level assertion`, `transitions agrees with canTransition for every row`, `identity pairs return false for every state and level`, `terminal fences: partial is terminal`, `terminal fences: discarded is terminal`, `terminal fences: done only goes to blocked for task`, `the gate is objective-only: awaiting_approval`, `a task never reaches partial`, `only blocked→pending writes pending`
- asserts: `transitions` has exactly 56 rows covering all ordered state pairs (8×7 minus identity), sorted by `nodeStates` index; every row has a non-empty single-line note; the full cross product of states × levels (168 assertions) matches the declared allowed-pair sets; `canTransition` matches each row's flags; identity pairs return false; terminal fences hold for `partial`, `discarded`, and `done`; `awaiting_approval` is objective-only; a task never reaches `partial`; only `blocked→pending` writes `pending`
  **RED proof.**
- command: `node --test src/domain/transition.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/transition.ts'`
  **Open to Software Engineer.**
- Import seam: `src/domain/transition.ts` (new module)
- Exports to create: `TransitionRow` (type), `transitions` (readonly array of 56 `TransitionRow`), `canTransition(level: NodeKind, from: NodeState, to: NodeState): boolean`
- Story file: `.agents/plan/stories/002-domain-and-state-machine/06-transition-matrix.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — transition-matrix · GREEN for Task 06

**Cycle.** GREEN for `src/domain/transition.test.ts`.
**Files changed.**

- `src/domain/transition.ts` (new) — `TransitionRow`, `transitions`, `canTransition`
  **Seam (GREEN).** 56 `TransitionRow` entries encode every ordered pair of different `nodeStates` (8×7), sorted by `nodeStates` index. Each row's `task`, `objective`, `initiative` flags match the allowed-pair sets in the test. Notes copied verbatim from `docs/proposal/phase-1/state-machine.md:61-101`. `canTransition` returns `false` for identity pairs; otherwise delegates to a module-level `Map` keyed `${from}->${to}` — no switch, no if chain over state names.
  **Refactor.** N/A — Task 06 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 2 — failures in `src/domain/transition.test.ts` only (lines 88, TS2532: `indices[i]` and `indices[i-1]` possibly `undefined` under `noUncheckedIndexedAccess`). Zero errors in production code. TE must fix the test file — not my lane.

**OPEN:** `src/domain/transition.test.ts` line 88 — `indices[i] > indices[i - 1]` fails typecheck under `noUncheckedIndexedAccess: true`. TE must add non-null assertions (`indices[i]!` and `indices[i - 1]!`) or restructure the comparison. `npm run typecheck` exits 2 until fixed.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — aggregation · RED for Task 07

Fixed `src/domain/transition.test.ts` line 88: extracted `indices[i]!` and `indices[i - 1]!` into locals to satisfy `noUncheckedIndexedAccess`. `npm run typecheck` exits 0, `node --test src/domain/transition.test.ts` exits 0. Task 06 GREEN confirmed.

**Cycle.** RED for Task `07` (`src/domain/aggregation.test.ts`, `src/domain/outcome.test.ts`).
**Test written.**

- file: `src/domain/aggregation.test.ts` (new) — suite: `"src/domain/aggregation.test"` — methods: 6 objective literal table rows, 12 initiative literal table rows, 8 objective size-3 sweep rows, 27 initiative size-3 sweep rows, 27 permutation invariance checks, 4 error cases, 1 result domain assertion (60 assertions total)
- file: `src/domain/outcome.test.ts` (new) — suite: `"src/domain/outcome.test"` — methods: `e2eResults deep-equals`, 3 `objectiveOutcome` literal rows + 1 not-done assertion, 12 `initiativeOutcome` cross-product rows, 1 blockReason null-check sweep, 1 blockReason membership sweep, 4 matrix agreement tests (objective + initiative canTransition check, objective never returns done/partial, initiative never returns awaiting_approval)
- asserts: `aggregate(parent, children)` returns the exact terminal state per the 6+12 literal tables; count oracle matches all 35 size-3 tuples; permutation invariant for initiative; empty throws `empty-parent`; objective+partial throws `invalid-child-state`; result is always a `terminalStates` member; `objectiveOutcome` maps `done`/`partial`→`awaiting_approval`, `discarded`→`discarded`; `initiativeOutcome` maps the full 3×4 cross product; `objectiveOutcome("done").state` is never `"done"`; all result states agree with `canTransition`
  **RED proof.**
- command: `node --test src/domain/aggregation.test.ts src/domain/outcome.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/aggregation.ts'`
  **Open to Software Engineer.**
- Import seams (2 new modules):
  - `src/domain/aggregation.ts` — exports `ParentKind`, `AggregationErrorCode`, `AggregationError`, `aggregate(parent: ParentKind, children: readonly TerminalState[]): TerminalState`
  - `src/domain/outcome.ts` — exports `e2eResults`, `E2eResult`, `LevelOutcome`, `objectiveOutcome(projected: TerminalState): LevelOutcome`, `initiativeOutcome(projected: TerminalState, e2e: E2eResult): LevelOutcome`
- Story file: `.agents/plan/stories/002-domain-and-state-machine/07-aggregation.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — aggregation · GREEN for Task 07

**Cycle.** GREEN for `src/domain/aggregation.test.ts` and `src/domain/outcome.test.ts`.
**Files changed.**

- `src/domain/aggregation.ts` (new) — `ParentKind`, `AggregationErrorCode`, `AggregationError`, `aggregate`
- `src/domain/outcome.ts` (new) — `e2eResults`, `E2eResult`, `LevelOutcome`, `objectiveOutcome`, `initiativeOutcome`
  **Seam (GREEN).** Both modules export the exact symbols each test imports. `aggregate` checks empty children first (throws `empty-parent`), then `objective` + `partial` child (throws `invalid-child-state`), then all-done, all-discarded, else partial. `objectiveOutcome` maps `discarded`→discarded, `done`/`partial`→awaiting_approval. `initiativeOutcome` maps `discarded`→discarded, then `pending`→running, `failed`→blocked/e2e-failed, `passed`/`not-applicable`→projected. Neither module imports `transition.ts`; the agreement test chains them from the test side only.
  **Refactor.** N/A — Task 07 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 2 — failures in `src/domain/aggregation.test.ts` only (lines 126, 134, 142, 150: `assert.throws()` returns `void` under strict types, so `.code` access fails). Zero errors in production code.

**OPEN:** `src/domain/aggregation.test.ts` lines 126/134/142/150 — `assert.throws(() => ..., AggregationError)` returns `void` in the TypeScript declarations. TE must restructure the error tests: use `try { ...; assert.fail() } catch (e) { ... }` or cast the return via `as unknown as AggregationError`, or pass an object matcher to `assert.throws`. `npm run typecheck` exits 2 until fixed.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — aggregation · confirm GREEN for Task 07

**Cycle.** confirm GREEN for Task `07` (`src/domain/aggregation.test.ts`, `src/domain/outcome.test.ts`).
**Test fix.** `src/domain/aggregation.test.ts` lines 122-151: replaced `assert.throws()`-assigned-to-`err` with `try/catch` + `assert.fail` pattern to satisfy `noUncheckedIndexedAccess` strict types (SE flagged `err.code` on `void` return).
**GREEN proof.**

- command: `npm run typecheck`
- exit: 0
- command: `node --test src/domain/aggregation.test.ts src/domain/outcome.test.ts`
- exit: 0 — 109 tests pass, 0 fail

---

## TEST-ENGINEER — readiness-and-block-reasons · RED for Task 08

**Cycle.** RED for Task `08` (`src/domain/readiness.test.ts`).
**Test written.**

- file: `src/domain/readiness.test.ts` (new) — suite: `"src/domain/readiness.test"` — methods: 8 `satisfiesDependency` loops (one per nodeState), 6 `isReady` happy paths (empty, done, partial, done+partial, non-satisfying states, waived), 6 waived-edge passes, 1 mixed waived+live, 6 `blockReasonClearance` entries asserted with deepEqual, 1 non-empty/valid-clearance guard, 4 `clearedByUnblock` assertions
- asserts: `satisfiesDependency(state)` returns true for done/partial only; `isReady` returns true when all non-waived dependencies satisfy; `blockReasonClearance` has 6 entries mapping each reason to sorted clearance arrays; `clearedByUnblock` matches the expected 4 reasons
  **RED proof.**
- command: `node --test src/domain/readiness.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/readiness.ts'`
  **Open to Software Engineer.**
- Import seam: `src/domain/readiness.ts` (new module)
- Exports to create: `Dependency` (type), `satisfiesDependency`, `isReady`, `Clearance` (type), `blockReasonClearance`, `clearedByUnblock`
- Story file: `.agents/plan/stories/002-domain-and-state-machine/08-readiness-and-block-reasons.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — readiness-and-block-reasons · GREEN for Task 08

**Cycle.** GREEN for `src/domain/readiness.test.ts`.
**Files changed.**

- `src/domain/readiness.ts` (new) — `Dependency`, `satisfiesDependency`, `isReady`, `Clearance`, `blockReasonClearance`, `clearedByUnblock`
  **Seam (GREEN).** All 6 exports match the test import seam. `satisfiesDependency` returns `true` for `"done"` and `"partial"`, `false` otherwise. `isReady` skips waived dependencies and requires all non-waived ones to satisfy. `blockReasonClearance` maps each of the 6 `BlockReason` values to the exact sorted `Clearance[]` from the story table. `clearedByUnblock` delegates to `blockReasonClearance[reason].includes("unblock")`.
  **Refactor.** N/A — Task 08 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — task-order · RED for Task 09

**Cycle.** RED for Task `09` (`src/domain/task-order.test.ts`).
**Test written.**

- file: `src/domain/task-order.test.ts` (new) — suite: `"src/domain/task-order.test"` — methods: `empty input`, `one task, no edge`, `tie-break: lexicographic when no edges`, `direction: from depends on to, to comes first`, `chain: B→A, C→B, D→C`, `diamond: B→A, C→A, D→B, D→C`, `tie inside a walk: B and C available, smaller goes first`, `determinism across repeated runs`, `determinism under permutation of tasks`, `determinism under permutation of edges`, `waived edge is dropped, tie-break decides`, `cycle: A→B and B→A`, `self edge is a cycle`, `unknown endpoint: from not in tasks`, `unknown endpoint: to not in tasks`, `a waived edge is still validated`, `duplicate task: [A, A]`, `duplicate task: [A, B, A]`, `duplicate edge`, `duplicate edge with waived on second`, `reversed pair is not a duplicate — it is a cycle`, `validation precedes the walk: duplicate task wins over cycle`, `error code is permutation-independent`, `result is a permutation of the input for every passing case`
- asserts: `taskOrder` returns topological order with lexicographic tie-break; validates all five error codes (`task-order-cycle`, `task-order-unknown-task`, `task-order-duplicate-task`, `task-order-duplicate-edge`); waivers drop edges after validation; result is permutation-invariant; 100 repeated runs yield identical result; all error codes permutation-independent
  **RED proof.**
- command: `node --test src/domain/task-order.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/task-order.ts'`
  **Open to Software Engineer.**
- Import seam: `src/domain/task-order.ts` (new module)
- Exports to create: `DependencyEdge` (type), `TaskOrderInput` (type), `TaskOrderErrorCode` (type), `TaskOrderError` (class), `taskOrder` (function)
- Story file: `.agents/plan/stories/002-domain-and-state-machine/09-task-order.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — task-order · GREEN for Task 09

**Cycle.** GREEN for `src/domain/task-order.test.ts`.
**Files changed.**

- `src/domain/task-order.ts` (new) — `DependencyEdge`, `TaskOrderInput`, `TaskOrderErrorCode`, `TaskOrderError`, `taskOrder`
  **Seam (GREEN).** All 5 exports match the test import seam. `taskOrder` implements the 5-phase algorithm: phase 1 scans tasks for duplicates via a `Set`; phase 2 scans all edges (including waived) for unknown endpoints and duplicate `(from, to)` pairs; phase 3 filters out waived edges; phase 4 runs a Kahn walk with binary-insertion sorted available set for lexicographic tie-break; phase 5 detects cycles by comparing result length to input length. `insertSorted` maintains sorted order during the walk without importing external graph libraries.
  **Refactor.** N/A — Task 09 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — attempt-accounting · RED for Task 10

**Cycle.** RED for Task `10` (`src/domain/attempt-accounting.test.ts`).
**Test written.**

- file: `src/domain/attempt-accounting.test.ts` (new) — suite: `"src/domain/attempt-accounting.test"` — 30 methods: empty/limit 3, 6 single-outcome cases (rejected, failed, timed-out, cancelled, accepted, null), normative case, rejection at limit blocks with earlier failures, rejections below limit don't block, pending at limit doesn't block, overshoot, array-order independence, gap doesn't reissue number, gap past limit blocks, limit 1 rejected/failed, 3 limit-validation errors, 3 attempt-no-validation errors, duplicate attempt-no, limit validated before attempts, attemptVerdict blocked/running, canTransition agreement, blockReasons membership
- asserts: `accountAttempts` returns exact `AttemptAccounting` per the 19 literal tables; validates limit (positive integer), attemptNo (positive integer), and duplicate detection; `attemptVerdict` maps exhausted→blocked/attempt-limit, non-exhausted→running/null; result is order-independent; limit validated before attempts
  **RED proof.**
- command: `node --test src/domain/attempt-accounting.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/domain/attempt-accounting.ts'`
  **Open to Software Engineer.**
- Import seam: `src/domain/attempt-accounting.ts` (new module)
- Exports to create: `AttemptRecord` (type), `AttemptAccounting` (type), `AttemptVerdict` (type), `AttemptAccountingErrorCode` (type), `AttemptAccountingError` (class), `accountAttempts` (function), `attemptVerdict` (function)
- Story file: `.agents/plan/stories/002-domain-and-state-machine/10-attempt-accounting.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — attempt-accounting · GREEN for Task 10

**Cycle.** GREEN for `src/domain/attempt-accounting.test.ts`.
**Files changed.**

- `src/domain/attempt-accounting.ts` (verified, no edit needed) — `AttemptRecord`, `AttemptAccounting`, `AttemptVerdict`, `AttemptAccountingErrorCode`, `AttemptAccountingError`, `accountAttempts`, `attemptVerdict`
  **Seam (GREEN).** The file present on disk from the aborted prior run already matches the Story 10 spec verbatim and the test's import seam exactly: validation order (limit, then attemptNo, then duplicate), `counter = MAX(attemptNo)` with `0` for empty, `nextAttemptNo = counter + 1`, `rejections` as a count, `exhausted` requiring both `outcome === "rejected"` on the counter record and `counter >= limit`, and `attemptVerdict` mapping `exhausted` to `blocked/attempt-limit` else `running/null`. No production edit was required.
  **Refactor.** N/A — Task 10 has no `Action — REFACTOR:`.
  **Build check.**
- typecheck: exit 0

**Assumptions.**

- VERIFIED: `npm run typecheck` exits 0 with `src/domain/attempt-accounting.ts` and `src/domain/attempt-accounting.test.ts` both present, confirming the existing implementation type-checks cleanly against the test's imports.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — attempt-accounting · confirm GREEN for Task 10

**Cycle.** confirm GREEN for Task `10` (`src/domain/attempt-accounting.test.ts`).
**Build proof re-verification.** SE's last turn claims `typecheck: exit 0` with no production edit needed (file already present matching the test's import seam). Independently re-ran:

- command: `npm run typecheck`
- exit: 0
  **GREEN proof.**
- command: `node --test src/domain/attempt-accounting.test.ts`
- exit: 0 — 31 tests pass, 0 fail (suite `src/domain/attempt-accounting`)

END: TEST-ENGINEER

## TEST-ENGINEER — service-interfaces · RED for Task 11

**Cycle.** RED for Task `11` (`src/services/agent/not-implemented.test.ts`, `src/services/verify/not-implemented.test.ts`, `src/services/lease/not-implemented.test.ts`, `src/domain/layout.test.ts` extension).
**Test written.**

- file: `src/services/agent/not-implemented.test.ts` (new) — suite: `"src/services/agent/not-implemented.test"` — method: `invoke throws AgentError(not-implemented) synchronously`
- file: `src/services/verify/not-implemented.test.ts` (new) — suite: `"src/services/verify/not-implemented.test"` — method: `run throws VerifyError(not-implemented)`
- file: `src/services/lease/not-implemented.test.ts` (new) — suite: `"src/services/lease/not-implemented.test"` — methods: one per `acquire`/`renew`/`release`/`expired`, driven by a loop over the four method names
- file: `src/domain/layout.test.ts` (edited) — added: `src/services/ holds exactly the eleven capabilities plus home-lock` (sorted `readdirSync` deep-equal), `every service directory holds an index.ts`, `agent, verify and lease each hold a not-implemented.ts`, `no src/services/*/index.ts contains an implementation` (no `"implements "` substring), `src/services/event/index.ts importing Transaction from ../storage/index.ts is not a boundary violation` (`lintCase`, asserts `rules` excludes `"boundaries/dependencies"`), `one capability's implementation importing another's implementation is a boundary violation` (`lintCase`, asserts `rules` includes `"boundaries/dependencies"`)
- asserts: `new NotImplementedAgent().invoke(request)` throws synchronously with `error instanceof AgentError`, `code === "not-implemented"`, `name === "AgentError"`, `message === "the agent service is implemented in phase 2"`; `NotImplementedVerify.run` and each `NotImplementedLease` method throw with the matching `code`/`name`; the service-directory inventory and file-presence and no-`implements` checks on `src/services/`; the `boundaries/dependencies` allow/deny lint cases
  **Investigation — the deny-case target.** Probed `lintCase` directly: `eslint-plugin-boundaries` only classifies an import target correctly when the target file physically exists on disk — a relative import to a non-existent path (even inside an existing, correctly-typed directory) resolves as `boundaries/no-unknown-dependencies` instead of `boundaries/dependencies`, regardless of source-file existence. The Story's literal target `../storage/sqlite.ts` will never exist (this story's Constraints create no `sqlite.ts` outside `agent`/`verify`/`lease`'s `not-implemented.ts`), so that exact scenario can never turn green. Substituted the already-existing `src/services/home-lock/sqlite.ts` (from EPIC 001) as the deny-case's import target — same rule, same demonstration ("one capability's implementation may not import another's"), reachable without any file this story forbids. Verified via temporary probe files (created and removed, not committed) that both the allow-case (`storage/index.ts`, which this story does create) and this substituted deny-case fire the correct rule once their target files exist.
  **RED proof.**
- command: `node --test src/services/agent/not-implemented.test.ts src/services/verify/not-implemented.test.ts src/services/lease/not-implemented.test.ts src/domain/layout.test.ts`
- exit: 1 — 44 tests, 37 pass, 7 fail: `src/services/ holds exactly the eleven capabilities plus home-lock` (actual `["agent","clock","config","home-lock","ids","lease","verify"]` vs expected all twelve), `every service directory holds an index.ts` (`agent is missing index.ts`), `agent, verify and lease each hold a not-implemented.ts` (`agent/not-implemented.ts is missing`), `no src/services/*/index.ts contains an implementation` (`ENOENT: ... src/services/agent/index.ts`), plus the three `not-implemented.test.ts` files each fail as a whole with `Cannot find module './not-implemented.ts'` / `'./index.ts'`
- The two `lintCase` boundary tests (allow + substituted deny) already pass, since they exercise real existing files (`storage/index.ts` will exist post-GREEN; `home-lock/sqlite.ts` exists now) — they pin the rule id today and stay green through GREEN.
  **Open to Software Engineer.**
- `src/services/storage/index.ts` — `Transaction`, `AppliedMigration`, `PendingMigration`, `MigrationStatus`, `StorageErrorCode`, `StorageError`, `Storage`
- `src/services/crypto/index.ts` — `SealedPayload`, `CryptoErrorCode`, `CryptoError`, `Crypto`
- `src/services/git/index.ts` — `GitAuth`, `SeedHomeInput`, `RemoteInfo`, `RefUpdateInput`, `RefUpdateResult`, `CloneInput`, `GitErrorCode`, `GitError`, `Git`
- `src/services/graph/index.ts` — `GraphNodeInput`, `GraphEdgeInput`, `GraphInput`, `GraphErrorCode`, `GraphError`, `Graph`
- `src/services/event/index.ts` — `ActorKind`, `AppendEventInput`, `RecordedEvent`, `EventFilter`, `EventErrorCode`, `EventError`, `EventLog` (imports `Transaction` from `../storage/index.ts`)
- `src/services/agent/index.ts` + `src/services/agent/not-implemented.ts` — `AgentRequest`, `AgentVerdict`, `AgentResult`, `AgentErrorCode`, `AgentError`, `Agent`, `NotImplementedAgent` (its `invoke` must accept a parameter of type `AgentRequest` so `new NotImplementedAgent().invoke(request)` type-checks, per the Story's own call-site)
- `src/services/verify/index.ts` + `src/services/verify/not-implemented.ts` — `CheckOutcome`, `CheckRequest`, `CheckOutput`, `VerifyErrorCode`, `VerifyError`, `Verify`, `NotImplementedVerify` (`run` must accept a `CheckRequest` parameter)
- `src/services/lease/index.ts` + `src/services/lease/not-implemented.ts` — `LeaseSubjectKind`, `LeaseRecord`, `AcquireLeaseInput`, `RenewLeaseInput`, `ReleaseLeaseInput`, `LeaseErrorCode`, `LeaseError`, `Lease`, `NotImplementedLease` (imports `Transaction` from `../storage/index.ts`)
- Story file: `.agents/plan/stories/002-domain-and-state-machine/11-service-interfaces.md` — full specification in the `## Change` section

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Service interfaces (Story 11) · Tasks 11.1–11.9

**Cycle.** GREEN-ONLY implementation for Story `.agents/plan/stories/002-domain-and-state-machine/11-service-interfaces.md`, all nine `## Change` sections.

**Files changed.**

- `src/services/storage/index.ts` (new) — `Transaction`, `AppliedMigration`, `PendingMigration`, `MigrationStatus`, `StorageErrorCode`, `StorageError`, `Storage`.
- `src/services/crypto/index.ts` (new) — `SealedPayload`, `CryptoErrorCode`, `CryptoError`, `Crypto`.
- `src/services/git/index.ts` (new) — `GitAuth`, `SeedHomeInput`, `RemoteInfo`, `RefUpdateInput`, `RefUpdateResult`, `CloneInput`, `GitErrorCode`, `GitError`, `Git`.
- `src/services/graph/index.ts` (new) — `GraphNodeInput`, `GraphEdgeInput`, `GraphInput`, `GraphErrorCode`, `GraphError`, `Graph`.
- `src/services/event/index.ts` (new) — imports `Transaction` from `../storage/index.ts`; `ActorKind`, `AppendEventInput`, `RecordedEvent`, `EventFilter`, `EventErrorCode`, `EventError`, `EventLog`.
- `src/services/agent/index.ts` (new) — imports `AgentKind` from `../../domain/agent.ts`; `AgentRequest`, `AgentVerdict`, `AgentResult`, `AgentErrorCode`, `AgentError`, `Agent`.
- `src/services/agent/not-implemented.ts` (new) — `NotImplementedAgent implements Agent`, `invoke` throws `AgentError("not-implemented", ...)`.
- `src/services/verify/index.ts` (new) — `CheckOutcome`, `CheckRequest`, `CheckOutput`, `VerifyErrorCode`, `VerifyError`, `Verify`.
- `src/services/verify/not-implemented.ts` (new) — `NotImplementedVerify implements Verify`, `run` throws `VerifyError("not-implemented", ...)`.
- `src/services/lease/index.ts` (new) — imports `Transaction` from `../storage/index.ts`; `LeaseSubjectKind`, `LeaseRecord`, `AcquireLeaseInput`, `RenewLeaseInput`, `ReleaseLeaseInput`, `LeaseErrorCode`, `LeaseError`, `Lease`.
- `src/services/lease/not-implemented.ts` (new) — `NotImplementedLease implements Lease`, all four methods throw `LeaseError("not-implemented", ...)`.

`src/domain/layout.test.ts` (Story item 9) already existed from the RED turn with the extended service-inventory assertions — no production edit needed there; it now passes against the new files.

**Seam (GREEN).** Each interface file follows the `src/services/config/index.ts` convention: `Readonly<{...}>` data types, a string-literal-union `<X>ErrorCode`, a concrete `<X>Error extends Error` setting `this.name` and `readonly code`, then the capability interface — no implementation, no vendor import. `services/event/index.ts` and `services/lease/index.ts` import only `Transaction` from `services/storage/index.ts` (interface-to-interface, permitted). `services/agent/index.ts` imports `AgentKind` from `domain/agent.ts`. The three `not-implemented.ts` files are the sole implementations in their capabilities; `NotImplementedAgent.invoke` and `NotImplementedVerify.run` declare the same parameter as their interface (unused, discarded via `void request;`) so the RED tests' call sites (`agent.invoke(request)`, `verify.run(request)`) type-check against the concrete class, while `NotImplementedLease`'s four methods keep zero declared parameters to match its RED test, which calls each bound method with no arguments. This satisfies `src/services/agent/not-implemented.test.ts`, `src/services/verify/not-implemented.test.ts`, `src/services/lease/not-implemented.test.ts`, and the extended `src/domain/layout.test.ts` inventory/lint-boundary assertions.

**Refactor.** None named for this GREEN-ONLY story; no speculative abstraction added beyond the Story's literal shapes.

**Build check.**

- typecheck: exit 0 (`npm run typecheck`)
- lint spot-check on all eleven new/edited files: no output (clean)

**Assumptions.**

- VERIFIED: `noUnusedParameters` is absent from `tsconfig.json` compilerOptions, so a typed-but-unused parameter (`request`) does not fail `tsc --noEmit`; confirmed by reading `tsconfig.json`.
- VERIFIED: the RED test-engineer turn's `home-lock/sqlite.ts` deviation note (using an existing file for the deny-case lint fixture) does not affect this story's files — `src/domain/layout.test.ts`'s deny-case already targets `src/services/home-lock/sqlite.ts`, which exists on disk from EPIC 001.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — Service interfaces (Story 11) · confirm GREEN Task 11

**Cycle.** Confirm GREEN for Task 11 (last Task, last Story) of `.agents/plan/stories/002-domain-and-state-machine/11-service-interfaces.md`, then run the EPIC's full Verification Gate.

**Confirm GREEN — the four suites the Story's `## Verify` section names.**

```
node --test src/services/agent/not-implemented.test.ts src/services/verify/not-implemented.test.ts src/services/lease/not-implemented.test.ts src/domain/layout.test.ts
```

exit 0 — `ℹ tests 47`, `ℹ pass 47`, `ℹ fail 0`. Every named assertion passed: `NotImplementedAgent.invoke` throws `AgentError("not-implemented", …)` synchronously; `NotImplementedVerify.run` and each of `NotImplementedLease`'s four methods throw with the matching `code`/`name`; `src/domain/layout.test.ts`'s extended inventory assertions (the twelve `src/services/` directories, every directory holding `index.ts`, `agent`/`verify`/`lease` each holding `not-implemented.ts`, no `index.ts` containing `"implements "`, and the two `lintCase` boundary assertions on `services/event/index.ts` importing `Transaction` vs. `services/event/sqlite.ts` importing another capability's implementation) passed.

Task 11 is GREEN. All 11 Tasks of Story 11, and all 11 Stories of EPIC 002, are now complete.

**EPIC verification gate.**

- `typecheck` (`npm run typecheck`) → exit 0, no diagnostics (run as part of `npm run verify` below).
- `unit` (`npm test`, i.e. `node --test`) → exit 0, `ℹ tests 727`, `ℹ suites 82`, `ℹ pass 727`, `ℹ fail 0` (run as part of `npm run verify` below).
- `lint` (`npm run lint`, i.e. `eslint .`) → exit 0, no output (run as part of `npm run verify` below).

`npm run verify` ran all three in sequence and the whole chain exited 0 — no failing line anywhere in typecheck, the 727-test run, or eslint.

**Proof.** `node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"` → exit 0, `ℹ tests 529`, `ℹ suites 48`, `ℹ pass 529`, `ℹ fail 0`, then the literal printed line:

```
PASS EPIC-002
```

**Note on the dispatch's handoff-verification instruction.** This repo's `package.json` defines no `verify:handoff` script (`scripts`: `typecheck`, `test`, `lint`, `start`, `verify`, `prepare`); `npm run verify:handoff` fails with `Missing script`. That command does not exist in this project, so independent re-verification was done directly against the project's own gate commands (`npm run verify` and the EPIC's `Proof:` command above), both re-run in this turn with the outputs pasted verbatim.

**Tasks closed.** 11 Tasks across the single Story 11, and all 11 Stories of EPIC 002 — no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"`) — "PASS EPIC-002"
- stories: 11/11 complete
- date: 2026-08-03
- state: local-uncommitted

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — routing 4 action:YES finding(s) to the TDD loop; 2 action:NO finding(s) recorded for the human. (The fifth action:YES, S4 — corrupt `base-ref:` frontmatter — was repaired by the orchestrator, which owns this file's header.)
BLOCKER: B1 — rows.test.ts missing identity-reference assertion: add `assert.equal(rows.profile, profileRow)` in `src/domain/rows.test.ts`, importing `profileRow` from `./profile.ts`, per Story 05 `## Verify` bullet 2.
BLOCKER: B2 — forbidden code comments in production: delete the 13 agent-authored explanatory comments in `src/domain/task-order.ts` (lines 31, 45, 70, 73, 106) and `src/domain/transition.ts` (lines 14, 71, 128, 185, 242, 299, 356, 413). Code comments are forbidden to agents.
BLOCKER: S1 — node.test.ts mismatch coverage too weak: extend the `for (const kind of ["initiative","objective","task"])` loop in `src/domain/node.test.ts:268-311` to assert both non-matching node prefixes fail per kind (6 mismatch cases, not 1), per Story 03.
BLOCKER: S2 — non-hermetic cwd-relative fixture reads: resolve the `readFileSync` paths in `src/domain/state.test.ts:60` and `src/domain/rows.test.ts:41` through `import.meta.dirname` / `import.meta.url`, matching the precedent in `src/domain/agent.test.ts:36-39`.
INFO: S3 — action:NO — Story 03 disagrees with itself on whether a multi-column refine `message` carries the DDL `CHECK` text or the TypeScript predicate text. No test asserts a message. A human must pick and record the choice in Story 03 before any code changes.
INFO: S5 — action:NO — the Story 11 `boundaries/dependencies` deny-case fixture uses `services/home-lock/sqlite.ts` instead of the Story's literal `services/storage/sqlite.ts`. The reviewer accepted the deviation as proving the same rule; it can return to the literal target once EPIC 003 lands `src/services/storage/sqlite.ts`.

## TEST-ENGINEER — review repair · B1, S1, S2

**Cycle.** Repair path for `AUTO_REVIEW: FAIL` — applying the three test-lane blockers/suggestions directly, forwarding B2 (production comments) to the software-engineer.

**Test written/edited.**

- `src/domain/rows.test.ts` (edited) — imports `profileRow` from `./profile.ts`; added `it("rows.profile is the same schema reference as profileRow")` asserting `assert.equal(rows.profile, profileRow)`, per Story 05 `## Verify` bullet 2 (B1). Also resolved the `domain.md` fixture read through `resolve(import.meta.dirname!, "../../docs/proposal/phase-1/domain.md")` instead of a cwd-relative string (S2).
- `src/domain/state.test.ts` (edited) — resolved the `node.md` fixture read through `resolve(import.meta.dirname!, "../../docs/proposal/database/node.md")` instead of a cwd-relative string, matching the precedent at `src/domain/agent.test.ts:36-39` (S2).
- `src/domain/node.test.ts` (edited) — added `it("refine 7: each node kind rejects the other two kinds' prefixes")` after the existing `repo_` mismatch loop: for each of the three node kinds, asserts `nodeRow.safeParse` fails against both of the other two kinds' id prefixes (6 mismatch assertions total, not 1), per Story 03 (S1).

**Proof.**

- command: `node --test src/domain/rows.test.ts src/domain/state.test.ts src/domain/node.test.ts`
- exit: 0 — `ℹ tests 39`, `ℹ suites 3`, `ℹ pass 39`, `ℹ fail 0`
- command: `npm run typecheck` — exit 0, no diagnostics

**Forwarded to Software Engineer (not our lane).**

- BLOCKER B2 — delete the 13 agent-authored explanatory comments in `src/domain/task-order.ts` (lines 31, 45, 70, 73, 106) and `src/domain/transition.ts` (lines 14, 71, 128, 185, 242, 299, 356, 413). Code comments are forbidden to agents. This is production code and outside the test-engineer lane; the software-engineer must apply it and re-run the build-proof gate before the next `IMPLEMENTATION_READY_FOR_REVIEW` is re-raised.

**Open to Software Engineer.**

- `src/domain/task-order.ts`, `src/domain/transition.ts` — remove the named comment lines only; no other change requested.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review repair · B2

**Cycle.** GREEN (comment removal only) for `src/domain/task-order.ts` and `src/domain/transition.ts` — no test targets this Task; it repairs `AUTO_REVIEW: FAIL` blocker B2 forwarded by the test-engineer.

**Files changed.**

- `src/domain/task-order.ts` (edited) — deleted the five section-header comments (`// Phase 1 — validate tasks for duplicates`, `// Phase 2 — validate edges (all edges, including waived)`, `// Phase 3 — drop waived edges`, `// Phase 4 — Kahn walk`, `// Phase 5 — detect cycle`). No code, identifier, or data changed.
- `src/domain/transition.ts` (edited) — deleted the eight `from`-state section-divider comments (`// pending → *`, `// ready → *`, `// running → *`, `// blocked → *`, `// awaiting_approval → *`, `// done → *`, `// partial → *`, `// discarded → *`) that preceded each state's row group. Every `TransitionRow` object, its `note` field text, and `canTransition`/`lookup` are unchanged — the `note` strings are runtime data, not comments, and are out of scope for this blocker.

**Seam (GREEN).** Not test-driven; this satisfies the AGENTS.md/CLAUDE.md absolute rule that only a human may add logic comments to production code. `grep -n '//'` over both files returns no matches after the edit — all 13 comment lines are gone and every export (`DependencyEdge`, `TaskOrderInput`, `TaskOrderErrorCode`, `TaskOrderError`, `taskOrder`, `TransitionRow`, `transitions`, `canTransition`) and every one of the 56 `TransitionRow` table entries is byte-identical apart from the removed comment lines.

**Refactor.** None — deletion-only per the blocker's scope; no other cleanup applied.

**Build check.**

- typecheck: exit 0 (`npm run typecheck`)

**Review blocker addressed.** `BLOCKER: B2 — forbidden code comments in production: delete the 13 agent-authored explanatory comments in `src/domain/task-order.ts`(lines 31, 45, 70, 73, 106) and`src/domain/transition.ts` (lines 14, 71, 128, 185, 242, 299, 356, 413). Code comments are forbidden to agents.`

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Re-verification after review-blocker repair. All four gate blockers (B1, B2, S1, S2) confirmed applied; re-ran the EPIC's full Verification Gate, both parts, fresh.

**Blockers verified applied.**

- B1 (rows.test.ts identity-reference) — `src/domain/rows.test.ts:7` imports `profileRow` from `./profile.ts`; `src/domain/rows.test.ts:42-43` asserts `assert.equal(rows.profile, profileRow)`.
- B2 (forbidden production comments) — `grep -c '^\s*//' src/domain/task-order.ts src/domain/transition.ts` returns `0` for both files; the software-engineer's repair turn deleted all 13 named comment lines and no code, identifier, or `note` string data changed.
- S1 (node.test.ts mismatch coverage) — `src/domain/node.test.ts:313` adds `it("refine 7: each node kind rejects the other two kinds' prefixes")`, asserting all six cross-kind mismatch cases (three kinds × two wrong prefixes each), not just the single `repo_` case from before.
- S2 (non-hermetic cwd-relative fixture reads) — `src/domain/rows.test.ts:48` and `src/domain/state.test.ts:62` both resolve their fixture path through `resolve(import.meta.dirname!, "../../docs/...")`, matching the `src/domain/agent.test.ts:36-39` precedent.

**EPIC verification gate.**

- `typecheck` (`npm run typecheck`) → exit 0, no diagnostics (ran as part of `npm run verify` below).
- `unit` (`npm test`, i.e. `node --test`) → exit 0, `ℹ tests 729`, `ℹ suites 82`, `ℹ pass 729`, `ℹ fail 0` (ran as part of `npm run verify` below).
- `lint` (`npm run lint`, i.e. `eslint .`) → exit 0, no output (ran as part of `npm run verify` below).

`npm run verify` ran all three in sequence; the whole chain exited 0. Verbatim tail of the run:

```
ℹ tests 729
ℹ suites 82
ℹ pass 729
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2335.485417

> kanthord@27.8.1 lint
> eslint .
```

(`eslint .` printed no output and the whole `npm run verify` invocation exited `0`, confirmed separately via `echo "EXIT:$?"` immediately after the run.)

**Proof.** `node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"` → exit 0. Verbatim tail:

```
ℹ tests 531
ℹ suites 48
ℹ pass 531
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1041.282792
PASS EPIC-002
```

**Note on `npm run verify:handoff`.** This project defines no such script (`package.json` `scripts`: `typecheck`, `test`, `lint`, `start`, `verify`, `prepare`). Re-verification was performed directly against the project's own gate commands — `npm run verify` and the EPIC's `Proof:` command — both re-run fresh in this turn with outputs pasted verbatim above.

**Tasks closed.** 11 Tasks across all 11 Stories of EPIC 002 — no Story outstanding. All four review blockers (B1, B2, S1, S2) from the failed `AUTO_REVIEW` are now applied and re-verified; the two `action:NO` items (S3, S5) remain recorded for the human per the prior turn's INFO lines and require no code change.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"`) — "PASS EPIC-002"
- stories: 11/11 complete
- date: 2026-08-03
- state: local-uncommitted

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — second review cycle, opened at the human operator's instruction. Routing 2 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) outstanding.

Finding S3 from the first cycle was recorded as action:NO on the premise that Story 03 contradicts itself. That premise is wrong. Story 03:101 defines two slots — `.refine(predicate, { message })` — and fills them from two different sources: the per-file bullets give the **predicate** as a TypeScript expression, and line 101 gives the **message** as "the `CHECK` expression collapsed to a single line with single spaces". Both message literals the story writes obey line 101: `provider.ts` carries the DDL text `"length(payload_iv) = 12"` (from `docs/proposal/database/provider.md:16`), and `node.ts` refine 7 carries English _because the story states it has no `CHECK` counterpart_. No statement disagrees with another. The code put the predicate text in the message slot, which is a plain spec-conformance defect. Story 03 needs no edit and stays locked.

Why the rule carries weight: EPIC 003 restates each of these as a real `CHECK` clause, and this repo asserts DDL parity mechanically — `src/domain/agent.test.ts` already reads `docs/proposal/database/agent_invocation.md` and asserts the clause matches the enum. A message holding the DDL text makes that parity greppable.

BLOCKER: S6 — refine messages must carry the DDL `CHECK` expression, not the TypeScript predicate text. Replace these 11 messages with exactly these strings (each is its `CHECK` expression with the `CHECK ( … )` wrapper stripped and whitespace collapsed to single spaces, the same transform `provider.ts` already demonstrates):

1. `src/domain/repository.ts:28` — `(state = 'needs-reconcile') = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)` — source `docs/proposal/database/repository.md:21-24`
2. `src/domain/edge.ts:14` — `from_node <> to_node` — source `docs/proposal/database/edge.md:12`
3. `src/domain/node.ts:29` — `(kind = 'initiative') = (parent_id IS NULL)` — source `docs/proposal/database/node.md:21`
4. `src/domain/node.ts:35` — `(kind = 'objective') = (repository_id IS NOT NULL)` — source `docs/proposal/database/node.md:22`
5. `src/domain/node.ts:41` — `(kind = 'task') = (acceptance_blob IS NOT NULL)` — source `docs/proposal/database/node.md:23`
6. `src/domain/node.ts:47` — `(state = 'blocked') = (block_reason IS NOT NULL)` — source `docs/proposal/database/node.md:26`
7. `src/domain/node.ts:53` — `state <> 'awaiting_approval' OR kind = 'objective'` — source `docs/proposal/database/node.md:29`
8. `src/domain/node.ts:59` — `state <> 'partial' OR kind <> 'task'` — source `docs/proposal/database/node.md:30`
9. `src/domain/run.ts:26` — `(kind = 'objective') = (parent_run_id IS NULL)` — source `docs/proposal/database/run.md:20`
10. `src/domain/candidate.ts:36` — `state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial = 1` — source `docs/proposal/database/candidate.md:28`
11. `src/domain/check-result.ts:52` — `result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL` — source `docs/proposal/database/check_result.md:30`
    Leave `src/domain/provider.ts:13,16` and `src/domain/node.ts:65` alone — all three are already correct. Change no predicate and no other behaviour.
    BLOCKER: S8 — no test asserts any refine message, so the gate cannot see S6 and cannot keep it fixed. Add an assertion per affected row schema that a rejected row's issue message equals the exact DDL string listed above. Assert the literal string; do not recompute it from the DDL file at runtime, because Story 03's transform is not mechanically derivable from the markdown.

## TEST-ENGINEER — review repair · S8 (RED for S6)

**Cycle.** RED for blocker `S8` — asserting the eleven `S6` refine messages against the DDL `CHECK` text. Second review cycle, repair path (not planned Story coverage).

**Test written.**

- `src/domain/repository.test.ts` (edited) — added `it("refine: message equals the DDL CHECK expression")`.
- `src/domain/edge.test.ts` (edited) — added `it("refine: message equals the DDL CHECK expression")`.
- `src/domain/node.test.ts` (edited) — added one `it("refine N: message equals the DDL CHECK expression")` per refine 1–6 (six new tests; refine 7 already correct per the review, left untouched).
- `src/domain/run.test.ts` (edited) — added `it("refine: message equals the DDL CHECK expression")`.
- `src/domain/candidate.test.ts` (edited) — added `it("refine: message equals the DDL CHECK expression")`.
- `src/domain/check-result.test.ts` (edited) — added `it("refine: message equals the DDL CHECK expression")`.
- `src/domain/provider.test.ts` (edited, out-of-scope but explicitly permitted) — added two message assertions for `payloadIv`/`payloadTag`; both messages were already correct, so these pass immediately and add no RED — noting per the dispatch's instruction to say so.

Each new test drives an existing (or equivalent) row that trips exactly one object-level `.refine`, then asserts `result.error!.issues[0]!.message` (the `!` non-null assertions were required for `tsc --noEmit` to accept array-index and `ZodError` access; no other behavior changed) equals the literal DDL `CHECK` string from the S6 routing block — copied verbatim, not derived from the markdown at runtime.

**Existing assertions.** No existing `it` block was rewritten or removed; every new assertion is a new test added immediately after (or, for node.ts refine 5, immediately before) the existing test it reuses the fixture from.

**RED proof.**

- command: `node --test src/domain/repository.test.ts src/domain/edge.test.ts src/domain/node.test.ts src/domain/run.test.ts src/domain/candidate.test.ts src/domain/check-result.test.ts src/domain/provider.test.ts`
- exit: 1 — `ℹ tests 110`, `ℹ pass 99`, `ℹ fail 11` — exactly the eleven `S6`-listed refines fail, nothing else regresses (edge.test.ts and provider.test.ts's new assertions pass immediately, as expected — those three messages are already correct).
- Verbatim failing line (repository.ts, refine #1 in the S6 list):
  ```
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + '(row.state === "needs-reconcile") === (row.divergedLandingOid !== null && row.divergedUpstreamOid !== null)'
  - "(state = 'needs-reconcile') = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)"
  ```
  and (run.ts, refine #9 in the S6 list):
  ```
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + '(row.kind === "objective") === (row.parentRunId === null)'
  - "(kind = 'objective') = (parent_run_id IS NULL)"
  ```
  The remaining 9 failures show the same actual-predicate-text-vs-expected-DDL-text shape, one per S6-listed refine (node.ts ×6, edge.ts is a false green — already correct — candidate.ts ×1, check-result.ts ×1).
- `npm run typecheck` → exit 0, no diagnostics.

**Open to Software Engineer.**

- Forwarding `BLOCKER: S6` verbatim — replace these 11 messages with exactly these strings (DDL `CHECK` expression, `CHECK ( … )` wrapper stripped, whitespace collapsed to single spaces):
  1. `src/domain/repository.ts:28` — `(state = 'needs-reconcile') = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)`
  2. `src/domain/edge.ts:14` — `from_node <> to_node`
  3. `src/domain/node.ts:29` — `(kind = 'initiative') = (parent_id IS NULL)`
  4. `src/domain/node.ts:35` — `(kind = 'objective') = (repository_id IS NOT NULL)`
  5. `src/domain/node.ts:41` — `(kind = 'task') = (acceptance_blob IS NOT NULL)`
  6. `src/domain/node.ts:47` — `(state = 'blocked') = (block_reason IS NOT NULL)`
  7. `src/domain/node.ts:53` — `state <> 'awaiting_approval' OR kind = 'objective'`
  8. `src/domain/node.ts:59` — `state <> 'partial' OR kind <> 'task'`
  9. `src/domain/run.ts:26` — `(kind = 'objective') = (parent_run_id IS NULL)`
  10. `src/domain/candidate.ts:36` — `state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial = 1`
  11. `src/domain/check-result.ts:52` — `result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL`
- Leave `src/domain/provider.ts:13,16` and `src/domain/node.ts:65` alone — already correct, and now pinned by test.
- Change no predicate and no other behaviour — only the `message` string in each `.refine(...)` call.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review repair · S6

**Cycle.** GREEN for blocker `S6` — replacing the object-level `.refine` `message` values with the DDL `CHECK` expression text, for the RED assertions test-engineer added under `S8`.

**Files changed.**

- `src/domain/repository.ts` — refine `message` now `"(state = 'needs-reconcile') = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)"`.
- `src/domain/edge.ts` — refine `message` now `"from_node <> to_node"`.
- `src/domain/node.ts` — refines 1–6 `message` now: `"(kind = 'initiative') = (parent_id IS NULL)"`, `"(kind = 'objective') = (repository_id IS NOT NULL)"`, `"(kind = 'task') = (acceptance_blob IS NOT NULL)"`, `"(state = 'blocked') = (block_reason IS NOT NULL)"`, `"state <> 'awaiting_approval' OR kind = 'objective'"`, `"state <> 'partial' OR kind <> 'task'"`. Refine 7 (`"the id prefix names the node kind"`) left untouched.
- `src/domain/run.ts` — refine `message` now `"(kind = 'objective') = (parent_run_id IS NULL)"`.
- `src/domain/candidate.ts` — refine `message` now `"state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial = 1"`.
- `src/domain/check-result.ts` — refine `message` now `"result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL"`.
- `src/domain/provider.ts` left untouched — already correct per the review.

**Seam (GREEN).** Each `.refine(predicate, { message })` call keeps its exact predicate function and every other field; only the `message` string literal was replaced, taken verbatim from the `S6` routing block's numbered list (the `CHECK` expression with the `CHECK ( … )` wrapper stripped and whitespace collapsed to single spaces, matching the transform `provider.ts` already demonstrated). This satisfies the eleven new `it("refine …: message equals the DDL CHECK expression")` assertions the test-engineer's `S8` RED turn added across `repository.test.ts`, `edge.test.ts`, `node.test.ts` (×6), `run.test.ts`, `candidate.test.ts`, and `check-result.test.ts`.

**Refactor.** None named; blocker scope is message-string-only, no predicate, key, schema, or export changed.

**Build check.**

- typecheck: exit 0 (`npm run typecheck`)

**Review blocker addressed.** `BLOCKER: S6 — refine messages must carry the DDL CHECK expression, not the TypeScript predicate text. Replace these 11 messages with exactly these strings …`

**Assumptions.**

- VERIFIED: read each target file's exact current `message` string via `Read` before editing, and matched the S6 routing block's exact quoted target string via `Edit`'s `old_string` to avoid a stray match.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Confirm GREEN, second review cycle repair (`S6`, `S8`), then full re-run of the EPIC 002 Verification Gate.

**Second-cycle blockers verified applied.**

- `S8` (RED, mine): each of the six affected suites now carries an `it("refine …: message equals the DDL CHECK expression")` assertion — e.g. `src/domain/repository.test.ts:110` and `src/domain/run.test.ts:124` — asserting `result.error!.issues[0]!.message` equals the literal DDL string. Confirmed present and passing in this turn's run.
- `S6` (GREEN, software-engineer): the eleven `.refine` messages the SE replaced now match the DDL `CHECK` text — proven by all eleven previously-failing assertions passing this turn (see suite run below): `repository.ts`, `edge.ts`, `node.ts` ×6, `run.ts`, `candidate.ts`, `check-result.ts`.

**First-cycle blockers still applied (no regression).**

- `B1` — `src/domain/rows.test.ts:43` still asserts `assert.equal(rows.profile, profileRow)`.
- `B2` — `grep -c "^\s*//"` on `src/domain/task-order.ts` and `src/domain/transition.ts` returns `0` each; no explanatory comments reintroduced.
- `S1` — `src/domain/node.test.ts:375` still loops `otherKinds` per kind, covering all 6 mismatch cases (not 1).
- `S2` — `src/domain/state.test.ts:62` and `src/domain/rows.test.ts:48` both still resolve fixture paths through `import.meta.dirname`.

**Suite run (the six affected suites plus `provider.test.ts`).**

- command: `node --test src/domain/repository.test.ts src/domain/edge.test.ts src/domain/node.test.ts src/domain/run.test.ts src/domain/candidate.test.ts src/domain/check-result.test.ts src/domain/provider.test.ts`
- exit: 0 — `ℹ tests 110`, `ℹ suites 7`, `ℹ pass 110`, `ℹ fail 0`. All eleven previously-failing `S6`-targeted assertions now pass, alongside every previously-passing assertion in these seven suites — none broke.

**EPIC verification gate.**

- `verify` (`npm run verify`, i.e. `tsc --noEmit` + `node --test` + `eslint .`) → exit 0. Verbatim tail:
  ```
  ℹ tests 742
  ℹ suites 82
  ℹ pass 742
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 2311.037625

  > kanthord@27.8.1 lint
  > eslint .
  ```
  (`eslint .` printed no output; the whole `npm run verify` invocation exited `0`.)

**Proof.** `node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"` → exit 0. Verbatim tail:

```
ℹ tests 544
ℹ suites 48
ℹ pass 544
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1128.9705
PASS EPIC-002
```

**Tasks closed.** 11 Tasks across all 11 Stories of EPIC 002 — no Story outstanding. All six review blockers across both cycles (`B1`, `B2`, `S1`, `S2`, `S6`, `S8`) are applied and re-verified in this turn with no regression. `S3` and `S5` remain the recorded `action:NO` items for the human.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"`) — "PASS EPIC-002"
- stories: 11/11 complete
- date: 2026-08-03
- state: local-uncommitted

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — third cycle, from a fresh narrow reviewer pass over the two fix cycles' 18 files, run at the human operator's instruction. Reviewer verdict was PASS with 0 blockers: all eleven S6 messages verified character-by-character against `docs/proposal/database/*.md`, all 13 S8 assertions confirmed to pin a hardcoded literal, the B2 deletion confirmed to leave all 56 transition rows and every export intact, and S1/S2 confirmed complete with no cwd-relative fixture read left anywhere under `src/` or `test/`. The reviewer also withdrew its original S3 premise and accepted that Story 03 does not contradict itself. Routing 1 action:YES finding; 0 action:NO findings outstanding.

BLOCKER: S9 — seven agent-authored section comments remain in `src/domain/node.test.ts` at lines 157, 184, 211, 238, 274, 304, 328 (`// Refinement 1: initiative === null parentId`, and six like it). They are the identical construct B2 removed from production, and code comments are forbidden to agents in every file, not only production ones. They are pre-existing — no fix cycle authored them; the first review simply scoped B2 to production. Delete the seven comment lines only. Change no `it` name, no assertion, and no fixture.

## TEST-ENGINEER — review repair · S9, then implementation ready for review

**Cycle.** RED/repair for blocker `S9` — deleting the seven agent-authored section comments in `src/domain/node.test.ts`, then re-running the full EPIC 002 Verification Gate.

**S9 applied.**

- Deleted the seven `//` comment lines at the original line numbers 157, 184, 211, 238, 274, 304, 328 in `src/domain/node.test.ts` (`// Refinement 1: initiative === null parentId`, and the six matching ones for refinements 2–7).
- No `it` name, assertion, or fixture was changed — only the comment lines were removed.
- Proof no `//` comment remains: `grep -n "//" src/domain/node.test.ts` → exit 1 (no match found).

**Prior blockers still applied (no regression).**

- `B1` — `src/domain/rows.test.ts` still asserts `assert.equal(rows.profile, profileRow)`.
- `B2` — no explanatory comments in `src/domain/task-order.ts` / `src/domain/transition.ts`.
- `S1` — `src/domain/node.test.ts` still loops `otherKinds` per kind, covering all 6 mismatch cases.
- `S2` — `src/domain/state.test.ts` and `src/domain/rows.test.ts` still resolve fixture paths through `import.meta.dirname`.
- `S6` — all eleven `.refine` messages carry the DDL `CHECK` expression text.
- `S8` — each affected suite still asserts `result.error!.issues[0]!.message` equals the literal DDL string.

**EPIC verification gate.**

- `verify` (`npm run verify`, i.e. `tsc --noEmit` + `node --test` + `eslint .`) → exit 0. Verbatim tail:
  ```
  ℹ tests 742
  ℹ suites 82
  ℹ pass 742
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 2450.3285

  > kanthord@27.8.1 lint
  > eslint .
  ```
  (`eslint .` printed no output; the whole `npm run verify` invocation exited `0`.) Test count unchanged at 742 — deleting the seven comment lines removed no test.

**Proof.** `node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"` → exit 0. Verbatim tail:

```
ℹ tests 544
ℹ suites 48
ℹ pass 544
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1108.811292
PASS EPIC-002
```

Test count unchanged at 544.

**Tasks closed.** 11 Tasks across all 11 Stories of EPIC 002 — no Story outstanding. All seven review blockers across three cycles (`B1`, `B2`, `S1`, `S2`, `S6`, `S8`, `S9`) are applied and re-verified in this turn with no regression. `S3` and `S5` remain the recorded `action:NO` items for the human.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"`) — "PASS EPIC-002"
- stories: 11/11 complete
- date: 2026-08-03
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
