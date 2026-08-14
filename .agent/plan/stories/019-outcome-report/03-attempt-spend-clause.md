# Story 3 — Every closed attempt spends a try

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Story 1 (the same clause in the proposal prose).

## Change

### `src/domain/attempt-accounting.ts:70-74`

The site reads:

```ts
const counterRecord = input.attempts.find((a) => a.attemptNo === counter);
const exhausted =
  counterRecord !== undefined &&
  counterRecord.outcome === "rejected" &&
  counter >= input.limit;
```

Replace the `outcome` clause only:

```ts
const counterRecord = input.attempts.find((a) => a.attemptNo === counter);
const exhausted =
  counterRecord !== undefined &&
  counterRecord.outcome !== null &&
  counter >= input.limit;
```

Nothing else in the file changes.

## Constraints

- `counter` at `:59-64`, `rejections` at `:60,65-67` and `nextAttemptNo` at `:80` keep their present rules. `rejections` keeps counting `rejected` alone, because it names one outcome and a human reads it.
- Keep the `counter >= input.limit` clause. An exhausted run needs both the limit and a closed attempt at the counter.
- Keep `attemptVerdict` at `:84-89` unchanged.
- Do not add a clock, a random source or an import. `src/domain/layout.test.ts` forbids all three in `src/domain/`.

## Verify

Edit `src/domain/attempt-accounting.test.ts`. Keep every existing case.

- Beside each existing case that closes the counter attempt with `rejected` at the limit, add the same case with `outcome: "failed"`, with `outcome: "cancelled"` and with `outcome: "timed-out"`. Each asserts `exhausted === true`.
- `it("an accepted attempt at the limit is exhausted", ...)` — one attempt, `attemptNo: 3`, `outcome: "accepted"`, `limit: 3`; assert `exhausted === true`.
- `it("an open attempt at the counter is not exhausted", ...)` — attempts `[{attemptNo: 1, outcome: "rejected"}, {attemptNo: 2, outcome: "rejected"}, {attemptNo: 3, outcome: null}]`, `limit: 3`; assert `exhausted === false`, `counter === 3`, `rejections === 2` and `nextAttemptNo === 4`.
- `it("a closed attempt under the limit is not exhausted", ...)` — attempts `[{attemptNo: 1, outcome: "cancelled"}]`, `limit: 3`; assert `exhausted === false`.
- `it("rejections counts rejected alone", ...)` — attempts `[{attemptNo: 1, outcome: "rejected"}, {attemptNo: 2, outcome: "failed"}, {attemptNo: 3, outcome: "cancelled"}]`, `limit: 3`; assert `rejections === 1` and `exhausted === true`.
- `it("a gap never lowers the counter", ...)` — attempts `[{attemptNo: 1, outcome: "failed"}, {attemptNo: 3, outcome: "failed"}]`, `limit: 3`; assert `counter === 3`, `exhausted === true` and `nextAttemptNo === 4`.
- `node --test src/domain/attempt-accounting.test.ts` exits 0.
- `node --test src/commands/startup/recover-expired-leases.test.ts` exits 0, which is the one existing consumer of `accountAttempts`. Run `grep -rn "accountAttempts" src/ | grep -v '\.test\.ts'` first and run the test of every file it names.
- `npm run verify` exits 0.
- Proof: `src/domain/attempt-accounting.test.ts`. Hermetic coverage: `019-outcome-report.md:147` and `:149`.
