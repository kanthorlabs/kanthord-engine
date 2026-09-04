# EPIC 053 — Node state ownership — stories

Epic: `.agents/plan/epics/053-node-state-ownership.md`
Prereq: EPIC 052.1 (sequence order). This epic reads no output of it. It reads EPIC 047's pair table
for the `stateOwner` vocabulary, EPIC 051.6's `report-checkpoint-reap` for the diagram story 7
supersedes, and the shipped `aggregateInitiative` of EPIC 019 for the shape it copies.

A parent state derives from its children, and a run never writes a parent terminal state. One new
command aggregates a parent objective inside the caller's transaction, one new pure function decides
its state and its trigger, and the initiative rolls up from it when every task is discarded.

## What changed after review

The epic as drafted put the aggregation in `reportOutcome`. It cannot go there. After EPIC 051.4 that
command performs no node-state write on the accepted arm:
`.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/08-the-report-route-enforces-the-gate.md:13`
— `Seams` removes `plan.setNodeState:T:outcome-accepted`, `events.append:outcome.reported:T:null` and
`plan.readAllNodes` from the route, and
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:9` — `Seams` holds
all three. `land-settle-accepted` opens its own transaction at its step 2, so any caller further out
would put the task's terminal write and the parent's aggregation in **two** transactions, which
`AGENTS.md` refuses. Story 8 (`08-the-accepted-settle-aggregates-the-parent`) supersedes that diagram
instead, and EPIC 051.6's `report-checkpoint-reap` is left untouched.

**The re-read the epic asked for is gone, and ordering replaced it.** `land-settle-accepted` already
reads `plan.readAllNodes` at its step 13 and builds the `NodeReportResult` from it. Inserting the
aggregation **before** that read makes it post-transition, so `objectiveState` names the state the
settle leaves behind with no second read. A second `plan.readNode` was impossible anyway: it is
already step 3, `test/helpers/sequence-conformance.ts:50` — `projections` gives it no projection, and
`.agents/plan/stories/050.2-the-run-renew-release-and-report/02-the-authority-seams.md:164` —
`plan.readNode` forbids adding one, so the repeat would hit
`test/helpers/sequence-conformance.ts:284` — `duplicate token in diagram`.

**The null-id path gained its own zero-step diagram.** `.agents/plan/authoring.md:188` —
`A diagram with no step is legal` says a path differing from another only by calling nothing is drawn
that way and never described in prose. It is Story 3
(`03-the-aggregation-declines-a-null-objective-id`), and the epic grew from eight stories to nine,
inside the cap of ten.

## What is proven, and what is not

`node scripts/verify-epic-sequence.ts` does not read this directory: it iterates
`scripts/epic-sequence-range.ts:1` — `authoredEpics`, which does not yet hold `"053"`, and
`test/sequence/conformance.test.ts:82` — `liveDiagrams` replays only the four EPIC 050.1 scenarios.
What is checked here is the parser grammar, the `Seams:` signs, and every citation, each verified
against the tree at the exact line and identifier. The diagrams themselves are checked when Story 1
(`01-the-parent-objective-outcome`) lands `"053"`.

## The gate rows, and who owns them

| rows  | owner                                                                |
| ----- | -------------------------------------------------------------------- |
| 1–3   | Story 1 (`01-the-parent-objective-outcome`)                          |
| 4–5   | Story 2 (`02-the-triggers-and-the-payload-variant`)                  |
| 6     | Story 3 (`03-the-aggregation-declines-a-null-objective-id`)          |
| 6a    | Story 4 (`04-the-aggregation-declines-a-parent-that-is-not-running`) |
| 7     | Story 5 (`05-the-aggregation-declines-while-a-task-is-not-terminal`) |
| 8–9   | Story 6 (`06-the-aggregation-reaches-the-human-gate`)                |
| 10–11 | Story 7 (`07-the-aggregation-discards-and-rolls-the-initiative-up`)  |
| 12–18 | Story 8 (`08-the-accepted-settle-aggregates-the-parent`)             |

Every row has exactly one owner. Row 6 split into 6 and 6a, because the null-id trace and the
absent-or-not-running trace are now two stories and two diagrams. Story 9
(`09-the-proposal-records-state-ownership`) owns no row, and it invents none.

## One story, one path

Six stories carry a diagram, and three carry none.

- Stories 3 to 7 draw the five paths of `aggregateObjective`: the null id, the state refusal, the
  terminal gate, the human gate and the discard with its roll-up.
- Story 8 (`08-the-accepted-settle-aggregates-the-parent`) draws the one changed path of `landSettle`.
- Stories 1, 2 and 9 are `story-foundation`: a pure function and the range entry, two table rows and a
  payload variant, and the proposal document. None changes a drawn path.

**Every prior set of `aggregateObjective` is empty, so Stories 3 to 7 draw no `baseline-` diagram and
every token of every one of them is `+`.** It is a new command, so every path it has is written from
nothing. Story 8 is the only story that changes an existing path, and it declares `Supersedes:` rather
than `Baselines:`, because EPIC 051.3 already drew it.

| story | diagram                                 | steps | terminal |
| ----- | --------------------------------------- | ----- | -------- |
| 3     | `aggregate-objective-null-id`           | 0     | `ok`     |
| 4     | `aggregate-objective-not-running`       | 1     | `ok`     |
| 5     | `aggregate-objective-not-terminal`      | 2     | `ok`     |
| 6     | `aggregate-objective-awaiting-approval` | 4     | `ok`     |
| 7     | `aggregate-objective-discarded`         | 5     | `ok`     |
| 8     | `land-settle-aggregate`                 | 15    | `ok`     |

**The five `aggregateObjective` diagrams are one prefix chain, and that is the shape of the command.**
Each story adds one guard or one write to the end of a straight line, so diagram _n_ is diagram _n−1_
plus its own steps. Every terminal is `ok`, because a decline is a normal return and not a refusal:
`aggregateObjective` returns `void` and raises no error a client reads. Story 3's diagram holds no
step at all, which asserts the path reaches no seam.

## Dispatch order

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9`

