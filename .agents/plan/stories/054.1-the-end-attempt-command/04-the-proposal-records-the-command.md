# Story 4 — The proposal records the command

Epic: `.agents/plan/epics/054.1-the-end-attempt-command.md`
Depends on: Story 1 (`01-a-semantic-ending-and-an-accepted-one`), Story 2
(`02-an-ambiguous-ending-increments-the-counter`) and Story 3
(`03-a-settlement-over-a-closed-attempt-writes-nothing`), for the three scenario files that must exist
before this story ships the epic; EPIC 054 Story 10, for
`docs/proposal/phase-2/attempts-and-classification.md`, which this story amends and does not create.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.
Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**It is last in dispatch order, and the `shippedEpics` append is why.** Appending `"054.1"` makes all
three diagrams of this epic due, and `scripts/verify-epic-sequence.ts:757` — `error` refuses a due
live diagram with no scenario file. Every scenario must already exist, so this story cannot run before
Stories 1 to 3.

## Change

**Amend `docs/proposal/phase-2/attempts-and-classification.md` — record the command, and record that
nothing calls it yet.** EPIC 054 Story 10 creates that document and states no wired path; this story
adds the command contract and keeps the same silence about callers.

### 1 — the command contract

Add one section stating, each as its own paragraph:

- **One command ends an attempt.** `endAttempt(dependencies, transaction, input)` reads the
  accounting, classifies, converts, closes, charges and appends, in the transaction it receives.
  **State that it is not yet the only closer**: five shipped `execution.closeAttempt` call sites remain
  until EPIC 054.4, which is the epic that wires them and asserts the closure.
- **It takes the caller's transaction and opens none.** Every caller is already inside one, and the
  expiry path runs inside `claimNode`'s transaction, so a command of its own would leave that path no
  legal caller. `src/commands/outcome/aggregate-initiative.ts:20` — `aggregateInitiative` is the
  shipped idiom.
- **The input is a two-member union keyed on the outcome, and neither member carries a class.** The
  non-accepted member carries `attemptId`, `runId`, `nodeId`, `attemptNo`, `at`, `attemptLimit`,
  `outcome` and `evidence`. The accepted member carries the same six common fields with
  `outcome: "accepted"` and `headOid`, and reaches no classifier. State that `at` and `attemptLimit`
  are the caller's. `attemptLimit` is the run row's value, which the caller already reads; `at` is the
  caller's instant for its whole transaction, and no run row carries it.
- **The command selects the classifier from the driver on the attempt row.** State that evidence whose
  kind the driver cannot produce is an invariant breach and throws, and that no such evidence reaches
  the row.
- **The settlement guard is the close.** The close carries `WHERE id = ? AND outcome IS NULL` and
  `RETURNING`, and a close over an already-closed attempt answers `null` inside the one statement that
  would have written. The zero-row result decides the no-op. State that no re-read stands in for it.
- **A no-op settlement is not a refusal.** The earlier termination stands, no second `attempt.ended` is
  appended, no ambiguous budget is charged, and the command reports the settlement as already settled.
  The caller's own refusal is unchanged.
- **The read order is fixed: the attempts, the counter, the close, the charge, the append.** State that
  the counter is read on every path because the payload carries it, and that the charge keys on the
  class before the conversion while the stored value is the class after it.
- **The payload is the close-time accounting snapshot.** State the four counters —
  `semanticCountAfter`, `attemptLimit`, `ambiguousUsedAfter`, `ambiguousBudget` — and why they are the
  only durable record of that moment: `node.ambiguous_used` resets on an assignment change, a
  converted ambiguous termination is stored `semantic`, and `attempt.termination` is null on every row
  migration `16` left unclassified.
- **The command writes and does not discard.** State that it holds no `Git` dependency and no
  `Candidate` dependency at all, that the candidate ref is attempt-scoped, and that every discard
  belongs to the caller after the transaction commits.

### 2 — no caller, stated

**State that no product path calls this command yet**, and name EPIC 054.2, EPIC 054.3 and EPIC 054.4
as the epics that wire the nine paths, the accepted arms included. **Name no path as wired.** The
epic's gate row 12 is asserted by a reviewer against this epic's story list, and this epic's story
list holds three command stories and this one.

