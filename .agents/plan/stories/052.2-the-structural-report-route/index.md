# EPIC 052.2 — The structural report route — stories

Epic: `.agents/plan/epics/052.2-the-structural-report-route.md`
Prereq: EPIC 052.1 (sequence order). Story 1 declares the details schema of every refusal that epic's
command raises, and Story 2 injects that command and maps each refusal to its code. EPIC 051.4
supplies the `report-checkpoint-gate` prelude and the `accept` dependency key, and EPIC 050.2 the run
authority.

A structural run delivers its patch over `node.report`: a seventh request member, one nested callable
after the authority prelude, and a mapping from each refusal to its own contract error.

## One story, one path

One story carries a diagram, and one carries none.

- Story 2 draws `report-structural-gate`, the structural member of `node.report`.
- Story 1 is `story-foundation`: the wire contract and its registers. It changes no drawn path, so it
  draws nothing.

**The prior set is empty, so this epic draws no `baseline-` diagram and every token of its diagram is
`+`.** The structural member is a seventh member of `node.report` and therefore a wholly new path:
`.agents/plan/epics/052.2-the-structural-report-route.md:22` — `report-checkpoint-gate` rules it, and
`.agents/plan/epics/053.1-the-review-checkpoint.md:46` — `report-checkpoint-gate` cites that ruling.
Story 2 changes an existing command and declares no baseline for that reason, which is the one case
`.agents/plan/authoring.md` leaves to a reviewer.

| story | diagram                  | steps | terminal |
| ----- | ------------------------ | ----- | -------- |
| 2     | `report-structural-gate` | 8     | `ok`     |

**`accept.structural` is one step.** The scenario binds `accept` to unrecorded dependencies, so the
fourteen seam calls inside `acceptStructural` are invisible at this seam. EPIC 052.1 carries them, in
its eight diagrams.

**Every refusal of `acceptStructural` stops inside step 8, so none of them is drawn here.** EPIC
052.1 Stories 2 to 8 draw the seven refusal paths. What this epic proves about them is the mapping to
a contract error, which a diagram cannot prove: `.agents/plan/authoring.md:243` states a diagram
proves no refusal code.

## Dispatch order

`1 → 2`

- Story 1 is first because Story 2 names the seventh `nodeReportRequest` member and the ten error
  codes it registers.
- Story 2 is last because its `shippedEpics` entry makes this epic's one diagram due, so it lands only
  when `test/sequence/scenarios/report-structural-gate.ts` exists.

No story depends on a later one.

## Stories

- 1 — the seventh member, the eight codes, the six details schemas and the registers →
  `01-the-contract-carries-the-patch.md` — draws nothing
- 2 — the nested callable, the mapping, the `initiative-not-reportable` lift and the range entries →
  `02-the-report-route-carries-a-patch.md` — draws `report-structural-gate`

No story is a groundwork story. Every path this epic edits is allowed to an engineer by
`scripts/lane-check.sh`, `src/http/`, `src/cli/`, `src/commands/outcome/`, `docs/proposal/api/` and
`scripts/epic-sequence-range.ts` included, so the epic holds no `00-groundwork.md` and no `Paths:`
line.

## Facts (needed for implementation)

- **The two proposal documents are split between the two epics.**
  `docs/proposal/phase-2/checkpoints.md` carries behaviour and belongs to EPIC 052.1 Story 10
  (`10-the-proposal-records-the-structural-acceptance`). `docs/proposal/api/README.md` carries the
  error-code matrix, which `test/helpers/proposal.ts:89` — `readErrorCodeMatrix` reads as a contract
  register, and it belongs to Story 1 (`01-the-contract-carries-the-patch`). Editing the wrong one is
  the split's most likely mistake.

- **An undeclared contract error is caught by one mechanism, and it is not the coverage test.**
  `src/http/server/node/report-node.test.ts:24` — `reportErrorEnvelope` builds the envelope from
  `operation.errors`, and `:324` parses a real refusal response against it. Story 2
  (`02-the-report-route-carries-a-patch`) case 6 parses all eleven.
  `src/http/contract/coverage.test.ts:536` — `errorStatuses` checks only the reverse direction, that a
  declared code is a known code, so it catches nothing here.

- **The refusal mapping lives in `src/http/server/node/refusals.ts`, not in
  `src/http/server/node/report-node.ts`.** `src/http/server/node/refusals.ts:67` —
  `reportOutcomeRefusal` is where every refusal switch already is, and
  `src/http/server/node/report-node.ts:41` — `toHttpError` is the handler's one call into it. See
  `02-the-report-route-carries-a-patch.md`.

- **`z.unknown()` is optional inside a `strictObject`.** The seventh member's `patch` therefore
  carries `.refine((value) => value !== undefined)`, which keeps the field required and still emits a
  flat `{}` schema with no `$ref`. The opaque shape is forced by EPIC 052.1's refusal order: a
  `graphPatch` on the contract would reject a malformed patch with `invalid-request` before the
  authority prelude ran. Story 2 (`02-the-report-route-carries-a-patch`) case 2 is that proof.

- **`stale-revision` and `plan-invalid` join the operation's `errors` record and neither code
  register.** Both already exist at `src/http/contract/errors.ts:14` and `:30` and at
  `src/cli/exit-code.ts:20` and `:30`. The record entry is still required, because the record is what
  builds the envelope the parse above reads.

- **This epic registers itself in both range lists, in one story.** EPIC 052.1 Story 9
  (`09-the-accepted-patch`) puts `"052.1"` into `shippedEpics`, and
  `test/sequence/conformance.test.ts:275` — `slice` asserts the shipped list is a prefix of the
  authored one, so `"052.2"` enters `authoredEpics` and `shippedEpics` together in Story 2
  (`02-the-report-route-carries-a-patch`). This epic has one diagram and one scenario, so the two
  entries never sit in different stories the way EPIC 052.1's do.
