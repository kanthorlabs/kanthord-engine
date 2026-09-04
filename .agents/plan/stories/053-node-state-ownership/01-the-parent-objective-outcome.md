# Story 1 — The parent-objective outcome

Epic: `.agents/plan/epics/053-node-state-ownership.md`
Depends on: nothing of this epic. It runs first, because `authoredEpics` must hold `"053"` before any
later story writes a scenario file or a supersession line.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

**It registers the epic as authored.** `scripts/epic-sequence-range.ts:1` — `authoredEpics` ends at
`"052.2"`, and `test/sequence/conformance.test.ts:272` — `"052.2"` pins the same list by
`assert.deepEqual`. Both take `"053"` in this story.
`scripts/verify-epic-sequence.ts:530` — `outside the authored set` refuses a `Superseded by:` line naming an epic
outside `authoredEpics`, so the entry must precede every later story of this epic and the amendment
EPIC 051.6 takes. Do **not** touch `scripts/epic-sequence-range.ts:20` — `shippedEpics`; Story 8
(`08-the-proposal-records-state-ownership`) appends to it and is last in dispatch order.

## Change

**Add `parentObjectiveOutcome` to `src/domain/outcome.ts`.** It joins `objectiveOutcome` at
`src/domain/outcome.ts:17` — `objectiveOutcome` and `initiativeOutcome` at `:25` —
`initiativeOutcome`, and the file keeps its name.

### 1 — the result type

```ts
export type ParentObjectiveOutcome = Readonly<
  | {
      state: "awaiting_approval";
      trigger: "objective-aggregated-awaiting-approval";
    }
  | { state: "discarded"; trigger: "objective-aggregated-discarded" }
>;
```

**It is a second type beside `LevelOutcome`, and it does not reuse it.** `LevelOutcome` at
`src/domain/outcome.ts:12` — `LevelOutcome` pairs a state with a `blockReason`, and neither state this
function returns is `blocked`, so a `blockReason` member would be a field that is always `null`. The
trigger takes its place, because
`src/services/plan/sqlite.ts:515` — `triggerTransition` validates the declared `from` and `to` of the
trigger against the write, so the state and the trigger are one decision and never two.

**`trigger` is typed by its two literals, and not by `InternalTriggerId`.** Story 2
(`02-the-triggers-and-the-payload-variant`) is what puts those two ids in
`src/domain/node-trigger.ts:8` — `internalTriggerIds`, so a reference to `InternalTriggerId` here
would not compile until that story lands. The literal union is the narrower type of the two, it is
assignable to `NodeTriggerId` at `src/services/plan/index.ts:59` — `trigger` once Story 2 lands, and
Story 2 case 3 is the assertion that binds the two texts together.

### 2 — the function

```ts
export function parentObjectiveOutcome(
  projected: TerminalState,
): ParentObjectiveOutcome {
  if (projected === "discarded") {
    return {
      state: "discarded",
      trigger: "objective-aggregated-discarded",
    };
  }

  return {
    state: "awaiting_approval",
    trigger: "objective-aggregated-awaiting-approval",
  };
}
```

Three rows collapse to two branches, because `done` and `partial` share a state and a trigger. The
epic's table at `.agents/plan/epics/053-node-state-ownership.md:38` — `parentObjectiveOutcome(projected)` is what
case 1 iterates, and it iterates all three inputs, so the collapse is proven and never assumed.

### 3 — the dead branch of `objectiveOutcome`

**Edit `src/domain/outcome.ts` to remove lines 18 to 20 of `objectiveOutcome`.** The body becomes the
single `return { state: "awaiting_approval", blockReason: null };` of `src/domain/outcome.ts:22` —
`awaiting_approval`, and the signature does not change.

**The branch is already unreachable at its only production call site, so no command changes.**
`src/commands/outcome/report-objective.ts:140` — `objectiveOutcome` is the one caller, and
`src/commands/outcome/report-objective.ts:137` — `projection-discarded` throws
`ReportObjectiveError("illegal-transition", …, { guard: "projection-discarded" })` for a `discarded`
projection seven lines above it. A `discarded` value therefore never reaches the function in
production. Removing the branch is the removal of dead code, and
`src/commands/outcome/report-objective.test.ts` needs no edit.

**Nothing else reads it.** The complete consumer set of `objectiveOutcome` is
`src/commands/outcome/report-objective.ts:2` — `objectiveOutcome` for the import and `:140` for the
call, plus `src/domain/outcome.test.ts:3` — `objectiveOutcome` and its eight uses in that file. No
generated artifact names it: it is a domain function with no contract schema and no OpenAPI
component.

