# EPIC 051.6 — The post-expiry reap on the run operations — stories

Epic: `.agents/plan/epics/051.6-the-post-expiry-reap-on-the-run-operations.md`
Prereq: EPIC 051.5 (sequence order). Story 1 reads `ExpiredRun` in `src/domain/run.ts` from its
Story 1, the `reapRunCandidates` command and its `candidate.reap` callable from its Story 3, and the
per-diagram supersession from its Story 10 (`10-the-conformance-harness-admits-an-incremental-supersession`).
Stories 2 and 3 read the same three. Story 3 also reads EPIC 051.4 Story 8
(`08-the-report-route-enforces-the-gate`) for `accept.execution`, `AcceptExecutionError` and the
discriminated transaction value.

A candidate ref of a run that `renew`, `release` or `report` expires is deleted by that same
operation, once, after its last transaction commits and its git write completes.

## One story, one path

Three stories, and each carries one diagram. Every one supersedes a diagram an earlier epic drew, so
no story draws a `baseline-` diagram.

| story | diagram                  | supersedes                          |
| ----- | ------------------------ | ----------------------------------- |
| 1     | `renew-reap`             | EPIC 050.4 `renew-lease-free`       |
| 2     | `release-reap`           | EPIC 050.4 `release-lease-free`     |
| 3     | `report-checkpoint-reap` | EPIC 051.4 `report-checkpoint-gate` |

Each declares `Seams: <id>: +candidate.reap` and nothing else. The token is the whole change of the
trace: the expired-run list `expiry.expireRuns` already returns is bound rather than discarded, which
moves no call, no argument and no order.

This epic holds no story `00`. Every path its stories edit is allowed to one TDD engineer, checked
with `scripts/lane-check.sh` against both roles, so no locked path exists and no groundwork story is
manufactured.

## Dispatch order

**1, 2, 3.** The order is forced at the tail, and no story depends on a later one.

- **Story 3 last.** It appends `"051.6"` to `scripts/epic-sequence-range.ts:17` — `shippedEpics`, and
  `test/sequence/conformance.test.ts:254` — `shippedEpics` requires `shippedEpics` to stay a prefix of
  `authoredEpics`. It is also the story with the largest case set, so it reads the two commands the
  others write.
- **Story 2 before Story 3, and after Story 1.** It owns the empty-list proof for `renewRun` as well
  as for `releaseNode`, so it reads Story 1's command.
- **Story 1 first, by the seam it establishes and not by a range edit.** `"051.6"` is already in
  `scripts/epic-sequence-range.ts:1` — `authoredEpics`, applied ahead of implementation and pinned by
  `test/sequence/conformance.test.ts:255` — `assert.deepEqual(authoredEpics`, so no story of this epic
  inserts it. Story 1 is first because it is the smallest of the three and establishes the
  `candidate` key and the `Expiry` tightening that Stories 2 and 3 repeat.

**Each story is green on its own boundary.** EPIC 051.5 Story 10 keys supersession on the superseding
scenario file, so a story that adds its own scenario and deletes its predecessor's in one turn leaves
every other diagram of the range untouched: while `renew-reap.ts` exists, `renew-lease-free` is
superseded and needs no scenario, and `release-lease-free` is still due and keeps its own.

**Two stories reach a third story's test file.** Story 2 case 5 and Story 3 case 6 each add a case to
`src/commands/run/renew-run.test.ts`, and Story 3 case 6 also adds one to
`src/commands/node/release-node.test.ts`. Both are the epic's own gate assignments — rows 10, 15 and
16 name one proof owner each — and a test file is one lane, so no dispatch conflict follows.

## Stories

- 1 — the renew reaps, tightens its own `Expiry`, becomes `async`, and opens the range → `01-the-renew-reaps.md` — draws `renew-reap`
- 2 — the release reaps on all three arms, and the runs it ends itself stay → `02-the-release-reaps.md` — draws `release-reap`
- 3 — the report reaps on every settled terminal that commits its prelude, and closes the range → `03-the-report-reaps-on-every-settled-terminal.md` — draws `report-checkpoint-reap`

## Gate rows, by owner

Every row of the epic's hermetic-coverage list is delivered by a numbered case, and no case exists
that no row and no `## Change` obligation needs.

