# EPIC 052.1 — The structural acceptance — stories

Epic: `.agents/plan/epics/052.1-the-structural-acceptance.md`
Prereq: EPIC 052 (sequence order). Story 1 reads its `stagePatch`, Story 2 its `graphPatch` and
`renderGraphPatch`, Stories 4 and 5 its three shape verdicts, Stories 6 and 7 its two policy
verdicts, Story 8 its delete verdict, and Story 9 its `execution.writeCheckpoint` and the two new
`NodeWrite` fields. EPIC 051.3 supplies the `checkpoint` table, EPIC 051.4 the
`src/commands/checkpoint/` directory and the report prelude, and EPIC 050.2 the run authority and the
`run.ended` event type.

An accepted graph patch becomes the checkpoint of a structural run: one command, one transaction, and
a compare and swap before every graph read. EPIC 052.2 carries the seventh `node.report` member that
delivers the patch, and this epic injects the command nowhere.

## One story, one path

Eight stories carry a diagram, and two carry none.

- Stories 2 to 9 draw the eight paths of `acceptStructural`: the two pure refusals, the currentness
  refusal, the two shape refusals, the pair refusal, the validator refusal, the delete refusal, and
  the acceptance.
- Stories 1 and 10 are `story-foundation`: a pure function and its ordering guarantee, and the
  proposal amendment. Neither changes a drawn path, so neither draws anything.

**Every prior set in this epic is empty, so this epic draws no `baseline-` diagram and every token of
every diagram is `+`.** `acceptStructural` is a new command, so every path it has is written from
nothing. No story of this epic changes an existing command, so no story of it declares a baseline.

| story | diagram                                       | steps | terminal                         |
| ----- | --------------------------------------------- | ----- | -------------------------------- |
| 2     | `accept-structural-refusal-unparsable`        | 0     | `refuse:patch-unparsable`        |
| 3     | `accept-structural-refusal-stale-revision`    | 1     | `refuse:stale-revision`          |
| 4     | `accept-structural-refusal-shape-resolved`    | 2     | `refuse:patch-target-invalid`    |
| 5     | `accept-structural-refusal-shape-unresolved`  | 3     | `refuse:patch-project-invalid`   |
| 6     | `accept-structural-refusal-pair-fixed`        | 3     | `refuse:pair-fixed`              |
| 7     | `accept-structural-refusal-graph-invalid`     | 4     | `refuse:plan-invalid`            |
| 8     | `accept-structural-refusal-delete-ineligible` | 5     | `refuse:patch-delete-ineligible` |
| 9     | `accept-structural-success`                   | 14    | `ok`                             |

**The seven refusal diagrams are not one prefix chain, and three conditional reads are why.**
`plan.nodeProjects`, `execution.hasAcceptedCheckpoint` and `plan.structuralDeleteBindings` each fire
only for a patch that holds the content they answer, so the traces branch rather than nest. Diagram 4
and diagram 5 are one refusal group on two fixtures; diagram 6 is shorter than diagram 7 even though
`pair-fixed` precedes `plan-invalid`, because the pair read replaces the validator reads rather than
adding to them.
`.agents/plan/epics/052.1-the-structural-acceptance.md:74` — `conditionality` states the counting
rule that follows from it: a diagram per refusal group against one declared fixture, and a reachable
trace of an already-drawn terminal asserted by a case rather than drawn.

