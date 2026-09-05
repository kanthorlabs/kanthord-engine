# Story 9 — The checkpoint pair is derived

Epic: `.agents/plan/epics/054.3-the-report-members-pay-their-attempt.md`
Depends on: EPIC 051.3 Story 1 (`01-migration-14`), for the two nullable columns; EPIC 051.3 Story 2
(`02-the-checkpoint-row`), for `WriteCheckpointInput`, `checkpointRow` and the implementation that
writes both null today; EPIC 052 Story 5 (`05-the-seams-the-acceptance-needs`), for the discriminated
union those three members live in; EPIC 053.1 Story 7 (`07-the-attestation-with-a-reason`), for the
review member and its SQLite branch; EPIC 054 Story 5
(`05-the-open-records-caller-and-subject`), for the derivation this story mirrors.
Kind: story-foundation

This story fills the two audit columns EPIC 051.3 created nullable and named EPIC 054's family as the
filler of. It changes no drawn path, and case 5 is what proves that.

## Change

**`src/services/execution/index.ts` — add `caller` and `subject` to all three members of
`WriteCheckpointInput`.** The union is
`.agents/plan/stories/052-the-graph-patch-and-its-policies/05-the-seams-the-acceptance-needs.md:91`
— `WriteCheckpointInput`, over the execution member at `:67` —
`WriteExecutionCheckpointInput`, the structural member at `:80` —
`WriteStructuralCheckpointInput` and the review member of
`.agents/plan/stories/053.1-the-review-checkpoint/07-the-attestation-with-a-reason.md:156` —
`kind: "review"`. Each gains

```ts
caller: string;
subject: string;
```

**Both are `NOT NULL` on the input and both stay nullable on the column.** Migration `14` creates
`caller` at `.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:51` — `caller`
and `subject` at `:52` — `subject`, and
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:78` —
`caller` and `subject` are nullable states they stay nullable and that EPIC 057 tightens them. A row
written before this epic keeps both null, and nothing is backfilled — ever —
`.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:107` — `No row is backfilled`.

**`src/services/execution/sqlite.ts` — bind both columns in all three branches of `writeCheckpoint`.**
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/02-the-checkpoint-row.md:129` —
`The input carries no` is the sentence that stops being true: the implementation binds
`input.caller` and `input.subject` where it bound `NULL`. `CheckpointRecord` already declares
`caller: string | null` at `:114` — `caller` and `subject: string | null` at `:115` — `subject`, so
it does not widen.

**`src/domain/checkpoint.ts` — `checkpointRow` is unchanged.**
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/02-the-checkpoint-row.md:27` — `caller` and
`:28` — `subject` are `z.string().nullable()` and stay so, because a legacy row must still parse.
Case 4 is that control.

### 1 — the accepted land

**`src/commands/checkpoint/land-execution.ts` — pass both at the checkpoint write.**
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:190` —
`writeCheckpoint` is the call, and `:190` — `caller` is the sentence that says both are not passed.
Pass `caller: input.actorId` and `subject: input.subject`.

**`LandSettleInput` gains `subject: string`.** The type is
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:133` —
`LandSettleInput`, and it carries `actorId` at `:145` — `actorId` and no worker. **It is a new input
field and never a new read**, so no drawn path moves: `landSettle` holds an `execution` key but
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/04-the-accepted-settle.md:166` —
`The unit derives the objective` establishes that this unit takes its bindings on the input, and a
run read here would add a token to `land-settle-aggregate-paid`.

**`AcceptExecutionInput` gains `subject: string` and passes it through.** `acceptExecution` holds no
`execution` key —
`.agents/plan/stories/051.4-the-acceptance-gate-and-the-report-route/01-the-gate-refuses-an-unreachable-candidate.md:75`
— `There is no` — so it cannot read the run either; it receives the value and hands it to
`land.settle`.

**`reportOutcome` supplies the value from the run row it already read.** `run.worker` is a column of
`src/services/execution/index.ts:14` — `worker`, and the run is read at step 5 of
`report-checkpoint-gate`. **No new read, so no new token**, and
`report-checkpoint-gate`, `report-checkpoint-reap` and `report-execution-checkpoint` keep their
traces.

### 2 — the structural acceptance

**`src/commands/checkpoint/accept-structural.ts` — pass both at the checkpoint write.**
`.agents/plan/stories/052.1-the-structural-acceptance/09-the-accepted-patch.md:191` —
`writeCheckpoint` is the call. Pass `caller: input.actorId` and `subject: input.run.worker`.
**`AcceptStructuralInput` gains no field**: `actorId` is a member at
`.agents/plan/stories/052.1-the-structural-acceptance/02-an-unparsable-patch-reaches-no-seam.md:77`
— `actorId` and `run` at `:73` — `run`, and `RunRecord` carries `worker`.

### 3 — the review attestation

**`src/commands/checkpoint/accept-review.ts` — pass both at the checkpoint write.**
`.agents/plan/stories/053.1-the-review-checkpoint/07-the-attestation-with-a-reason.md:113` —
`writeCheckpoint` is the call. Pass `caller: input.actorId` and `subject: input.subject`.