### 4 — the range

**Edit `scripts/epic-sequence-range.ts` to append `"053"` to `authoredEpics`**, after
`scripts/epic-sequence-range.ts:18` — `"052.2"` and before the closing `] as const;` at `:19`.

**Edit `test/sequence/conformance.test.ts` to append `"053"` to the pinned literal**, after
`test/sequence/conformance.test.ts:272` — `"052.2"`. `assert.deepEqual(authoredEpics, [...])` at
`test/sequence/conformance.test.ts:255` — `authoredEpics` fails without it.

## Constraints

- `objectiveOutcome` keeps its name, its one parameter and its `LevelOutcome` return type. Only the
  `discarded` branch goes.
- `parentObjectiveOutcome` reads nothing but its argument. `src/domain/` is pure, so it mints no id,
  reads no clock and touches no service.
- Do not add a `blockReason` member to `ParentObjectiveOutcome`.
- Do not touch `scripts/epic-sequence-range.ts:20` — `shippedEpics`.
- Do not edit `src/commands/outcome/report-objective.ts`.

## Verify

```
node --test src/domain/outcome.test.ts src/domain/aggregation.test.ts test/sequence/conformance.test.ts
```

Extend `src/domain/outcome.test.ts`, whose suite is `src/domain/outcome.test` at
`src/domain/outcome.test.ts:9` — `describe`. It imports production code only and uses
`assert.deepEqual` for a whole result object, per `src/domain/outcome.test.ts:21` — `deepEqual`.
Extend `src/domain/aggregation.test.ts`, whose error cases are `src/domain/aggregation.test.ts:118` —
`empty-parent` and `:138` — `invalid-child-state`.

Add, each as a separate `it`:

1. `"parentObjectiveOutcome returns the declared state and trigger for every terminalStates value"` —
   iterate `terminalStates` from `src/domain/state.ts:20` — `terminalStates`, and
   `assert.deepEqual(parentObjectiveOutcome(projected), expected[projected])` against a literal table
   holding exactly `done` and `partial` mapped to
   `{ state: "awaiting_approval", trigger: "objective-aggregated-awaiting-approval" }` and
   `discarded` mapped to `{ state: "discarded", trigger: "objective-aggregated-discarded" }`. Assert
   `assert.equal(terminalStates.length, 3)` and `assert.deepEqual(Object.keys(expected).sort(), [...terminalStates].sort())`
   in the same case, so a fourth terminal state fails rather than being skipped. This is the epic's
   gate row 1.

2. `"objectiveOutcome returns awaiting_approval for every terminalStates value"` — **replace**
   `src/domain/outcome.test.ts:20` — `"done"`, `:27` — `"partial"` and `:34` — `"discarded"` with this
   one case. Iterate `terminalStates` and
   `assert.deepEqual(objectiveOutcome(projected), { state: "awaiting_approval", blockReason: null })`
   for each. The `discarded` iteration is the one that supersedes
   `src/domain/outcome.ts:19` — `discarded`, and it is asserted by value. This is the epic's gate
   row 2.

3. `"aggregate still throws empty-parent and invalid-child-state, and neither is a contract error code"`
   — in `src/domain/aggregation.test.ts`, assert `aggregate("objective", [])` throws with
   `err.code === "empty-parent"` and `aggregate("objective", ["partial"])` throws with
   `err.code === "invalid-child-state"`, using the try/catch idiom of
   `src/domain/aggregation.test.ts:121` — `assert.fail`. Then assert
   `Object.hasOwn(errorStatuses, "empty-parent")` and
   `Object.hasOwn(errorStatuses, "invalid-child-state")` are both `false` against `errorStatuses` at
   `src/http/contract/errors.ts:7` — `errorStatuses`. **The control is in the same case**: assert
   `Object.hasOwn(errorStatuses, "subtree-busy")` is `true`, so the lookup is proven to find a code
   that is there. `src/http/contract/errors.ts:29` — `subtree-busy` is that shipped code. This is the
   epic's gate row 3.

4. `"authoredEpics ends with 053 and shippedEpics is still its prefix"` — extend
   `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics` rather than
   adding a case beside it: append `"053"` to the pinned literal at `:272`, and leave
   `assert.deepEqual(shippedEpics, ["050", "050.1"])` at `:274` unchanged. The existing
   `assert.deepEqual(authoredEpics.slice(0, shippedEpics.length), shippedEpics)` at `:275` is the
   prefix proof and needs no edit.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/outcome.test.ts`, `src/domain/aggregation.test.ts` and
`test/sequence/conformance.test.ts` in `PASS EPIC-053`.