## Dispatch order

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`

- Story 1 is first because its `authoredEpics` entry is what makes every later scenario file legal.
  `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` refuses a scenario naming no live
  diagram.
- Stories 2 to 9 are strictly serial: each adds one statement to `acceptStructural`, in the order the
  refusal chain runs.
- Story 9 carries the `shippedEpics` entry, which makes every diagram of this epic due, so it lands
  only when all eight scenario files exist.
- Story 10 is last because it records behaviour every earlier story settled.

No story depends on a later one.

## Stories

- 1 — the lowering, and the `authoredEpics` entry → `01-the-lowering.md` — draws nothing
- 2 — the command, and the two pure refusals → `02-an-unparsable-patch-reaches-no-seam.md` — draws
  `accept-structural-refusal-unparsable`
- 3 — the compare and swap → `03-a-stale-revision-refuses-before-any-graph-read.md` — draws
  `accept-structural-refusal-stale-revision`
- 4 — the graph read, and the two verdicts that need no projection →
  `04-a-resolved-target-or-scope.md` — draws `accept-structural-refusal-shape-resolved`
- 5 — the cross-project resolver, and the two verdicts it settles →
  `05-an-unresolved-reference-reaches-the-resolver.md` — draws
  `accept-structural-refusal-shape-unresolved`
- 6 — the pair policy, before the validator →
  `06-a-fixed-pair-refuses-before-the-validator.md` — draws `accept-structural-refusal-pair-fixed`
- 7 — the shipped structural validator, and the at-least-one-child rule →
  `07-an-invalid-staged-graph-or-an-empty-expansion.md` — draws
  `accept-structural-refusal-graph-invalid`
- 8 — the delete guard, the decision table and the no-write proof →
  `08-an-ineligible-delete-refuses.md` — draws `accept-structural-refusal-delete-ineligible`
- 9 — the writes, and the `shippedEpics` entry → `09-the-accepted-patch.md` — draws
  `accept-structural-success`
- 10 — the proposal amendment → `10-the-proposal-records-the-structural-acceptance.md` — draws nothing

No story is a groundwork story. Every path this epic edits is allowed to an engineer by
`scripts/lane-check.sh`, `src/domain/`, `src/commands/`, `docs/proposal/` and
`scripts/epic-sequence-range.ts` included, so the epic holds no `00-groundwork.md` and no `Paths:`
line.

## Facts (needed for implementation)

- **`worker.md` lives outside this repository.** It is `../docs/workflow/worker.md`, in the kanthord
  superproject, not `docs/proposal/phase-2/worker.md`. Its section 2 is `## 2. Node` at
  `../docs/workflow/worker.md:59` — `Node`, section 7 is `## 7. Exclusion` at `:375` — `Exclusion`, and
  section 8 is `## 8. Checkpoint` at `:414` — `Checkpoint`. Every citation of it in EPIC 052.1
  resolves at the line it names.
- **`reportOutcome` opens its transaction as its first statement.**
  `src/commands/outcome/report-outcome.ts:107` — `transact`. Nothing in this epic can run before a
  transaction exists, which is why `acceptStructural` holds no `storage` key.
- **`assertRunAuthority`, `execution.runById`, `execution.writeCheckpoint`, `plan.readSubtree` on a run
  path, `expiry.expireRuns` in `reportOutcome`, the `checkpoint` table and the `accept` dependency key
  do not exist in `src/` today.** `src/services/execution/index.ts:95` — `Execution` holds twelve
  methods and no checkpoint method, and `grep -rn checkpoint src/` returns nothing. Every one of them
  is EPIC 050.2, 051.3 or 051.4 output, and this epic dispatches after all three.
- **No projection exists for `blobs.put`, `ids.mint`, `plan.readGraph`, `plan.newestRevision`,
  `plan.readValidationContext`, `plan.mutateGraph`, `graph.cycles`, `revision.render`,
  `revision.record`, `execution.hasAcceptedCheckpoint` or `accept.structural`.**
  `test/helpers/sequence-conformance.ts:50` — `projections` is the whole table. Each draws a bare
  token, so each may appear at most once per diagram: `parseDiagram` refuses a repeated token. Every
  fixture of this epic is stated at a length that keeps each of them singular.
- **`events.append` projects `type`, `subjectId` and, whenever the payload holds a `reason` key,
  `String(payload.reason)`.** `test/helpers/sequence-conformance.ts:81` — `reason`. The shipped
  `outcome.reported` payload holds `reason` at `src/commands/outcome/report-outcome.ts:302` — `reason`,
  and an accepted report carries it as `null`, so the token is `events.append:outcome.reported:N:null`.