**`AcceptReviewInput` gains `subject: string`.** The type is
`.agents/plan/stories/053.1-the-review-checkpoint/03-an-oversized-reason-reaches-no-seam.md:64` —
`AcceptReviewInput`, and it carries `actorId` at `:70` — `actorId` and no run row. **A new input
field and never a new read**: the value is `run.worker`, supplied by `reportOutcome` from the run it
already read at step 5 of `report-review-gate`, so that diagram keeps its nine tokens.

### 4 — what `caller` is, and what it is not

`caller` is the authenticated principal the middleware resolved — today the actor id, from EPIC 055
the grant id, from EPIC 110 the supervisor id —
`.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:105` —
`caller` and `subject` are derived. `subject` is `run.worker`, read from the run row. **The two are
different values and the test asserts the derivation site, not an inequality**: a self-hosted worker
makes them equal, and an assertion that they differ would fail on a legal fixture.

## Constraints

- All three members of `WriteCheckpointInput` gain both fields. A member that keeps writing `NULL` is
  a defect.
- The columns stay nullable. Do not add a `NOT NULL`, and do not change `checkpointRow`. EPIC 057
  owns the tightening.
- Backfill nothing. A pre-epic row keeps both null.
- `subject` reaches `landSettle`, `acceptExecution` and `acceptReview` as an input field. Do not add a
  run read to any of the three.
- `caller` is `input.actorId` at all three writers. Do not synthesise a placeholder, and do not assert
  that `caller` and `subject` differ.
- `CheckpointRecord` does not widen. It already declares both as nullable strings.
- Add no diagram, no `Diagrams:` line, no `Baselines:` line and no `Seams:` line. This story draws
  nothing.

## Verify

```
node --test src/services/execution/sqlite.test.ts src/commands/checkpoint/land-execution.test.ts src/commands/checkpoint/accept-structural.test.ts src/commands/checkpoint/accept-review.test.ts test/sequence/conformance.test.ts
```

Extend `src/services/execution/sqlite.test.ts` and the three command test files.

Add, each as a separate `it`:

1. `"an accepted land writes the checkpoint caller and subject"` — run the real `landSettle` on the
   accepted arm with `actorId` the literal `"actor_alpha"` and the run's `worker` the literal
   `"worker_beta"`, then read the `checkpoint` row and assert `caller === "actor_alpha"` and
   `subject === "worker_beta"` by value. This is the first third of the epic's gate row 11.

2. `"a structural acceptance writes the checkpoint caller and subject"` — the same two assertions
   over the real `acceptStructural`, with `subject` read from `input.run.worker` and not from an
   input field. This is the second third of the epic's gate row 11, and it is the one writer that
   gains no input field.

3. `"a review attestation writes the checkpoint caller and subject"` — the same two assertions over
   the real `acceptReview`. This is the last third of the epic's gate row 11.

4. `"a checkpoint row written with both columns null still parses"` — insert a `checkpoint` row
   directly with `caller` and `subject` as `NULL`, parse it through
   `.agents/plan/stories/051.3-the-checkpoint-and-the-land/02-the-checkpoint-row.md:19` —
   `checkpointRow`, and assert the parse succeeds with both fields `null`. **This is the legacy
   control for cases 1 to 3**: without it the three assertions pass for a schema that made both
   required, which would make every pre-epic row unreadable. This is the epic's gate row 11 control.

5. `"no diagram moves when writeCheckpoint gains two input fields"` — run
   `test/sequence/conformance.test.ts:278` — `every due scenario conforms` and assert every live
   diagram that reaches `execution.writeCheckpoint` replays by equality. **The diagrams to replay are
   `accept-structural-success-paid`, `accept-review-success-with-reason-paid`,
   `accept-review-success-no-reason-paid` and EPIC 054.2 `land-settle-aggregate-paid`** — the first
   three because Stories 6 to 8 of this epic already superseded the ids the epic's gate row 12 names,
   and `land-settle-aggregate-paid` because EPIC 053 and then EPIC 054.2 superseded EPIC 051.3's
   `land-settle-accepted`. **The control is the mutation that inserts a token into each**, four
   mutations, which must fail; without it the assertion passes for a runner that replays nothing.
   This is the epic's gate row 12.

6. `"every branch of writeCheckpoint binds both columns"` — in
   `src/services/execution/sqlite.test.ts`, write one checkpoint of each `kind` — `execution`,
   `structural` and `review` — and assert all three rows carry the passed `caller` and `subject`.
   **Iterating the three kinds is what proves it is three branches and not two**: a branch left
   binding `NULL` would answer `null` on one kind alone.

7. `"a self-hosted worker writes an equal caller and subject"` — write one checkpoint with `actorId`
   and `worker` the same literal and assert both columns hold it. This is the control for the
   derivation rule of change step 4: the test asserts the site and never an inequality, and without
   this case a later reviewer may add an inequality assertion that fails on a legal fixture.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts`,
`src/commands/checkpoint/land-execution.test.ts`,
`src/commands/checkpoint/accept-structural.test.ts` and
`src/commands/checkpoint/accept-review.test.ts` in `PASS EPIC-054.3`.