| story | numbered case | gate row        | `it` count |
| ----- | ------------- | --------------- | ---------- |
| 1     | 1 to 5        | 1 to 5          | one each   |
| 2     | 1 to 4        | 6 to 9          | one each   |
| 2     | 5             | 10              | two        |
| 3     | 1             | 11              | one        |
| 3     | 2             | 12              | two        |
| 3     | 3             | 13              | one        |
| 3     | 4             | 14              | two        |
| 3     | 5             | 15, first half  | two        |
| 3     | 6             | 15, second half | two        |
| 3     | 7             | 17              | two        |
| 3     | 8             | 16              | one        |
| 3     | 9             | 18              | one        |
| 3     | 10            | 19              | one        |
| 3     | 11            | none            | one        |

**A numbered case is one `/work` turn, and it is not always one `it`.** Six of the twenty-one cases
hold two `it`s, because the gate row they deliver names a control or a per-command pair. Row 15 is the
one row that spans two numbered cases, because its four sub-cases reach three test files: cases 5 and
6 split it at that boundary. Every other row maps to exactly one numbered case, and every row has
exactly one proof owner, which is the epic's own `story` column.

**One case exists beyond the gate: Story 3 case 11.** EPIC 051.5 Story 10 keys dueness on the scenario
file, so the `shippedEpics` append changes nothing observable about this epic's three diagrams, and
without that case the edit is proven by nothing. Story 1 carries no range case, because `"051.6"` is
already in `authoredEpics` and already pinned by
`test/sequence/conformance.test.ts:255` — `assert.deepEqual(authoredEpics`.

## Facts (needed for implementation)

- `expireRuns` returns `readonly ExpiredRun[]` of `{ runId, nodeId, fence }` at
  `src/commands/run/expire-runs.ts:6` — `ExpiredRun`, and it appends one `run.expired` event per row
  inside the caller's transaction at `src/commands/run/expire-runs.ts:33` — `append`. The reap adds no
  event.
- Every shipped caller discards that list. `src/commands/node/claim-node.ts:147` — `expireRuns` is the
  one call site today, and its value is unbound.
- `Expiry` is declared per command, not shared. `src/commands/node/claim-node.ts:75` — `Expiry`
  returns `src/commands/node/claim-node.ts:79` — `readonly unknown[]`, and each of the three commands
  copies it from EPIC 050.2 and tightens its own copy here.
- `src/main.ts:388` — `expiry` is the one closure over the real `expireRuns`, and
  `src/main.ts:84` — `Expiry` imports the claim's type into the root. One object still reaches all
  four commands.
- `renewRun` and `releaseNode` are synchronous today, at
  `src/commands/node/heartbeat-node.ts:63` — `HeartbeatNodeResult` and
  `src/commands/node/release-node.ts:61` — `ReleaseNodeResult`. Both become `Promise<…>`.
  `reportOutcome` is already a promise after EPIC 051.4 Story 8.
- Both handlers are already `async` and neither awaits its command:
  `src/http/server/node/heartbeat-node.ts:29` — `heartbeatNode` and
  `src/http/server/node/release-node.ts:29` — `releaseNode`. Each gains one `await`, inside the `try`
  it already has.
- `src/main.ts:603` — `releaseNode` calls `src/main.ts:608` — `showNode` over the command's result, so
  that closure gains `async` and an `await`. The renew closure at
  `src/main.ts:589` — `heartbeatNode` returns the promise unchanged and needs neither.
- The recorder holds no `candidate.reap` projection.
  `test/helpers/sequence-conformance.ts:50` — `projections` is the table and
  `test/helpers/sequence-conformance.ts:126` — `projection === undefined` yields an empty label list,
  so the token is the bare `candidate.reap` and one call per diagram is the limit.
- A call that throws is still recorded.
  `test/helpers/sequence-conformance.ts:132` — `tokens.push` pushes the token before
  `test/helpers/sequence-conformance.ts:136` — `Reflect.apply`. That is why the refusing arm of
  `report` needs no diagram.
- `test/sequence/scenarios/claim-success-task.ts` is the scenario shape: real
  `test/helpers/database.ts:32` — `createMigratedStorage`, one
  `test/helpers/sequence-conformance.ts:99` — `recordSeams` call over the whole dependency bag, nested
  commands closed over **unwrapped** dependencies, and `{ recorder, result }` returned inside a
  `try`/`finally` that disposes the fixture.
