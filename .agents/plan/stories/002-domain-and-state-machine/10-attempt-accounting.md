# Story 10 — Attempt accounting

Epic: `.agents/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 03 (`src/domain/state.ts`).

## Change

### `src/domain/attempt-accounting.ts` (new)

```ts
import type { AttemptOutcome } from "./attempt.ts";

export type AttemptRecord = Readonly<{
  attemptNo: number;
  outcome: AttemptOutcome | null;
}>;

export type AttemptAccounting = Readonly<{
  counter: number;
  rejections: number;
  exhausted: boolean;
  nextAttemptNo: number;
}>;

export type AttemptVerdict =
  | Readonly<{ state: "running"; blockReason: null }>
  | Readonly<{ state: "blocked"; blockReason: "attempt-limit" }>;

export type AttemptAccountingErrorCode =
  "attempt-limit-invalid" | "attempt-no-invalid" | "attempt-no-duplicate";

export class AttemptAccountingError extends Error {
  readonly code: AttemptAccountingErrorCode;

  constructor(code: AttemptAccountingErrorCode, message: string) {
    super(message);
    this.name = "AttemptAccountingError";
    this.code = code;
  }
}

export function accountAttempts(
  input: Readonly<{ attempts: readonly AttemptRecord[]; limit: number }>,
): AttemptAccounting;