- Story 1 is first because its `authoredEpics` entry is what makes every later scenario file legal.
  `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` refuses a scenario naming no live
  diagram.
- Story 2 follows Story 1 and precedes Story 6, because
  `src/services/plan/sqlite.ts:515` — `triggerTransition` throws on a trigger the internal table does
  not declare, so no write of this epic can land before its two rows exist.
- Stories 3 to 7 are strictly serial: each appends one block to `aggregateObjective`, in execution
  order. Story 3 case 2 is the RED that Story 4 turns green.
- Story 8 dispatches after Story 7, because it injects the finished command. It carries the
  `shippedEpics` entry and the superseded scenario deletion in one turn.
- Story 9 is last because it records behaviour every earlier story settled, and nothing depends on it.

No story depends on a later one.

## Stories

- 1 — the parent-objective outcome, the dead branch and the `authoredEpics` entry →
  `01-the-parent-objective-outcome.md` — draws nothing
- 2 — the two internal triggers and the `tasks-terminal` payload variant →
  `02-the-triggers-and-the-payload-variant.md` — draws nothing
- 3 — the command file, its dependency shape and the null guard →
  `03-the-aggregation-declines-a-null-objective-id.md` — draws `aggregate-objective-null-id`
- 4 — the node read and the state guard →
  `04-the-aggregation-declines-a-parent-that-is-not-running.md` — draws
  `aggregate-objective-not-running`
- 5 — the child read, the bytewise order and the terminal gate →
  `05-the-aggregation-declines-while-a-task-is-not-terminal.md` — draws
  `aggregate-objective-not-terminal`
- 6 — the projection, the transition and the event →
  `06-the-aggregation-reaches-the-human-gate.md` — draws `aggregate-objective-awaiting-approval`
- 7 — the discard and the guarded initiative roll-up →
  `07-the-aggregation-discards-and-rolls-the-initiative-up.md` — draws
  `aggregate-objective-discarded`
- 8 — the settle aggregates, the `main.ts` binding and the `shippedEpics` entry →
  `08-the-accepted-settle-aggregates-the-parent.md` — draws `land-settle-aggregate`
- 9 — the proposal and the README row → `09-the-proposal-records-state-ownership.md` — draws nothing

