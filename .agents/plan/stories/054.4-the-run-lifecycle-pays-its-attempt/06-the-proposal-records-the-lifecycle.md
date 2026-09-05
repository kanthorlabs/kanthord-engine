# Story 6 — The proposal records the lifecycle

Epic: `.agents/plan/epics/054.4-the-run-lifecycle-pays-its-attempt.md`
Depends on: Stories 1 to 5, for every row of the table it writes; EPIC 054 Story 10, for `docs/proposal/phase-2/attempts-and-classification.md`, which this story amends and does not create; EPIC 054.1 Story 4 (`04-the-proposal-records-the-command`), EPIC 054.2 Story 8 (`08-the-ceiling-the-order-and-the-proposal`) and EPIC 054.3 Story 7, for the three earlier amendments to that document.
Kind: story-foundation

This story draws nothing and writes no production logic. It is **last in dispatch order**, because it appends `"054.4"` to `shippedEpics` and `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` requires `shippedEpics` to stay a prefix of `authoredEpics`.

## Change

**Edit `docs/proposal/phase-2/attempts-and-classification.md` — add the closure of the attempt lifecycle.** EPIC 054 Story 10 creates the document with the three classes, the evidence union, the two classifiers, the trust boundary, the node-scoped budget and the caller and subject derivation. EPIC 054.1, EPIC 054.2 and EPIC 054.3 amend it with the command contract and the arms they wire. This story adds the four sections below and changes nothing those four wrote.

### 1 — the closure table

One row per site that ends an attempt after this epic. Each row states the stored `attempt.outcome`, the evidence kind, the class the classifier yields, and which epic owns the candidate discard of that path. **The stored outcome names the site and never the class**: `cancelled` carries three different kinds across this epic, and the table is what tells them apart.

| site                                                       | `attempt.outcome` | evidence kind             | class                                     | discard owner                             |
| ---------------------------------------------------------- | ----------------- | ------------------------- | ----------------------------------------- | ----------------------------------------- |
| `src/commands/run/expire-runs.ts`                          | `cancelled`       | `run-expired`             | `ambiguous`, `semantic` at a spent budget | EPIC 051.5, out of the claim after commit |
| `src/commands/node/release-node.ts`, task arm              | `cancelled`       | `worker-released`         | `infrastructure`                          | none; `candidate.sweep` at startup        |
| `src/commands/node/release-node.ts`, objective cascade     | `cancelled`       | `ancestor-ended`          | `infrastructure`                          | none; `candidate.sweep` at startup        |
| `recover-expired-runs.ts`, `sweepExpiredExternalRuns`      | `cancelled`       | `run-expired`             | `ambiguous`, `semantic` at a spent budget | none; `candidate.sweep` at startup        |
| `recover-expired-runs.ts`, cascade under a swept objective | `cancelled`       | `ancestor-ended`          | `infrastructure`                          | none; `candidate.sweep` at startup        |
| `recover-expired-runs.ts`, `writeRecoveryVerdict`          | `cancelled`       | `run-expired`             | `ambiguous`, `semantic` at a spent budget | none; `candidate.sweep` at startup        |
| the execution report's five gate refusals                  | `rejected`        | `daemon-rejected`         | `semantic`                                | EPIC 054.2, per arm                       |
| the contended land                                         | `cancelled`       | `contended`               | `infrastructure`                          | EPIC 054.2                                |
| the worker's own failure report                            | `failed`          | `worker-reported-failure` | `semantic`                                | EPIC 054.3                                |
| the structural rejection                                   | `rejected`        | `daemon-rejected`         | `semantic`                                | EPIC 054.3                                |
| the review rejection                                       | `rejected`        | `daemon-rejected`         | `semantic`                                | EPIC 054.3                                |
| the accepted land, the accepted patch, the accepted review | `accepted`        | none                      | null termination                          | EPIC 054.2 and EPIC 054.3, per arm        |

**Every class column value has a stored-value proof, and the table names it.** `ambiguous` and the `semantic` conversion of the expiry row are Story 1 cases 1 and 2; of the sweep row, Story 3 cases 1 and 6; of the verdict row, Story 4 cases 1 and 2. `infrastructure` on the release rows is Story 2 cases 1, 3 and 4, and on the sweep cascade Story 3 case 2. The rows below the six are proven by EPIC 054.2 and EPIC 054.3. **Write no class this list cannot name a case for**, which is what the epic's gate row 15 checks in both directions.

### 2 — the one-writer closure

State that `src/commands/attempt/end-attempt.ts` is the **only** production caller of `execution.closeAttempt` after this epic, that `src/services/execution/sqlite.ts:294` — `UPDATE attempt SET outcome` is the only writer of `attempt.outcome`, and that every close of every attempt therefore appends exactly one `attempt.ended`. Name the assertion that holds it: the caller iteration of Story 5 (`05-the-closure-is-asserted`) case 1.

### 3 — the discard ownership per path

State the rule the epic's Non-goals fix: a run an operation itself ends is in no expiry list, is reaped by no operation, and leaves its candidate ref until startup. Name the one exception — the expiry list the claim carries out, whose refs EPIC 051.5 discards — and state that the release, the external sweep, the two cascades and the startup verdict all fall on the startup side.