- A story that owns a due diagram must hold the literal string `test/sequence/scenarios/<id>.ts`.
  `scripts/verify-epic-sequence.ts:736` — `owner.source.includes` checks the story text itself.
- The type-level convention is a `// @ts-expect-error` comment the type checker enforces, at
  `src/services/plan/sqlite.test.ts:97` — `ts-expect-error`. No assertion helper exists.
- `test/helpers/database.ts:117` — `databaseBytes` is the byte oracle every "wrote nothing" case uses.

## Decisions taken during authoring, and now recorded in the EPIC

- **Stories 1 and 2 draw the prelude order EPIC 050.2 ruled, which a human-owned EPIC 050.4 amendment
  restores.** `renew-lease-free` and `release-lease-free` place `plan.readNode` at step 6, after
  `execution.runById` and `plan.readSubtree`. EPIC 050.2 orders the callback with `plan.readNode`
  third, at
  `.agents/plan/stories/050.2-the-run-renew-release-and-report/03-the-renew.md:206` — `expireRuns`
  and
  `.agents/plan/stories/050.2-the-run-renew-release-and-report/05-the-release.md:168` — `expireRuns`,
  and rules it at
  `.agents/plan/stories/050.2-the-run-renew-release-and-report/05-the-release.md:141` —
  `Step 4 precedes step 5, and that order is the ruling`. EPIC 050.4 Stories 4 and 5 hold deletions
  only and claim only removals at
  `.agents/plan/stories/050.4-the-node-lease-removal/04-the-renew-drops-the-lease.md:47` —
  `Three steps leave the superseded diagram`, so the step-6 placement is a transcription defect.

- **The reason is continuity and the change boundary, and not a broken refusal code.** The step-6
  order does **not** make `node-not-found` and `initiative-not-claimable` unreachable:
  `assertRunAuthority` is pure and draws no step, so a command may read the node third and still throw
  both refusals before the authority check. **The step-6 order can therefore go green**, which is what
  makes the defect dangerous rather than self-correcting — an implementing agent following
  `.agents/plan/authoring.md:346` — `authoritative over the prose of that` would reorder three reads,
  pass every case, and ship an unplanned change. The order is decided by EPIC 050.2 having ruled it,
  by its diagram, `## Change`, constraints and cases all agreeing, and by EPIC 050.4 offering no
  reason to reorder.

- **The repair is applied: one EPIC 050.4 amendment in five parts.** It records that Stories 4 and 5
  delete lease seams and do not reorder the prelude; corrects both diagrams to `4 plan.readNode`,
  `5 execution.runById:R`, `6 plan.readSubtree`; corrects the "step 6" prose of both; leaves both
  `Seams:` lines unchanged; and leaves EPIC 050.2 untouched, because that epic is already internally
  consistent. It landed at
  `.agents/plan/stories/050.4-the-node-lease-removal/04-the-renew-drops-the-lease.md:51` — `Amended`
  and
  `.agents/plan/stories/050.4-the-node-lease-removal/05-the-release-drops-the-lease.md:63` — `Amended`.
  It had to land on the base branch before any EPIC 050.4 worktree is cut, because a worktree does not
  acquire later edits to its base; a worktree cut before it must be synchronised. EPIC 050.2 needs no
  change and its implementation proceeds from its existing order. `scripts/lane-check.sh` denies
  `.agents/plan/**` to every implementation role, so the plan owner applied it outside the
  implementation lane.

- **The third option was considered and rejected: keep EPIC 050.4's order.** Reordering the three
  reads and keeping the node refusals ahead of `assertRunAuthority` is technically viable and would go
  green. It is rejected because EPIC 050.4 claims to delete lease calls and reorder nothing, so
  adopting its transcription slip as the design would ship source churn no epic asked for, and would
  contradict EPIC 050.2's explicit ruling.

- **`report-checkpoint-reap` is unaffected by that correction.** EPIC 051.4 Story 8 and EPIC 050.4
  Story 6 both draw `4 plan.readNode`, `5 execution.runById:R`, `6 plan.readSubtree`, which is the
  ruled order. Story 3 reproduces steps 1 to 9 token for token. See
  `03-the-report-reaps-on-every-settled-terminal.md`.

