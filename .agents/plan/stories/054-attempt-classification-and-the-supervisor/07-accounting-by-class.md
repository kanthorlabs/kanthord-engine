# Story 7 — Accounting by class

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: Story 6 (`06-the-evidence-union-and-the-classifiers`), for the `Termination` type;
Story 3 (`03-the-close-writes-the-termination`), for `termination` on the execution service's
`AttemptRecord`, which four of the eight construction sites read.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.
It edits two commands and moves no seam call in either: `accountAttempts` is a pure-domain call the
recorder cannot see, `attemptsRemaining` is a computed response value, and
`test/helpers/sequence-conformance.ts:72` — `events.append` projects `type`, `subjectId` and
`payload.reason` and never `payload.attemptsRemaining`.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**This is a behaviour change to shipped code, and the shipped cases move rather than stay.** All
forty-two cases of `src/domain/attempt-accounting.test.ts` assert the whole result object with
`deepEqual`, so every one takes the two new members whatever else changes. Two of them assert the
**old** rule directly and must be rewritten, not merely extended:
`src/domain/attempt-accounting.test.ts:125` — `a failure at the limit is exhausted` and
`src/domain/attempt-accounting.test.ts:167` — `three accepted attempts at the limit are exhausted`.

## Change

### 1 — `src/domain/attempt-accounting.ts` — the record and the result

**Add one field to `src/domain/attempt-accounting.ts:3`** — `AttemptRecord`:

```ts
export type AttemptRecord = Readonly<{
  attemptNo: number;
  outcome: AttemptOutcome | null;
  termination: Termination | null;
}>;
```

**Add two fields to `src/domain/attempt-accounting.ts:8`** — `AttemptAccounting`:

```ts
export type AttemptAccounting = Readonly<{
  counter: number;
  rejections: number;
  semanticCount: number;
  ambiguousCount: number;
  exhausted: boolean;
  nextAttemptNo: number;
}>;
```

Import the type beside `src/domain/attempt-accounting.ts:1` — `AttemptOutcome`:
`import type { Termination } from "./termination.ts";`.

**`counter`, `rejections` and `nextAttemptNo` all stay.** `counter` still feeds
`src/commands/outcome/report-outcome.ts:255`, and `nextAttemptNo` still feeds
`src/services/execution/sqlite.ts:274` and `test/helpers/execution.ts:427`. `rejections` has no
production reader — `grep -rn --include='*.ts' rejections src test` finds only
`src/domain/attempt-accounting.test.ts` and an unrelated local in
`src/queries/actor/resolve-actor.test.ts:308` — and it stays anyway: this change did not orphan it,
so removing it is not this story's to take.

### 2 — `src/domain/attempt-accounting.ts` — the counts and the new predicate

**Add two counters to the loop at `src/domain/attempt-accounting.ts:61`** and **replace the
`exhausted` computation at `src/domain/attempt-accounting.ts:70`**:

```ts
let counter = 0;
let rejections = 0;
let semanticCount = 0;
let ambiguousCount = 0;
for (const attempt of input.attempts) {
  if (attempt.attemptNo > counter) {
    counter = attempt.attemptNo;
  }
  if (attempt.outcome === "rejected") {
    rejections++;
  }
  if (attempt.termination === "semantic") {
    semanticCount++;
  }
  if (attempt.termination === "ambiguous") {
    ambiguousCount++;
  }
}

const exhausted = semanticCount >= input.limit;

return {
  counter,
  rejections,
  semanticCount,
  ambiguousCount,
  exhausted,
  nextAttemptNo: counter + 1,
};
```

**`src/domain/attempt-accounting.ts:70`** — `counterRecord` is deleted, and with it the condition
"the attempt at the counter is closed". Nothing replaces it: a termination exists only on a closed
attempt, because `attempt_termination_outcome` refuses one on an open row, so an open attempt
contributes zero to `semanticCount` by construction rather than by a guard. All three callers already
evaluate over closed attempts —
`src/commands/outcome/report-outcome.ts:241` — `accountAttempts` runs after the close at
`src/commands/outcome/report-outcome.ts:234` — `closeAttempt`, the projection at
`src/commands/node/release-node.ts:113` — `accountAttempts` closes the open attempt in the projection
itself, and `src/services/execution/sqlite.ts:266` — `accountAttempts` reads `nextAttemptNo` and
never `exhausted`.

