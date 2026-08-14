# Story 8 — The `outcome.reported` event payload, fixed key by key

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Story 7. The two stories edit the same file; implement them as one pair.

## Change

### `src/commands/outcome/report-outcome.ts`, step 15 of Story 7

Pin the append exactly:

```ts
dependencies.events.append(transaction, {
  subjectKind: "node",
  subjectId: node.id,
  type: "outcome.reported",
  actorKind: "harness",
  actorId: input.actorId,
  payload: {
    runId: run.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    outcome: input.body.report,
    reason: reason,
    objectId: objectId,
    attemptsRemaining: attemptsRemaining,
    fromState: "running",
    toState: effect.nodeState,
  },
});
```

Every field is fixed:

- `type` is the literal `"outcome.reported"`. It is never built from a variable.
- `actorKind` is the literal `"harness"`. The task branch admits no other kind.
- `actorId` is the authenticated actor id from `input.actorId`. It is never read from the body.
- The payload holds exactly nine keys, in this key order: `runId`, `attemptId`, `attemptNo`, `outcome`, `reason`, `objectId`, `attemptsRemaining`, `fromState`, `toState`.
- `reason` is the body `reason` for `rejected`, `failed` and `cancelled`, and `null` when the body carries none. `accepted` carries no `reason`, so it writes `null`.
- `objectId` is the body `objectId` for `accepted` and `null` for the other three.
- `fromState` is the literal `"running"`. `toState` is `effect.nodeState`.
- The append shares the caller's transaction, so the report and its event never split.

This payload is the durable home of a rejected or a failed reason: `attempt` holds no reason column and this epic adds no migration.

## Constraints

- Add no tenth key and drop none of the nine.
- Do not mint an id and do not read a clock. `SqliteEventLog.append` mints the event id and derives the time from the ULID.
- Write exactly one `outcome.reported` event per call, on every outcome including the limit case.
- Do not append a second event for the transition. `setNodeState` and the readiness service own their own events.

## Verify

Add to `src/commands/outcome/report-outcome.test.ts`, over the recording `EventLog` fake.

- `it("the payload holds exactly nine keys in order", ...)` — `assert.deepEqual(Object.keys(payload), ["runId", "attemptId", "attemptNo", "outcome", "reason", "objectId", "attemptsRemaining", "fromState", "toState"])`. A tenth key fails.
- `it("an accepted report records the object id and a null reason", ...)` — assert the whole recorded `AppendEventInput` with `assert.deepEqual` against the literal, `subjectKind: "node"`, `actorKind: "harness"` and `actorId` equal to the input actor id.
- `it("a rejected report stores its reason verbatim", ...)` — drive a reason string with a newline and a non-ASCII character and assert equality byte for byte.
- `it("a cancelled report with no reason stores null", ...)`.
- `it("the limit case records toState blocked and attemptsRemaining zero", ...)`.
- `it("exactly one outcome.reported event is appended per report", ...)` — count the recorded events of that type and assert `1` on each of the four outcomes.
- `node --test src/commands/outcome/report-outcome.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/commands/outcome/report-outcome.test.ts`. Hermetic coverage: `019-outcome-report.md:158`.