**Do not restate the classification, the evidence table, the budget or the caller and subject
derivation.** EPIC 054 Story 10 wrote all four into this same document, and a second statement of them
would make a reader diff two sections to find the current one.

### 3 — the range entry

**Append `"054.1"` to the `shippedEpics` array of `scripts/epic-sequence-range.ts`.**

**Append `"054.1"` to the `shippedEpics` literal in `test/sequence/conformance.test.ts:274` —
`shippedEpics`**, and leave the `authoredEpics` literal at `test/sequence/conformance.test.ts:255` —
`authoredEpics` as Story 1 left it. The case at `:275` asserts `shippedEpics` stays a prefix of
`authoredEpics`, which holds because Story 1 placed `"054.1"` immediately after `"054"`.

## Constraints

- Every scenario file of this epic exists before this story runs. Appending `shippedEpics` makes all
  three diagrams due in the same commit.
- The document states no wired path. A stated caller would claim behaviour this epic does not ship.
- The document restates nothing EPIC 054 Story 10 already wrote.
- Do not renumber or rename any diagram id of this epic. EPIC 054.2, EPIC 054.3 and EPIC 054.4 each
  supersede a diagram by id.

## Verify

```
node --test src/commands/attempt/end-attempt.test.ts test/sequence/conformance.test.ts
```

Extend `src/commands/attempt/end-attempt.test.ts` for cases 1 and 2, using Story 1's fixture builder
and calling `test/helpers/sequence-conformance.ts:318` — `assertConformance` directly with this
epic's story paths.

Add, each as a separate case:

1. `"the accepted ending replays against end-attempt-semantic"` — build Story 1's accepted fixture
   behind `test/helpers/sequence-conformance.ts:99` — `recordSeams`, and call `assertConformance` with
   `story` of
   `.agents/plan/stories/054.1-the-end-attempt-command/01-a-semantic-ending-and-an-accepted-one.md`
   and `diagram` of `end-attempt-semantic`. Assert it does not throw. This is what proves the accepted
   arm and the semantic arm share one seam set, and it is why the accepted arm is a case and not a
   fourth diagram. This is the epic's gate row 11, second half.

2. `"the comparison fails when the counter increment is dropped from end-attempt-ambiguous"` — take
   the token list Story 2's scenario records, remove `plan.incrementNodeAmbiguousUsed` from it, and call
   `assertConformance` with that recorder, the same `dependencyKeys` and the same result. Assert it
   throws, and assert the message names `end-attempt-ambiguous`. The oracle of this epic's third
   diagram is an absent token, so this is the control that the comparison detects a nearby forbidden
   case rather than passing on any trace. This is the epic's gate row 11, first half.

3. `"shippedEpics holds 054.1 and stays a prefix of authoredEpics"` — extend the existing case at
   `test/sequence/conformance.test.ts:274` — `shippedEpics`. Assert `shippedEpics` includes `"054.1"`
   as its last member, and that `authoredEpics.slice(0, shippedEpics.length)` deep-equals
   `shippedEpics`.

4. `"every due scenario conforms"` — the existing case at
   `test/sequence/conformance.test.ts:278` — `it`. It needs no edit: appending `shippedEpics` makes
   `end-attempt-semantic`, `end-attempt-ambiguous` and `end-attempt-settled` due, and the runner
   replays all three by equality. Assert only that it passes with the three scenarios present. This
   is the epic's gate row 11, and the whole-epic replay it names.

5. `"the proposal names no product path as a caller"` — a build-only check. `pnpm run verify` exits
   `0`, and a reviewer reads
   `docs/proposal/phase-2/attempts-and-classification.md` against this epic's story list and confirms
   it names EPIC 054.2, EPIC 054.3 and EPIC 054.4 as the wiring epics and no path as wired. No gate
   checks it, and the epic's gate row 12 states so. This is the epic's gate row 12.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/attempt/end-attempt.test.ts` and
`test/sequence/conformance.test.ts` in `PASS EPIC-054.1`.