**`ambiguousCount` counts the stored class, so a converted attempt counts as semantic.** The epic's
Decisions state the conversion is applied at classification time and the stored value is what was
charged; counting the pre-conversion class here would make the row and the accounting disagree.

**Neither counter validates a `termination`.** The three existing refusals at
`src/domain/attempt-accounting.ts:35`, `:44` and `:50` stay exactly as they are, and
`AttemptAccountingError` gains no code: a termination outside the three values cannot reach here past
`z.enum(terminations)` and past `attempt_termination_value`.

### 3 — The eight construction sites

The epic's Decisions enumerate them, and `pnpm run build` names each one. Three are done by Story 3
(`03-the-close-writes-the-termination`) — `src/services/execution/index.ts:28`,
`src/services/execution/sqlite.ts:80` and the `openAttempt` literal at
`src/services/execution/sqlite.ts:276` — and two more of its sites are the
`test/helpers/execution.ts` mirrors at `:191` and `:429`. This story carries the rest:

1. **`src/domain/attempt-accounting.ts:3`** — `AttemptRecord`, per section 1.
2. **`src/services/execution/sqlite.ts:266`** — `accountAttempts`, unchanged. `attempts` is
   `readonly AttemptRecord[]` of the execution service, which after Story 3 carries `termination`, so
   it satisfies the domain record structurally. Confirm by build, edit nothing.
3. **`src/commands/node/release-node.ts:113`** — the projection. Rewrite
   `src/commands/node/release-node.ts:116` — `.map`:

```ts
      .map((attempt) =>
        attempt.id === open.id
          ? {
              attemptNo: attempt.attemptNo,
              outcome: "cancelled" as const,
              termination: "infrastructure" as const,
            }
          : {
              attemptNo: attempt.attemptNo,
              outcome: attempt.outcome,
              termination: attempt.termination,
            },
      ),
```

**The released attempt projects `"infrastructure"`, and the other attempts project their stored
class.** The epic's Decisions state the effect: a run whose attempts are all releases never
exhausts its limit, and the `blocked` write at
`src/commands/node/release-node.ts:134` — `attempt-limit` stays reachable only when an earlier
attempt of the same run carried a semantic termination. This is a projection and not a write:
EPIC 054.4 is the epic that gives `src/commands/node/release-node.ts:124` — `closeAttempt` the
termination it stores.

4. **`src/commands/outcome/report-outcome.ts:241`** — the projection. Rewrite
   `src/commands/outcome/report-outcome.ts:244` — `.map` **so the closing attempt projects the class
   this arm charges**, exactly as site 3 does for the release:

```ts
      .map((row) =>
        row.id === open.id
          ? {
              attemptNo: row.attemptNo,
              outcome: body.report,
              termination: "semantic" as const,
            }
          : {
              attemptNo: row.attemptNo,
              outcome: row.outcome,
              termination: row.termination,
            },
      ),
```

**The closing attempt is still open when this projection runs, and a pass-through would price it at
zero.** EPIC 050.4 Story 6 (`06-the-report-drops-the-lease`) collapsed the two attempt reads into
one taken **before** the close, so `row` is the open row and `row.termination` is `null` on it. With
`exhausted` now `semanticCount >= limit`, a pass-through makes `semanticCount` blind to the charge
the same statement is making, and the `attempt-limit` branch of
`src/domain/outcome-report.ts:57` — `exhausted` becomes unreachable on the report route. This is
the identical defect site 3 avoids by projecting `"infrastructure"` onto the released attempt.

**The literal is `"semantic"` because the worker arm charges one class and one only.** The three
worker-driven members reach this statement, all three carry
`evidence: { kind: "worker-reported-failure" }`, and that kind maps to `semantic` for both drivers
— the table of the epic's Decisions — and is not an `ambiguous` kind, so `convertOnExhaustion`
never reaches it. The projection and the stored row are therefore provably equal, and
EPIC 054.3 Story 2 (`02-the-worker-failure-pays-its-attempt`) asserts the equality by value once
`end-attempt` is the closer. **Every other arm of the command projects `row.termination`
unchanged**, because no other arm closes an attempt here.

5. **`test/helpers/execution.ts:419`** — `accountAttempts` of `createBackedExecutionFake`, unchanged
   for the same structural reason as site 2.

### 4 — `src/commands/outcome/report-outcome.ts` — `attemptsRemaining` follows the limit