### 4 — the two future callers

State that EPIC 056's worker switch and EPIC 110's human cancellation each end an attempt through `end-attempt` and never through the seam, so the count of one survives both, and that each appends its own `attempt.ended`. State that a caller a later epic adds at the seam fails Story 5 case 1 rather than shipping with no class and no event.

### 5 — the shipped range

**Edit `scripts/epic-sequence-range.ts`** — append `"054.4"` to `scripts/epic-sequence-range.ts:20` — `shippedEpics`. **Verify that `"054.3"` is the last entry before appending**, because `test/sequence/conformance.test.ts:275` — `authoredEpics.slice` requires the prefix to hold. **Edit `test/sequence/conformance.test.ts`** — add it to the pinned literal at `test/sequence/conformance.test.ts:274` — `assert.deepEqual(shippedEpics`.

**Delete no scenario file here.** Stories 1 to 4 each deleted their predecessor's in their own turn, because `"054.4"` entered `authoredEpics` in Story 1 and EPIC 051.5 Story 10's rule retires a diagram on the superseding scenario's existence. Case 3 asserts the four are gone.

## Constraints

- Write no production logic and add no test helper. This story edits three files and no others: `docs/proposal/phase-2/attempts-and-classification.md`, `scripts/epic-sequence-range.ts` and the pinned literal in `test/sequence/conformance.test.ts`.
- Do not restate what EPIC 054 Story 10, EPIC 054.1 Story 4 (`04-the-proposal-records-the-command`), EPIC 054.2 Story 8 (`08-the-ceiling-the-order-and-the-proposal`) and EPIC 054.3 Story 7 wrote into the same document. Add the four sections and leave the rest byte-identical.
- The class column of the closure table matches the value the case that proves each row stores. Do not write a class the tests do not assert.
- Append `"054.4"` to `shippedEpics` and to the pinned literal in the same turn. A range file and a pinned literal that disagree fail `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics`.
- Do not insert into `authoredEpics`. Story 1 did that.
- Delete no scenario file and add none.

## Verify

```
node --test test/sequence/conformance.test.ts scripts/verify-epic-sequence.test.ts
```

Add, each as a separate case:

1. `"shippedEpics holds 054.4 as its last entry and stays a prefix of authoredEpics"` — the shipped case at `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics`, run with both pinned literals updated. It exits 0, and the last entry of `shippedEpics` is `"054.4"`.

2. `"the conformance runner replays the four ship diagrams of this epic by equality"` — `test/sequence/conformance.test.ts:278` — `every due scenario conforms` runs unchanged, and `expiry-pass-one-due-paid`, `release-reap-paid`, `sweep-external-runs-paid` and `recovery-verdict-run-paid` are all due once `"054.4"` is in `shippedEpics`. Assert the case exits 0 and that `liveDiagrams()` holds all four ids. **Four and not three**: the epic's `## Sequence` table names four ship diagrams, and its prose count of three is a defect a reviewer resolves.

3. `"the four superseded ids hold no scenario file"` — assert `existsSync` is false for `test/sequence/scenarios/expiry-pass-one-due.ts`, `test/sequence/scenarios/release-reap.ts`, `test/sequence/scenarios/sweep-external-runs.ts` and `test/sequence/scenarios/recovery-verdict-run.ts`, and that `validateScenarioFiles()` at `test/sequence/conformance.test.ts:104` — `validateScenarioFiles` does not throw. The control is case 2: the four replacements do exist and do conform, so the absence assertion is not vacuous.

4. `"the comparison fails when attempt.end is removed from any one of the four paths"` — a **mutation exercise**, performed once per path and recorded, not an automated case. For each of the four commands, delete the `dependencies.attempt.end(...)` statement, run `node --test test/sequence/conformance.test.ts`, and confirm the failure message is `sequence mismatch for diagram <id>` from `test/helpers/sequence-conformance.ts:351` — `sequence mismatch for diagram`. Restore the statement after each. **Record the four confirmations in the review note, one line per diagram id with the failure message it produced.** `pnpm run verify` preserves no evidence that a mutation ran, so the review note is the artifact and a run with fewer than four recorded confirmations does not discharge this row. An automated negative test would be stronger; it is not written here because `test/sequence/conformance.test.ts` compares the real command and cannot mutate it, and EPIC 054.2 gate row 12 and EPIC 054.3 gate row 13 state the same exercise the same way. Gate row 14.

5. `"the range gate accepts the epic"` — `node scripts/verify-epic-sequence.ts` exits 0 with `"054.4"` in `authoredEpics`, and `scripts/verify-epic-sequence.test.ts` exits 0 over the real tree.

6. `"the proposal states the whole closure table"` — a reviewer reads `docs/proposal/phase-2/attempts-and-classification.md` against the epic's gate rows 1 to 10 **in both directions**: every row of the closure table names a case that stores its class, and every one of rows 1 to 10 appears as a table row. Record the two-directional read in the review note. Gate row 15.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `test/sequence/conformance.test.ts` in `PASS EPIC-054.4`.