- **`INSERT_NODE` overwrites every ordinary column on conflict, and preserves only four.**
  `src/services/plan/sqlite.ts:43` — `INSERT_NODE`. `state`, `block_reason`, `discard_reason` and
  `assignment` are in the `VALUES` and in no `SET` clause. `deliverable` and `verify_json` are gated by
  two has-flags computed with `Object.hasOwn` at `src/services/plan/sqlite.ts:435` — `hasDeliverable`.
  An `update` that omits a field therefore loses it unless the lowering resubmits it.
- **`mutateGraph` applies its four arrays in the phase order nodes, edge deletes, node deletes, edge
  inserts, each in caller order.** `src/services/plan/sqlite.ts:467` — `mutateGraph`. The phase order
  settles edges against nodes; the order inside each array is `lowerPatch`'s obligation.
- **`PlanStore` has no read of a graph at a past revision.** `src/services/plan/index.ts:71` —
  `readGraph` returns the live graph. The currentness guard is what makes the live graph the pinned
  graph.
- **`plan_revision.origin` admits `import` and `node-write` only.**
  `src/services/storage/migration-0006-revision-origin.ts:13` — `origin`. A third value rebuilds the
  table, and this epic writes no migration.
- **`accepted` is already a legal attempt outcome.** `src/domain/attempt.ts:8` — `accepted`.
- **The production registry declares `expansion` on `research@1` alone, which is not among the first
  two workers.** `../docs/workflow/worker.md:209` — `research@1`. Every test of this epic supplies
  `expansionCapableRegistry` at `test/helpers/worker-registry.ts:3` —
  `expansionCapableRegistry`, and Story 10
  (`10-the-proposal-records-the-structural-acceptance`) case 1 asserts the production behaviour so
  nobody reads the fixture as production.
- **`z.unknown()` is optional inside a `strictObject`.** The seventh member's `patch` therefore
  carries `.refine((value) => value !== undefined)`, which keeps the field required and still emits a
  flat `{}` schema with no `$ref`. The member itself is EPIC 052.2 Story 1
  (`01-the-contract-carries-the-patch`)'s; the fact is kept here because this epic's refusal order is
  what forces the opaque shape.

## Decisions taken during authoring, and now recorded in the EPIC

- **`acceptStructural` holds no `storage` key and no `clock` key, and no diagram of it draws
  `storage.transact`.** The epic's story-3 entry names `storage.transact` as step 1;
  `.agents/plan/epics/052.1-the-structural-acceptance.md:33` — `acceptStructural`, its gate row 8 and
  `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:91` — `acceptStructural` all say
  the opposite, and `src/commands/outcome/report-outcome.ts:107` — `transact` makes the entry
  unimplementable. Gate row 8 is discharged by the absence of the key and by the diagram comparison;
  gate row 7 by the zero-step diagram of Story 2. `clock` is absent because
  `test/helpers/clock.ts:6` — `calls` increments the mock on every read, so a second read inside one
  transaction would stamp two times onto writes that must share one. See
  `02-an-unparsable-patch-reaches-no-seam.md`.
- **`lowerPatch` takes an injected `mintEdgeId`, in a `dependencies`-first signature.** The epic's
  story-1 entry names three positional arguments, and `eslint.config.js:315` — `no-restricted-imports`
  forbids `src/domain/` every source of identity. `src/domain/plan-candidate.ts:304` —
  `validateCandidateStructural` is the shape precedent in the same directory. See `01-the-lowering.md`.
- **`accept-structural-success` states an `update` fixture, not a `create` fixture.** A `create` puts
  the instruction prose, the acceptance prose for a task and the patch bytes — three `blobs.put` calls
  drawing one bare token, which `parseDiagram` refuses. The fixture states a length of one, and the
  `create` path's three puts are asserted by Story 9 case 8. See `09-the-accepted-patch.md`.
- **Both event payloads are the shipped ones.** `outcome.reported` keeps its nine keys with
  `objectId` set to the patch blob hash, `reason` null and `fromState` equal to `toState`; `run.ended`
  keeps EPIC 050.2's five keys with `reason: "accepted"`. No event type and no payload shape changes,
  which is what the epic's Decision at `:68` — `no new event type` requires. See
  `09-the-accepted-patch.md`.