**Rewrite `src/commands/outcome/report-outcome.ts:253`** — `attemptsRemaining`:

```ts
const attemptsRemaining = Math.max(
  0,
  run.attemptLimit - accounting.semanticCount,
);
```

**`semanticCount` and not `counter`, and the epic's Decisions now state it.** The ruling was taken
during authoring and applied to the epic:
`.agents/plan/epics/054-attempt-classification-and-the-supervisor.md` — `attemptsRemaining` carries
it and gate row 18a carries its proof. Leaving it on `counter` makes the two disagree: three infrastructure failures under a limit of three would answer
`attemptsRemaining: 0` while the daemon kept granting attempts. `counter` is the highest attempt
**number**; the limit now counts semantic terminations, so the number a worker reads has to count the
same thing. `src/http/contract/outcome.ts:62` — `attemptsRemaining` and
`src/http/contract/event-payload.ts:168` — `attemptsRemaining` both keep their types, so no contract
schema moves.

This is a **shipped response value changing** on two published observables — the `node.report`
response and the `outcome.reported` payload, which reuse the one value — and case 8 asserts it by
value in both directions. This is the epic's gate row 18a.

## Constraints

- `attemptVerdict` at `src/domain/attempt-accounting.ts:84` does not change. It reads `exhausted` and
  nothing else, and `src/domain/outcome-report.ts:57` — `exhausted` is its one production reader.
- `AttemptAccountingError` and its three codes do not change.
- `rejections` keeps its exact definition: the count of attempts whose `outcome` is `"rejected"`. It
  is not redefined as a semantic count, because a rejection and a semantic termination are different
  facts and EPIC 054.4 is what makes every rejection carry one.
- `src/domain/attempt.ts:7` — `attemptOutcomes` does not change.
- The projection in `release-node` is the only place a literal `"infrastructure"` appears in
  `src/commands/` after this story. A reviewer greps for a second one.

## Verify

```
node --test src/domain/attempt-accounting.test.ts src/commands/node/release-node.test.ts src/commands/outcome/report-outcome.test.ts src/services/execution/sqlite.test.ts
```

Extend `src/domain/attempt-accounting.test.ts`, whose suite is at
`src/domain/attempt-accounting.test.ts:17` — `describe`. **Every one of its forty-two
`accountAttempts` calls takes `termination` on each record and every `deepEqual` takes
`semanticCount` and `ambiguousCount`.** Give a record whose `outcome` is `"rejected"` the termination
`"semantic"` and every other closed record `"infrastructure"`, so the shipped cases keep the meaning
their names claim; the two cases named above then read `exhausted` correctly rather than being
contradicted.

Add, each as a separate `it`:

1. `"three semantic terminations at the limit are exhausted and three infrastructure ones are not"` —
   two sub-cases over a limit of three. Three records with `termination: "semantic"` give
   `deepEqual(result, { counter: 3, rejections: 0, semanticCount: 3, ambiguousCount: 0, exhausted:
true, nextAttemptNo: 4 })`; the same three with `termination: "infrastructure"` give
   `semanticCount: 0` and `exhausted: false`. Assert the **full result object** in both, not the
   predicate alone. This is the epic's gate row 15.

2. `"a mixed run is exhausted only when the semantic count reaches the limit"` — one case, limit
   three, over records `[semantic, infrastructure, ambiguous]`: assert
   `{ counter: 3, rejections: 0, semanticCount: 1, ambiguousCount: 1, exhausted: false,
nextAttemptNo: 4 }` by full object. Then a fourth and fifth record, both `semantic`, and assert
   `semanticCount: 3` and `exhausted: true`. This is the epic's gate row 15.

3. `"an attempt whose termination is null counts toward neither count"` — three records with
   `termination: null` and closed outcomes under a limit of three give
   `{ counter: 3, rejections: 0, semanticCount: 0, ambiguousCount: 0, exhausted: false,
nextAttemptNo: 4 }` by full object. This is the legacy-row effect migration `16` creates: no row is
   backfilled, so a live run's earlier failures are forgiven at the upgrade and its attempt limit
   restarts. The control is one of the three given `termination: "semantic"` under a limit of one,
   which reports `exhausted: true`. This is the epic's gate row 16.

4. `"an open attempt contributes to neither count"` — records
   `[{ 1, "failed", "semantic" }, { 2, null, null }]` under a limit of two give `semanticCount: 1`,
   `exhausted: false` and `nextAttemptNo: 3`.