No story is a groundwork story. `scripts/lane-check.sh` allows every path this epic edits to one
engineer or the other — `src/domain/`, `src/commands/`, `src/http/contract/`, `docs/proposal/`,
`test/`, `src/main.ts` and `scripts/epic-sequence-range.ts` included — so the epic holds no
`00-groundwork.md` and no `Paths:` line.

## Facts (needed for implementation)

- **A bare-function dependency records no token.**
  `test/helpers/sequence-conformance.ts:113` — `typeof capability` returns any non-object dependency
  unwrapped, so `reportObjective` and `closeObjective` at
  `src/commands/outcome/report-outcome.ts:59` and `:63` are invisible to the recorder and no diagram
  of this range draws either. The `initiative` roll-up of this epic is an **object with an `aggregate`
  method** for exactly that reason, following `Expiry` at
  `test/sequence/scenarios/claim-success-task.ts:81` — `expiry`, which is drawn.
- **A participant key must be lower-case-initial and hold no capital.**
  `test/helpers/sequence-conformance.ts:259` — the token pattern is
  `/^([a-z][a-z0-9-]*)\.([a-z][a-zA-Z0-9]*)(?::(.+))?$/`, so a camelCase dependency key such as
  `aggregateObjective` or `rollUp` cannot appear in a token. The key is `initiative` and the method is
  `aggregate`.
- **No projection exists for `plan.readNode`, `plan.readAllNodes` or `initiative.aggregate`.**
  `test/helpers/sequence-conformance.ts:50` — `projections` is the whole table, fifteen entries. Each
  unlisted method draws a bare token, so each may appear at most once per diagram:
  `test/helpers/sequence-conformance.ts:284` — `duplicate token in diagram` refuses a repeat.
- **Adding a projection for `plan.readNode` is forbidden.**
  `.agents/plan/stories/050.2-the-run-renew-release-and-report/02-the-authority-seams.md:164` —
  `plan.readNode` rules it out, and seventy citations across EPICs 050.2 to 052.1 draw the bare token.
  A path that must read two different nodes therefore cannot draw both reads.
- **`plan.setNodeState` projects `id` and `trigger`; `events.append` projects `type`, `subjectId` and
  the payload's `reason` when it holds one.** `test/helpers/sequence-conformance.ts:51` and `:72`. The
  `tasks-terminal` payload holds a `reason`, so every `events.append` token of this epic carries three
  labels.
- **An objective row may hold `awaiting_approval` with no PRAGMA bypass.**
  `src/services/storage/migration-0002-graph-and-plan.ts:40` — `awaiting_approval` reads
  `CHECK (state <> 'awaiting_approval' OR kind = 'objective')`. Only a task row needs the bypass of
  `src/commands/outcome/report-outcome.test.ts:258` — `seedTaskState`.
- **`setNodeState` fails silently on a stale `from` and throws on a wrong trigger.**
  `src/services/plan/sqlite.ts:526` — `before.state` returns `[]` when the stored state is not the
  declared `from`, while `:511` throws on a cell outside the matrix, `:517` throws when the trigger
  declares a different pair, and `:522` throws when the trigger's `levels` omit the node kind. The
  silent arm is this epic's precedence mechanism; the throwing arms are why Story 2 exists.
- **`objectiveOutcome`'s `discarded` branch is already dead code.**
  `src/commands/outcome/report-objective.ts:137` — `projection-discarded` throws for a `discarded`
  projection seven lines before `:140` — `objectiveOutcome` is called. Removing the branch changes no
  shipped behaviour, and `src/commands/outcome/report-objective.ts` is not edited by this epic.
- **`aggregateInitiative` places its empty-child throw after the terminal gate, and that order
  matters.** `src/commands/outcome/aggregate-initiative.ts:42` — `everyTerminal` precedes `:45` —
  `holds no objective`, because `[].every(...)` is `true`. `src/domain/aggregation.ts:23` —
  `empty-parent` therefore never fires from either aggregation path.
  `src/commands/outcome/close-objective.ts:113` — `holds no task` orders the two the other way, and
  that asymmetry is shipped and not this epic's to repair.
