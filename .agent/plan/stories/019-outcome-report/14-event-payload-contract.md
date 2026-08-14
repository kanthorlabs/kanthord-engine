# Story 14 — The typed event payload contract, total and self-policing

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Story 13. The two stories are one pair; implement 13 then 14 with no verify gate between them.

This is the second half of the EPIC bullet at `019-outcome-report.md:80-82`.

## The settled decision on `eventView.payload`

`019-outcome-report.md:52` and `:80` are amended and now read: **`src/http/contract/event.ts:26` keeps `payload: z.unknown()`.** The schemas reach a client as named OpenAPI components, which is what makes the shape public.

The reason is one incompatibility. `eventView.type` stays `z.string()` so `event.list` serves a row an earlier build wrote, and that row carries a payload of that build's shape. A closed union of the **current** shapes rejects it, so a typed `eventView.payload` would fail `event.list` on exactly the history the string type exists to serve. The route's runtime parse was never what published the contract.

Two consequences for this story: the `event.ts` edit is a no-op, and `src/http/contract/field-decisions.fixture.ts` gains no `event.list` row.

## Change

### A new `src/http/contract/event-payload.ts`

It imports `z` from `zod`, and `eventTypes` and `type EventType` from `../../domain/event-type.ts`.

It exports one schema per member of `eventTypes`, then the map, then the union. A schema is a `z.strictObject`, or a `z.union` whose every branch is a `z.strictObject` when one event type has two producers with different payloads. **Strictness is a property of every branch**, not of the top-level node.

```ts
export const eventPayloads: Readonly<Record<EventType, ZodType>> = { ... };
export const eventPayload = z.union([ ... ]);
```

`eventPayloads` is keyed by event type, in `eventTypes` order. `eventPayload` lists the same schemas in `eventTypes` order.

**Each schema is transcribed, not designed.** For every member, open the producer that appends it, read the `payload` object literal, and write a `z.strictObject` whose keys are exactly those keys, in the producer's key order, with the zod type the producer's value has: a `string` for a string, `z.number().int()` for an integer, `.nullable()` where the producer writes `null` on any branch, `z.enum` where the producer writes a value from a closed domain vocabulary, and `objectId` of `src/domain/column.ts:6` for every object id. Transcribe, do not invent, and add no key the producer does not write.

The five schemas of this epic are fixed here and are not transcribed:

```ts
"outcome.reported": z.strictObject({
  runId: z.string(),
  attemptId: z.string(),
  attemptNo: z.number().int(),
  outcome: z.enum(taskReportOutcomes),
  reason: z.string().nullable(),
  objectId: objectId.nullable(),
  attemptsRemaining: z.number().int(),
  fromState: z.enum(nodeStates),
  toState: z.enum(nodeStates),
}),
"node.awaitingApproval": z.strictObject({
  from: z.enum(nodeStates),
  to: z.enum(nodeStates),
  reason: z.literal("object-attested"),
  objectId: objectId,
  projection: z.enum(terminalStates),
  objectiveRunId: z.string(),
}),
```

`node.done` and `node.partial` are each written by two producers — `closeObjective` of Story 11 and `aggregateInitiative` of Story 10 — so each schema is a `z.union` of the close shape and the roll-up shape:

```ts
const closePayload = z.strictObject({
  from: z.enum(nodeStates),
  to: z.enum(nodeStates),
  reason: z.literal("human-close"),
  objectId: objectId,
  objectiveRunId: z.string(),
  acknowledgePartial: z.boolean(),
});
const rollUpPayload = z.strictObject({
  from: z.enum(nodeStates),
  to: z.enum(nodeStates),
  reason: z.literal("objectives-terminal"),
  objectiveStates: z.array(z.enum(terminalStates)),
});
```

`node.done` and `node.partial` are each `z.union([closePayload, rollUpPayload])`. `node.discarded` is `rollUpPayload` alone, because no close writes `discarded`.

Two payload schemas of equal shape are legal, and the union resolves to the first match. A payload is data a client reads and never a dispatch key, so that ambiguity costs nothing.

### `src/http/contract/event.ts` — do not edit it

Leave all three declarations as they are:

- `payload: z.unknown()` at `:26`;
- `eventView.type` at `:21`, `z.string()`;
- `eventListRequest.type` at `:14`, `z.string().min(1).optional()`.

A migrated database holds the history of every earlier build, and a read route must serve it.

### `src/http/contract/field-decisions.fixture.ts` — no change from this story

`eventView` is untouched, so the derived `event.list.response` rows are unchanged and `src/http/contract/coverage.test.ts` stays green with the fixture as it is. Story 18 owns the only fixture growth of this epic, from the `node.report` rows.

### `src/http/contract/openapi.ts`

Register `eventPayloads` so each schema emits as its own named component. Follow whatever component-registration path that file already uses for a named schema; add no second mechanism, and add no path or operation. `npm run contract:publish` then carries one component per event type.

## Constraints