4a. `"a closed semantic attempt at the limit exhausts even while a later attempt is open"` — the
**same two records under a limit of one** give `semanticCount: 1` and `exhausted: true`. This is
the one input on which the deleted `counterRecord` condition changed the answer: the old predicate
read the highest-numbered attempt, found it open, and returned `false`. Case 4 alone cannot detect
the deletion, because at a limit of two both predicates answer `false`. **The divergence is a
behaviour change, and the case pins it rather than leaving a reader to derive it.**

No production caller reaches it — `src/commands/outcome/report-outcome.ts:241` runs after the
close at `:234`, the projection at `src/commands/node/release-node.ts:113` closes the open attempt
inside the projection, and `src/services/execution/sqlite.ts:266` reads `nextAttemptNo` and never
`exhausted` — but `accountAttempts` is a public pure function and the database CHECK constrains
rows, not arguments, so a fake or a future caller can construct the input. The new rule is the
ruling this case records.

5. `"the accounting reads the termination the row stores"` — in
   `src/services/execution/sqlite.test.ts`, close two attempts of one run with `"semantic"` and
   `"infrastructure"`, then call `accountAttempts` over
   `execution.attemptsOfRun(transaction, runId)` with `limit: 1` and assert `semanticCount` is `1`
   and `exhausted` is `true`. Then run the identical body against
   `createBackedExecutionFake` at `test/helpers/execution.ts:220` and assert the same result object.
   Two readers, one assertion each, which is the epic's gate row 18 beyond the build.

6. `"a run whose every attempt is a release never exhausts the limit"` — in
   `src/commands/node/release-node.test.ts`, drive `releaseNode` over a run holding two earlier
   attempts closed with `termination: "infrastructure"` and a limit of two, and assert the node
   reaches `ready` and not `blocked`, and that no row carries
   `block_reason = 'attempt-limit'`. This is the epic's gate row 17.

7. `"one earlier semantic attempt of the same run still reaches the attempt-limit block"` — the
   control for case 6: the same fixture with the first attempt closed
   `termination: "semantic"` and a limit of one, asserting the node reaches `blocked` with
   `block_reason` `"attempt-limit"` at
   `src/commands/node/release-node.ts:134` — `attempt-limit`. Both cases run over the projection at
   `src/commands/node/release-node.ts:113` — `accountAttempts`, so the pair proves the projection
   carries the class rather than a constant. This is the epic's gate row 17.

8. `"attemptsRemaining counts semantic terminations"` — in
   `src/commands/outcome/report-outcome.test.ts`, extend
   `src/commands/outcome/report-outcome.test.ts:559` — `attemptsRemaining clamps at zero`. Under a
   limit of three: a run with one stored `"semantic"` attempt answers `2`, a run with three stored
   `"infrastructure"` attempts answers `3`, and a run with three stored `"semantic"` attempts answers
   `0`. The middle sub-case is the one the old `counter` arithmetic answered `0` for, and it is what
   makes this change visible. Assert each by value on `result.attemptsRemaining`.

8a. `"a worker report charges the attempt it is closing, and the third one blocks the node"` — in
`src/commands/outcome/report-outcome.test.ts`, over
`src/commands/outcome/report-outcome.test.ts:509` — `driveOutcomeToLimit`, report `failed` three
times under a limit of three and assert `result.attemptsRemaining` is `2`, then `1`, then `0`, and
that the third report leaves the node `blocked` with `block_reason` `"attempt-limit"` through
`src/commands/outcome/report-outcome.test.ts:530` — `assertBlockedAtLimit`. **The control is the
same three reports with site 4's projection left as a pass-through**, where `semanticCount` stays
`0`, `attemptsRemaining` answers `3` every time and the node never blocks. This is what proves the
closing attempt is charged, and without it site 4's projection is unmeasured by this epic — the
only other reader of the projection is the release, at cases 6 and 7.

9. `"the accounting result declares exactly six members"` — assert
   `Object.keys(accountAttempts({ attempts: [], limit: 1 })).sort()` deep-equals
   `["ambiguousCount", "counter", "exhausted", "nextAttemptNo", "rejections", "semanticCount"]`. This
   is what stops a seventh member arriving unannounced, and it is the case a reviewer reads to see
   that `rejections` was kept deliberately.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/attempt-accounting.test.ts` in `PASS EPIC-054`.