- **`test/sequence/scenarios/` holds four files, all EPIC 050.1's.**
  `scripts/epic-sequence-range.ts:20` — `shippedEpics` is `["050", "050.1"]`, so every diagram from
  EPIC 050.2 onward is authored and not yet due, `report-checkpoint-reap` included. That diagram has
  no scenario file today, and its deletion by story 7 is a no-op against the present tree.
- **`worker.md` lives outside this repository**, at `../docs/workflow/worker.md` in the kanthord
  superproject. Its section 6 is `## 6. Node state` at `../docs/workflow/worker.md:359` — `Node state`.
- **`aggregate` refuses a `partial` task and an initiative parent alike.**
  `src/domain/aggregation.ts:31` — `a task is never partial` fires only for
  `parent === "objective"`. Neither `empty-parent` nor `invalid-child-state` appears in
  `src/http/contract/errors.ts:7` — `errorStatuses`, so neither is a refusal a client reads.

## Decisions taken during authoring, and now recorded in the EPIC

- **Both roll-up injections are object capabilities: `objective.aggregate` into `landSettle`, and
  `initiative.aggregate` into `aggregateObjective`.** The epic's Decisions now record it.
  `test/helpers/sequence-conformance.ts:113` — `typeof capability` returns a function dependency
  unwrapped, so a bare callable records no token and the epic's gate row 17 — the comparison must fail
  when the aggregation is removed — could not hold. `reportObjective` and `closeObjective` stay bare
  callables, because no diagram draws either, and
  `test/sequence/scenarios/claim-success-task.ts:81` — `expiry` is the shipped drawable idiom this
  copies. See `03-the-aggregation-declines-a-null-objective-id.md` and
  `08-the-accepted-settle-aggregates-the-parent.md`.
- **`parentObjectiveOutcome` returns a two-member discriminated union, and its `trigger` is typed by
  its two literals rather than by `InternalTriggerId`.** Story 2
  (`02-the-triggers-and-the-payload-variant`) is what puts those ids in
  `src/domain/node-trigger.ts:8` — `internalTriggerIds`, so Story 1 cannot name that type and still
  compile. The literal union is narrower, it is assignable to
  `src/services/plan/index.ts:59` — `trigger` once Story 2 lands, and Story 2 case 3 asserts the
  binding in both directions. See `01-the-parent-objective-outcome.md`.
- **`ParentObjectiveOutcome` carries no `blockReason`, so it is a second type beside `LevelOutcome`.**
  `src/domain/outcome.ts:12` — `LevelOutcome` pairs a state with a block reason, and neither state
  this function returns is `blocked`. The trigger takes that member's place, because
  `src/services/plan/sqlite.ts:515` — `triggerTransition` makes the state and the trigger one
  decision. See `01-the-parent-objective-outcome.md`.
- **Story 3 creates a file a shipped test asserts is absent, and it repairs that assertion.**
  `src/domain/external-transition.test.ts:655` — `existsSync` asserts
  `src/commands/outcome/aggregate-objective.ts` does not exist. Its expected value inverts to `true`;
  the two `assert.notEqual` consumer loops at `:571` and `:646` stay, because this command writes
  internal triggers and must never appear in
  `src/domain/external-transition.ts:215` — `externalTriggerConsumer`. The epic's Proof block now names
  the file. See
  `03-the-aggregation-declines-a-null-objective-id.md`.
- **The whole dependency shape lands in Story 3, `initiative` included, before anything calls it.** A
  required key added in Story 7 would break the scenario files Stories 3 to 6 wrote, and each scenario
  is written once. See `03-the-aggregation-declines-a-null-objective-id.md`.
- **`aggregate-objective-not-running` covers the absent node and every non-running state, because
  one guard decides both.** `node === null || node.state !== "running"` is a single expression, and
  splitting the two would need a second `plan.readNode` that no path makes. The null-id trace reaches
  no seam and is Story 3 (`03-the-aggregation-declines-a-null-objective-id`)'s own zero-step diagram,
  which `.agents/plan/authoring.md:188` — `A diagram with no step is legal` requires. See
  `04-the-aggregation-declines-a-parent-that-is-not-running.md`.