- **An undeclared contract error is caught by one mechanism, and it is not the coverage test.**
  `src/http/server/node/report-node.test.ts:24` — `reportErrorEnvelope` builds the envelope from
  `operation.errors` and `:324` parses a real refusal response against it. It is EPIC 052.2's, and
  that epic's Story 2 (`02-the-report-route-carries-a-patch`) case 6 parses all eleven.
  `src/http/contract/coverage.test.ts:536` — `errorStatuses` checks only the reverse direction, that
  a declared code is a known code, so it catches nothing here. No story of this epic edits
  `src/http/`.

- **`acceptStructural` returns `attemptsRemaining: null`, `objectiveState: null` and
  `objectiveProjection: null`.** The run ends in this transaction, so no attempt of it can open again;
  a structural run claims an initiative or a parent objective, which has no objective above it to
  project. All three fields are nullable at `src/http/contract/outcome.ts:62` — `attemptsRemaining` and
  `:64` — `objectiveState`, and none of them costs a seam call, so the command never reads
  `plan.readAllNodes`. See `09-the-accepted-patch.md`.
- **The `authoredEpics` entry lands in Story 1 and the `shippedEpics` entry in Story 9.**
  `.agents/plan/epics/053-node-state-ownership.md:5` — `authoredEpics` records that EPIC 052.1 owns
  its own insert. The two lists are split across the first story and the last drawing story because
  the first makes a scenario file legal and the second makes every diagram due. EPIC 052.2 registers
  itself the same way, in its own Story 2 (`02-the-report-route-carries-a-patch`).
- **Gate row 34 is Story 9's, and gate row 18 splits into rows 18 and 18a.**
  `test/sequence/conformance.test.ts:82` — `liveDiagrams` replays a diagram only once its epic sits in
  `shippedEpics`, and Story 9 is the story that puts `"052.1"` there, so it is the only story that can
  prove the replay. Story 9 case 10 additionally calls
  `test/helpers/sequence-conformance.ts:318` — `assertConformance` directly over its own scenario,
  which gives the loop a real RED before the registration lands. Row 18 splits because its tenth
  group, the authority prelude, belongs to `reportOutcome`, which this epic does not touch; row 18a
  is EPIC 052.2's.
- **The candidate reads a blob hash without writing a blob.** `src/domain/plan-candidate.ts:15` —
  `CandidateNode` requires `title`, `instructionBlob` and `acceptanceBlob`, and `StagedNode` carries
  none of the three. Validation runs before every `blobs.put`, so a created node has no stored hash
  yet. Story 7 (`07-an-invalid-staged-graph-or-an-empty-expansion`) reads it with
  `src/services/blob/index.ts:24` — `hash`, which computes a content hash
  and writes nothing, and `src/services/blob/sqlite.ts:24` — `put` returns the same hash for the same
  bytes later. The alternative — moving the puts before validation — was refused: it contradicts the
  epic's Decision at `.agents/plan/epics/052.1-the-structural-acceptance.md:62` — `orphan`, and the
  Decision needs no exception. A fabricated empty hash was refused because nothing structural reading
  a field does not make a false value acceptable.

- **`lowerPatch` takes the resolved prose hashes as their own input.** `GraphPatch` carries
  `instruction` and `acceptance` as prose, so it can carry no hash, and `LoweredNode.instructionBlob`
  requires one. Story 1 (`01-the-lowering`)'s `LowerPatchInput` gains a `prose` map keyed by mutation
  id, and Story 9 (`09-the-accepted-patch`) builds it from the values `blobs.put` returned.

- **`lowerPatch` names no service type.** `NodeWrite` at `src/services/plan/index.ts:25` and
  `MutateGraphInput` at `:45` live in a service interface, and `AGENTS.md` admits `domain/` to import
  `domain/` only. Story 1 (`01-the-lowering`) declares `LoweredNode` and `LoweredEdge` with the
  identical member set, so `LoweredPatch` is structurally assignable to `MutateGraphInput` and Story 9
  (`09-the-accepted-patch`) passes it through with no cast. The epic's gate row 6a is what keeps the
  twin shapes in step. This is blocker B1 of the EPIC 052 triage, repaired in the split.