- **Story 2's release handler callable resolves `Promise<unknown>` and not `Promise<ReleaseNodeResult>`.**
  `src/main.ts:608` — `showNode` replaces `result.node` with a node view before the handler sees the
  value, so the closure's resolved type is not the command's result type. The shipped declaration at
  `src/http/server/node/release-node.ts:9` — `releaseNode` is already `unknown` for that reason, and
  wrapping it in `Promise` is the whole edit. Story 1's renew handler has no such wrapper, so it takes
  `Promise<RenewRunResult>`. See `02-the-release-reaps.md`.

- **Story 3's typed `catch` constructs the `ReportOutcomeError`, and the epic's illustrative snippet
  is wrong.** That snippet stores `error: AcceptExecutionError` and ends with `throw settled.error`,
  which raises an `AcceptExecutionError` out of `reportOutcome` and loses the translation EPIC 051.4
  Story 8 owns at
  `.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/08-the-report-route-enforces-the-gate.md:200`
  — `Add the six refusal codes to`. `src/http/server/node/refusals.ts:67` — `reportOutcomeRefusal`
  maps a `ReportOutcomeError` and never an `AcceptExecutionError`, so the untranslated throw reaches
  the handler as an unmapped fault, and the epic's own gate row 12 could pass on `refusal` and
  `details` alone while the class is wrong. The `catch` therefore builds the `ReportOutcomeError`
  carrying both values unchanged, and Story 3 case 2 pins the runtime class. **This is a blocker
  against the epic's `## Decisions` snippet**, which a human corrects. See
  `03-the-report-reaps-on-every-settled-terminal.md`.

- **The expired run of every fixture is `running` and past due at the call, never already `ended`.**
  A run already `ended` is not a run the pass ends, so an already-ended fixture makes every positive
  case vacuous. All three diagram fixtures and every case that reuses them state `expires_at` behind
  `now` on a `running` run. See all three stories.

- **The undrawn refusing arm of `report` costs one assertion, and Story 3 case 2 pays it.** The two
  arms share a token list but not a terminal, so `report-checkpoint-reap` — which states terminal
  `ok` — is not the refusing arm's oracle, and an extra seam call on that arm alone would reach none.
  The case therefore compares the two arms' full recorded token lists for equality, which is the
  instrument
  `.agents/plan/epics/051.5-the-targeted-post-expiry-candidate-cleanup.md:138` —
  `same nineteen recorded steps` uses for the same reason on the claim's contended cut. The epic's
  `## Decisions` settled that no second diagram is drawn, and the one-pair rule of
  `.agents/plan/authoring.md:128` — `It draws exactly one pair` forbids Story 3 owning two live
  diagrams, so the assertion is the resolution rather than a diagram. See
  `03-the-report-reaps-on-every-settled-terminal.md`.

- **Two negative controls are hermetic by construction, and neither touches the checked-out tree.**
  Gate row 18's mutation filters `candidate.reap` out of the **recorded token list** and re-runs
  `assertConformance`, because `test/sequence/scenarios/claim-success-task.ts` builds its own
  dependency bag and takes no override, and designing one is outside this epic. Gate row 19's control
  copies the plan tree and the scenario directory into an `mkdtemp` root, restores one scenario
  **inside the copy**, and runs `verifyEpicSequence` over that root. Restoring a real file under
  `test/sequence/scenarios/` would leave the repository dirty on a failure and race a parallel test.
  See `03-the-report-reaps-on-every-settled-terminal.md`.

- **One case exists beyond the gate's nineteen rows, and this epic makes one range edit and not two.**
  `authoredEpics` already holds `"051.6"`, applied ahead of implementation across the whole authored
  range and pinned by `test/sequence/conformance.test.ts:255` — `assert.deepEqual(authoredEpics`, so
  no story inserts it and Story 1 carries no range case. Story 3 still appends `"051.6"` to
  `shippedEpics`, and its case 11 is the only proof of that edit: EPIC 051.5 Story 10 keys dueness on
  the scenario file, so the append changes nothing observable about this epic's three diagrams. See
  `03-the-report-reaps-on-every-settled-terminal.md`.