- **`aggregate-objective-awaiting-approval` states a three-`done` fixture, and the `partial`
  projection is not drawn.** A mixture of `done` and `discarded` produces the identical four tokens
  with the identical labels, because `projection` sits inside the payload and
  `test/helpers/sequence-conformance.ts:72` — `events.append` does not project it. Two fixtures with
  one trace are one diagram. See `06-the-aggregation-reaches-the-human-gate.md`.
- **The two triggers sit before the three `initiative-aggregated-*` ids in both tables.**
  `src/domain/node-trigger.test.ts:148` — `row.trigger` pins `internalTransitions` to `internalTriggerIds` by
  order, so the insertion is one index in two places. The position is the product's aggregation order:
  an objective aggregates from its tasks before an initiative aggregates from its objectives. See
  `02-the-triggers-and-the-payload-variant.md`.
- **The two unions add no OpenAPI component, and the master closure stays at `158`.**
  `src/http/contract/openapi.ts:60` — `Object.entries(eventPayloads)` converts one registry entry at a
  time, so nothing hoists across entries, and `z.toJSONSchema` of a `z.union` of two `strictObject`s
  emits a bare `anyOf` with both members inlined and no `$defs`. This was settled by running the
  conversion, not predicted, so Story 2 states the number rather than asking its implementer to
  discover it. See `02-the-triggers-and-the-payload-variant.md`.
- **Story 2 lifts the shipped `object-attested` object to a named `attestedPayload` const rather than
  inlining it in the union.** `src/http/contract/event-payload.ts:125` — `node.done` and `:130` —
  `node.partial` both write `z.union([<named>, <named>])`, and the file names every reused payload.
  The lift changes no field. See `02-the-triggers-and-the-payload-variant.md`.
- **Story 8 carries the `shippedEpics` entry and the superseded scenario deletion in one turn, and
  Story 9 edits no range.** `test/sequence/conformance.test.ts:39` — `shipped` marks a diagram
  superseded only when the naming epic sits in `shippedEpics`, so a deletion landing first leaves
  `land-settle-accepted` due with no scenario, which
  `test/sequence/conformance.test.ts:126` — `scenario files` refuses. EPIC 051.6 Story 3
  (`03-the-report-reaps-on-every-settled-terminal`) pairs the two the same way. See
  `08-the-accepted-settle-aggregates-the-parent.md`.
- **The two unions add no OpenAPI component, and the master closure stays at `158`.**
  `src/http/contract/openapi.ts:60` — `Object.entries(eventPayloads)` converts one registry entry at a
  time, so nothing hoists across entries, and `z.toJSONSchema` of a `z.union` of two `strictObject`s
  emits a bare `anyOf` with both members inlined and no `$defs`. This was settled by running the
  conversion, not predicted, so Story 2 states the number rather than asking its implementer to
  discover it. See `02-the-triggers-and-the-payload-variant.md`.
- **Story 2 lifts the shipped `object-attested` object to a named `attestedPayload` const rather than
  inlining it in the union.** `src/http/contract/event-payload.ts:125` — `node.done` and `:130` —
  `node.partial` both write `z.union([<named>, <named>])`, and the file names every reused payload.
  The lift changes no field. See `02-the-triggers-and-the-payload-variant.md`.
- **Story 8 is the only story that can prove the epic's gate row 17, which the epic assigns to story 7. The epic's table needs the edit; this story does not make it.**
  `test/sequence/conformance.test.ts:82` — `liveDiagrams` replays a diagram only once its epic sits in
  `shippedEpics`, and Story 8 is what puts `"053"` there, so no earlier story can prove the runner
  replay. Each drawing story instead calls
  `test/helpers/sequence-conformance.ts:318` — `assertConformance` directly over its own scenario,
  which gives the loop a real RED before the registration lands. This is the arrangement EPIC 052.1
  Story 9 (`09-the-accepted-patch`) already uses. See `09-the-proposal-records-state-ownership.md`.
- **Story 9 adds a row to `docs/proposal/phase-2/README.md`, which the epic did not mention.**
  `test/helpers/proposal.test.ts:71` — `the phase-2 file table and the phase-2 directory agree`
  compares the `## Files` links against the directory listing, so a new document with no row is a
  failing test. The epic now names the row. See `09-the-proposal-records-state-ownership.md`.
