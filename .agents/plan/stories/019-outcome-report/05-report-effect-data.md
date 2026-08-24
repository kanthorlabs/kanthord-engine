# Story 5 — The report effect as data

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Story 3 (the widened `exhausted`) and Story 4 (the trigger ids `attempt-failed` and `report-cancelled`).

## Change

### A new `src/domain/outcome-report.ts`

It imports `type AttemptAccounting` from `./attempt-accounting.ts`, `type AttemptOutcome` from `./attempt.ts`, `type NodeKind`, `type NodeState` and `type TerminalState` from `./state.ts`, and `type ExternalTriggerId` from `./external-transition.ts`. It imports nothing else, and it imports no `zod`.

```ts
export const reportKinds = [
  "accepted",
  "rejected",
  "failed",
  "cancelled",
  "attested",
  "closed",
] as const;
export type ReportKind = (typeof reportKinds)[number];

export const taskReportOutcomes = [
  "accepted",
  "rejected",
  "failed",
  "cancelled",
] as const;
export type TaskReportOutcome = (typeof taskReportOutcomes)[number];

export const objectiveReportKinds = ["attested", "closed"] as const;
export type ObjectiveReportKind = (typeof objectiveReportKinds)[number];

export type TaskReportEffect = Readonly<{
  attemptOutcome: AttemptOutcome;
  nodeState: NodeState;
  blockReason: "attempt-limit" | null;
  runEnd: "done" | "blocked" | null;
  objectIdRequired: boolean;
  trigger: ExternalTriggerId;
}>;

export type TaskReportEffectInput = Readonly<{
  outcome: TaskReportOutcome;
  accounting: AttemptAccounting;
}>;

export function taskReportEffect(
  input: TaskReportEffectInput,
): TaskReportEffect;
```

The file also declares the **one** result record every branch of the route returns, so the three commands of Stories 7, 9 and 11 share one shape and `commands/` never imports `commands/`:

```ts
export type NodeReportResult = Readonly<{
  nodeId: string;
  kind: NodeKind;
  state: NodeState;
  blockReason: string | null;
  attemptId: string | null;
  attemptNo: number | null;
  attemptsRemaining: number | null;
  objectId: string | null;
  objectiveState: NodeState | null;
  objectiveProjection: TerminalState | null;
}>;
```

A member a branch does not fill is `null`, never absent. `src/http/contract/outcome.ts` mirrors this record key for key under Story 18.

`input.accounting` is the accounting of the task run **after** the reported attempt closes.

The function is total over the four outcomes and it holds exactly these branches:

- `accepted` returns `{ attemptOutcome: "accepted", nodeState: "done", blockReason: null, runEnd: "done", objectIdRequired: true, trigger: "outcome-accepted" }`. It reads `input.accounting` in this branch not at all.
- `rejected`, `failed` and `cancelled` each read `input.accounting.exhausted`.
  - Not exhausted: `{ attemptOutcome: <the outcome>, nodeState: "ready", blockReason: null, runEnd: null, objectIdRequired: false, trigger: <the per-outcome trigger> }`, where the per-outcome trigger is `attempt-rejected` for `rejected`, `attempt-failed` for `failed` and `report-cancelled` for `cancelled`.
  - Exhausted: `{ attemptOutcome: <the outcome>, nodeState: "blocked", blockReason: "attempt-limit", runEnd: "blocked", objectIdRequired: false, trigger: "attempt-limit-reached" }`.

`cancelled` reaches the limit exactly as `rejected` does. The function reads no clock, mints no identity and holds no `from`/`to` pair of its own.

## Constraints

- `taskReportOutcomes` is a strict subset of `attemptOutcomes` at `src/domain/attempt.ts:6-12`; `timed-out` is absent from it.
- Return a fresh object literal per call. Hold no module-level mutable state and no memo.
- Add no `zod` schema. The request schema lives in `src/http/contract/outcome.ts` under Story 18.
- No clock, no `Math.random`, no `new Date` — `src/domain/layout.test.ts:55-66` forbids them in `src/domain/`.
- Add no fifth outcome and no seventh report kind.

## Verify

Create `src/domain/outcome-report.test.ts`, suite name `"src/domain/outcome-report.test"`. It imports `externalTransitions` from `./external-transition.ts`.

- `it("the three vocabularies are exact", ...)` — `reportKinds` deep-equals the six-member literal, `taskReportOutcomes` deep-equals the four-member literal, `objectiveReportKinds` deep-equals `["attested", "closed"]`, and every member of `taskReportOutcomes` is a member of `attemptOutcomes`.
- `it("timed-out is not a task report outcome", ...)` — assert `taskReportOutcomes` does not include `"timed-out"`, and assert `attemptOutcomes` does include it.
- `it("the full cross product returns the fixed record", ...)` — drive all eight pairs of the four outcomes with `exhausted: false` and `exhausted: true`, and `assert.deepEqual` each result against the literal record above. Build each `AttemptAccounting` as a literal: not exhausted is `{ counter: 1, rejections: 0, exhausted: false, nextAttemptNo: 2 }`, exhausted is `{ counter: 3, rejections: 0, exhausted: true, nextAttemptNo: 4 }`.
- `it("nodeState equals the to of the row the trigger names", ...)` — for each of the eight results, find the row of `externalTransitions` whose `trigger` equals the returned `trigger`, and assert `row.to === result.nodeState` and `row.level === "task"`. This is the assertion that keeps the two representations of the destination from disagreeing.
- `it("accepted ignores the accounting", ...)` — call with `accepted` under both accountings and assert the two results are deep-equal.
- `it("cancelled reaches the limit exactly as rejected does", ...)` — assert the exhausted `cancelled` result and the exhausted `rejected` result differ in `attemptOutcome` alone, compared field by field.
- `it("NodeReportResult holds ten keys in order", ...)` — build one literal of the type and assert `Object.keys` deep-equals `["nodeId", "kind", "state", "blockReason", "attemptId", "attemptNo", "attemptsRemaining", "objectId", "objectiveState", "objectiveProjection"]`. This is the key order `src/http/contract/outcome.ts` mirrors.
- `node --test src/domain/outcome-report.test.ts src/domain/external-transition.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/domain/outcome-report.test.ts`. Hermetic coverage: `019-outcome-report.md:170`.