export function attemptVerdict(accounting: AttemptAccounting): AttemptVerdict;
```

Exact behaviour:

- `AttemptOutcome` and the five members come from `src/domain/attempt.ts`, which Story 03 creates. This file restates nothing — one exported vocabulary drives the row schema and the rule.
- Validation, in this order:
  1. `Number.isInteger(input.limit) === false` or `input.limit < 1` throws `AttemptAccountingError("attempt-limit-invalid", \`attempt limit ${limit} is not a positive integer\`)`.
  2. An `attemptNo` that is not an integer, or is below `1`, throws `AttemptAccountingError("attempt-no-invalid", \`attempt number ${attemptNo} is not a positive integer\`)`. `docs/proposal/database/attempt.md:9` numbers attempts from 1. Records are checked in array order.
  3. A repeated `attemptNo` throws `AttemptAccountingError("attempt-no-duplicate", \`attempt number ${attemptNo} appears twice\`)`. `docs/proposal/database/attempt.md:18`declares`UNIQUE (run_id, attempt_no)`.
- `counter` is `MAX(attemptNo)` across `input.attempts`, and `0` for an empty array. `docs/proposal/database/attempt.md:24,40`: "The attempt counter is `MAX(attempt_no)` of the active task run."
- `nextAttemptNo` is `counter + 1`. It is **not** `attempts.length + 1` — a gap in the numbering must not reissue a used number, because the unique constraint would reject the insert.
- `rejections` is the count of records whose `outcome === "rejected"`. It is reported for a status view; it is not the exhaustion test.
- `exhausted` is `true` when the record whose `attemptNo === counter` has `outcome === "rejected"` **and** `counter >= input.limit`. `docs/proposal/database/attempt.md:24` is normative: "`attempt_no = attempt_limit` with an `outcome` of `rejected` moves the task to `blocked` with reason `attempt-limit`." `>=` rather than `=` so a run that already overshot the limit still reports exhaustion.
- `attemptVerdict(accounting)` returns `{ state: "blocked", blockReason: "attempt-limit" }` when `accounting.exhausted` is `true`, and `{ state: "running", blockReason: null }` otherwise. `docs/proposal/phase-1/state-machine.md:77` makes `running → blocked` the transition, and `attempt-limit` the reason.

The EPIC bullet says "a rejection increments". `docs/proposal/database/attempt.md:24` says the counter is `MAX(attempt_no)` and the block fires on a **rejected** attempt at the limit. The two disagree once an attempt ends `failed`, `timed-out` or `cancelled`. `attempt.md` is the more specific source and it names both halves of the condition, so it wins. `rejections` stays on the result so a caller can still read the count the EPIC bullet describes.

## Constraints

- The file exports no default limit. `docs/proposal/phase-1/state-machine.md:116` puts the default of 3 in configuration, and `src/services/config` already holds it. A second copy in `src/domain/` would be a second truth.
- A pending attempt — `outcome: null` — raises `counter` and does not make the run exhausted.
- `accepted`, `failed`, `timed-out` and `cancelled` do not increment `rejections` and do not exhaust the run. A run of three failures at limit 3 stays claimable, per `docs/proposal/database/attempt.md:24`.
- The result does not depend on the order of `input.attempts`. The functions read `MAX(attemptNo)` and the record at that number, not the last array element.
- Redeclare no outcome vocabulary. Import `AttemptOutcome` from `./attempt.ts`.
- The functions write no state and read no clock. `attemptVerdict` returns the target state; the caller writes the transition through `canTransition`.
- Do not add an attempt-counter field to `src/domain/node.ts`. `docs/proposal/database/node.md:38`: "There is no attempt counter here. The count is the number of `attempt` rows of the active task run, so there is one truth."

## Verify

`node --test src/domain/attempt-accounting.test.ts` — new file, suite `"src/domain/attempt-accounting.test"`:

Every case below writes `input.attempts` as `attemptNo`/`outcome` pairs, and asserts the whole `AttemptAccounting` object with `assert.deepEqual`.

- Empty, limit 3: `{ counter: 0, rejections: 0, exhausted: false, nextAttemptNo: 1 }`.
- `[1 rejected]`, limit 3: `{ counter: 1, rejections: 1, exhausted: false, nextAttemptNo: 2 }`.
- `[1 rejected, 2 rejected]`, limit 3: `{ counter: 2, rejections: 2, exhausted: false, nextAttemptNo: 3 }`.
- **The normative case, `docs/proposal/database/attempt.md:40`.** `[1 rejected, 2 rejected, 3 rejected]`, limit 3: `{ counter: 3, rejections: 3, exhausted: true, nextAttemptNo: 4 }`.
- **A failure at the limit does not block.** `[1 failed, 2 failed, 3 failed]`, limit 3: `{ counter: 3, rejections: 0, exhausted: false, nextAttemptNo: 4 }`. The same for `timed-out`, `cancelled`, `accepted` and `null`.
- **A rejection at the limit blocks even with earlier failures.** `[1 failed, 2 failed, 3 rejected]`, limit 3: `{ counter: 3, rejections: 1, exhausted: true, nextAttemptNo: 4 }`. This is the case a rejection-count rule gets wrong.
- **Three rejections below the limit do not block.** `[1 rejected, 2 rejected, 3 rejected]`, limit 4: `exhausted` is `false`.
- **A pending attempt at the limit does not block.** `[1 rejected, 2 rejected, 3 null]`, limit 3: `{ counter: 3, rejections: 2, exhausted: false, nextAttemptNo: 4 }`.
- **Overshoot.** `[1 rejected, 2 rejected, 3 rejected, 4 rejected]`, limit 3: `{ counter: 4, rejections: 4, exhausted: true, nextAttemptNo: 5 }`.
- **The last attempt decides, not the array position.** `[3 rejected, 1 failed, 2 failed]`, limit 3, gives the same result as `[1 failed, 2 failed, 3 rejected]`. The reversed array of every case above gives the identical result.
- **A gap does not reissue a number.** `[2 rejected]`, limit 3: `{ counter: 2, rejections: 1, exhausted: false, nextAttemptNo: 3 }`. A length-based rule would return `2` and collide with the existing row.
- **A gap past the limit still blocks.** `[5 rejected]`, limit 3: `{ counter: 5, rejections: 1, exhausted: true, nextAttemptNo: 6 }`.
- Limit 1, `[1 rejected]`: `exhausted` is `true`. Limit 1, `[1 failed]`: `exhausted` is `false`.
- `accountAttempts({ attempts: [], limit: 0 })` throws with `code === "attempt-limit-invalid"`; the same for `-1` and for `1.5`.
- `[0 rejected]` throws with `code === "attempt-no-invalid"`; the same for `-1` and for `1.5`.
- `[1 rejected, 1 failed]` throws with `code === "attempt-no-duplicate"` and a message containing `1`.
- The limit is validated before the attempts: `{ attempts: [{ attemptNo: 0, outcome: null }], limit: 0 }` throws `"attempt-limit-invalid"`.
- Every thrown error satisfies `error instanceof AttemptAccountingError`.
- `attemptVerdict({ counter: 3, rejections: 3, exhausted: true, nextAttemptNo: 4 })` deep-equals `{ state: "blocked", blockReason: "attempt-limit" }`.
- `attemptVerdict({ counter: 1, rejections: 1, exhausted: false, nextAttemptNo: 2 })` deep-equals `{ state: "running", blockReason: null }`.
- The blocked verdict is a legal transition: `canTransition("task", "running", "blocked")` from `src/domain/transition.ts` is `true`, and `"attempt-limit"` is a member of `blockReasons`.

`npm run verify` exits 0.

Proof: contributes `src/domain/attempt-accounting.test.ts` to `node --test src/domain/**/*.test.ts`.