- Every schema is a `z.strictObject` or a union of `z.strictObject` branches. A tenth key on `outcome.reported` must fail.
- Add no schema for a type absent from `eventTypes`, and leave no member of `eventTypes` without a key in `eventPayloads`.
- A payload schema **widens and never narrows**. Never remove a key; a later epic adds an optional key instead.
- `src/http/contract/` imports no koa. This file imports `zod` and `domain/` only.
- Do not touch `src/services/event/index.ts`. `AppendEventInput.payload` stays `unknown` at the service boundary.
- Do not touch `src/http/contract/event.ts` and do not touch `src/http/contract/field-decisions.fixture.ts`.
- Do not make the union a discriminated union on `type`. The payload holds no `type` key.

## Verify

Create `src/http/contract/event-payload.test.ts`, suite name `"src/http/contract/event-payload.test"`.

**The honesty mechanism.** One test scans the source tree and compares three sets.

- The scan reads every `.ts` file that is not a `.test.ts` under `src/commands/` and `src/services/`, recursively, through `node:fs`. It collects every double-quoted string literal in each file that matches the event-type grammar `/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/`. The scope covers `src/services/` and not `src/services/event/` alone, because `src/services/readiness/dependency.ts` writes `node.ready` and `node.pending`.
- The scan is a **text heuristic and a backstop**, so the two assertions below are one-sided by design. It cannot see `const t = "node.ready"; append({ type: t })`, a single-quoted literal, or a computed expression. Do not write a producer in one of those forms; the append site names its type as a double-quoted literal, exactly as every producer does today, including the ternary at `src/commands/startup/recover-expired-leases.ts:157-160`.
- `it("every scanned candidate that names an event type is declared", ...)` — the scanned set **intersected** with the grammar is a **subset** of `eventTypes`: every scanned literal that is not a member of `eventTypes` fails the test and names its file. This is the direction that catches a producer appending an undeclared type.
- `it("every declared type except the retired ones is produced", ...)` — `eventTypes` minus `retiredEventTypes` is a subset of the scanned set. This is the direction that catches a member with no producer. Together the two assertions replace a bare equality, which an append-only registry can never satisfy.
- `it("the eventPayloads keys equal eventTypes", ...)` — exact set comparison between `Object.keys(eventPayloads)` and `eventTypes`, in both directions. Every declared type carries a schema, retired ones included, because a retired type still sits in the history the route serves.
- `it("the scan read at least one file", ...)` — assert the file count is greater than `20`, and assert the scan visited `src/commands/plan/import-plan.ts` and `src/services/readiness/dependency.ts` by name.
- `it("the scan reports an undeclared nineteenth type", ...)` — run the scan function over a temporary directory holding one fixture file that appends a type absent from `eventTypes`, and assert the returned set contains it. Do not write that fixture under `src/`.
- `it("a key in eventPayloads that eventTypes does not hold is a failure", ...)` — build a local copy of the map with one extra key and assert the same comparison function reports it.
- `it("eventPayloads holds one schema per member", ...)` — iterate `eventTypes` and assert `eventPayloads[type] !== undefined`. Iterate by member, never by count.
- `it("every recorded payload parses through its own schema", ...)` — one recorded payload **per distinct producer shape**, taken from the fixture of the test that produces it, and not merely one per type. `node.done` and `node.partial` each need two fixtures, the close shape and the roll-up shape, because each has two producers. Declare the fixtures as literal objects in this file, keyed by type and holding an array of shapes, and assert `eventPayloads[type].parse(fixture)` does not throw for every shape. Assert the fixture map covers every member of `eventTypes`, and assert the shape count for `node.done` and `node.partial` is `2`.
- `it("an outcome.reported payload with a tenth key fails", ...)` — assert the parse throws.
- `it("eventView parses every recorded payload", ...)` — build a whole `eventView` object per fixture shape and assert `eventView.parse(...)` succeeds.
- `it("event.list still serves a row an earlier build wrote", ...)` — parse an `eventView` whose `type` is `"legacy.somethingRemoved"` **and whose payload matches no schema of `eventPayloads`**, for example `{ legacyKey: 1 }`, and assert it succeeds. This is the assertion that keeps `eventView.payload` at `z.unknown()` honest. A test that pairs a legacy `type` with a current payload shape proves nothing and must not be written.
- `it("each payload schema emits as a named component", ...)` — emit the master document the way `src/http/contract/openapi.test.ts` does and assert one component exists per member of `eventTypes`, iterated by member and never by count.
- Also run and keep green: `node --test src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts`.
- `node --test src/http/contract/event-payload.test.ts src/http/contract/event.test.ts` exits 0.
- `npm run verify` exits 0, which includes the OpenAPI emit; each schema becomes its own named component.
- Proof: `src/http/contract/event-payload.test.ts` and `src/http/contract/event.test.ts`. Hermetic coverage: `019-outcome-report.md:175`, `:176`, `:177` and `:178`.
