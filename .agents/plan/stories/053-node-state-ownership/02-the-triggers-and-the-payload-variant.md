# Story 2 — The triggers and the payload variant

Epic: `.agents/plan/epics/053-node-state-ownership.md`
Depends on: Story 1 (`01-the-parent-objective-outcome`), for the two trigger literals
`parentObjectiveOutcome` returns, which case 3 binds to `internalTriggerIds`.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

**Both edits are what make Story 6 (`06-the-aggregation-reaches-the-human-gate`) and Story 7
(`07-the-aggregation-discards-and-rolls-the-initiative-up`) able to write at all.**
`src/services/plan/sqlite.ts:515` — `triggerTransition` resolves the write's trigger and throws when
its declared `from` and `to` disagree, and `src/services/plan/sqlite.ts:521` — `levels` throws when
the declared level list does not hold the node's kind. A `setNodeState` on an objective naming an
`initiative-aggregated-*` id therefore throws, and no id in the shipped table fits.

## Change

**Add two rows to `src/domain/node-trigger.ts`.** Both are internal, because the daemon derives the
transition from committed child state and no external report names it.
`src/domain/external-transition.ts:215` — `externalTriggerConsumer` maps external ids to the command
that writes them, and neither id belongs there.

### 1 — the two ids

**Edit `src/domain/node-trigger.ts` to insert two entries into `internalTriggerIds`**, between
`src/domain/node-trigger.ts:20` — `run-cancelled-abandoned` and `:21` —
`initiative-aggregated-done`:

```ts
  "objective-aggregated-awaiting-approval",
  "objective-aggregated-discarded",
```

The position is the aggregation order of the product: a parent objective aggregates from its tasks,
and only then does an initiative aggregate from its objectives. The tuple grows from sixteen to
eighteen.

### 2 — the two transition rows

**Edit `src/domain/node-trigger.ts` to insert two rows into `internalTransitions`**, at the same
index, between `src/domain/node-trigger.ts:101` — `run-cancelled-requeued`'s successor row and `:109`
— `initiative-aggregated-done`:

```ts
  {
    levels: ["objective"],
    from: "running",
    to: "awaiting_approval",
    trigger: "objective-aggregated-awaiting-approval",
  },
  {
    levels: ["objective"],
    from: "running",
    to: "discarded",
    trigger: "objective-aggregated-discarded",
  },
```

**The index must match the id tuple exactly.**
`src/domain/node-trigger.test.ts:148` — `row.trigger` asserts
`internalTransitions.map((row) => row.trigger)` deep-equals `[...internalTriggerIds]`, so the two
insertions are one edit at one position and never two positions.

**Both cells are already in the transition matrix, and this story adds no row to it.**
`src/domain/transition.ts:154` — `objective` is `true` on the `running -> awaiting_approval` row that
opens at `:150`, and `src/domain/transition.ts:178` — `objective` is `true` on the
`running -> discarded` row that opens at `:174`. `src/domain/transition.ts:468` — `canTransition`
therefore already admits both, and `src/services/plan/sqlite.ts:510` — `canTransition` passes without
a matrix edit. Do not touch `src/domain/transition.ts`.

**`levels` is `["objective"]` and holds nothing else.** `src/domain/transition.ts:162` — `objective`
and `:170` — `objective` both refuse a `running` objective reaching `done` or `partial`, with the note
"an objective always passes the human gate", and an initiative aggregating to `awaiting_approval` is
not a state the matrix admits at `src/domain/transition.ts:155` — `initiative`.

### 3 — the payload variant

**Edit `src/http/contract/event-payload.ts` to add `taskRollUpPayload`**, after
`src/http/contract/event-payload.ts:51` — the close of `rollUpPayload`:

```ts
const taskRollUpPayload = z.strictObject({
  from: nodeState,
  to: nodeState,
  reason: z.literal("tasks-terminal"),
  taskStates: z.array(terminalState),
  projection: terminalState,
});
```

`nodeState` and `terminalState` are the file's own local schemas at
`src/http/contract/event-payload.ts:30` — `nodeState` and `:31` — `terminalState`. `reason` is
`tasks-terminal`, mirroring `src/http/contract/event-payload.ts:49` — `objectives-terminal` one level
down.

### 4 — the two unions

**Edit `src/http/contract/event-payload.ts` to name the shipped attestation object.** Lift the inline
object of `src/http/contract/event-payload.ts:106` — `node.awaitingApproval` to a const beside
`rollUpPayload`, with every field unchanged:

```ts
const attestedPayload = z.strictObject({
  from: nodeState,
  to: nodeState,
  reason: z.literal("object-attested"),
  objectId,
  projection: terminalState,
  objectiveRunId: z.string(),
});
```

Then the two registry entries become:

```ts
  "node.awaitingApproval": z.union([attestedPayload, taskRollUpPayload]),
```

```ts
  "node.discarded": z.union([rollUpPayload, taskRollUpPayload]),
```

`src/http/contract/event-payload.ts:125` — `node.done` and `:130` — `node.partial` are the shipped
precedent for a plain `z.union` in this registry, and neither uses `z.discriminatedUnion`. Follow
them.

**The union is the only shape that admits both writers.** `attestedPayload` requires `objectId` and
`objectiveRunId`, and a parent objective holds neither: it carries no attested object of its own, and
`src/commands/outcome/aggregate-objective.ts` reads no run. Widening the shipped object with two
optional fields would let an attestation omit the object id, which
`src/commands/outcome/report-objective.ts:184` — `objectId: input.objectId` always supplies.

**No event type joins the registry.** `src/domain/event-type.ts:7` — `node.awaitingApproval` and
`:10` — `node.discarded` both ship, `src/domain/event-type.ts:45` — `retiredEventTypes` stays empty,
and the catalogue at `src/http/contract/openapi.ts:233` — `eventPayloadCatalogue` is keyed by type,
so its key count and its key order do not move.

## Constraints

- `internalTriggerIds` and `internalTransitions` take their two entries at the same index. Their order
  is one order.
- Do not edit `src/domain/transition.ts`. Both cells are already legal at the objective level.
- Do not add either id to `src/domain/external-transition.ts:215` — `externalTriggerConsumer`. Both
  are internal, and `src/domain/external-transition.test.ts:582` — `holds no internal trigger id as a key`
  refuses it.
- `attestedPayload` is a lift, not a rewrite. Its six fields keep their names, their schemas and their
  order.
- `taskRollUpPayload` is a `z.strictObject`. An unknown key must fail, because case 5 is what proves
  it.
- **The emitted component count does not move, and it stays `158`.**
  `src/http/contract/openapi.ts:60` — `Object.entries(eventPayloads)` converts **one entry at a
  time**, so no schema is hoisted across entries, and `z.toJSONSchema` of a `z.union` of two
  `strictObject`s emits a bare `anyOf` with both members inlined and no `$defs`. No new component name
  appears, so `src/http/contract/openapi.test.ts:477` — `assert.equal(Object.keys(schemas).length` is
  unchanged. Case 7 asserts it. **A moved number is a defect to report, never a number to update.**

## Verify

```
node --test src/domain/node-trigger.test.ts src/http/contract/event-payload.test.ts src/domain/external-transition.test.ts src/http/contract/openapi.test.ts
```

Extend `src/domain/node-trigger.test.ts`, whose module-level `expected` table at
`src/domain/node-trigger.test.ts:16` — `expected` re-declares every row independently and must take
the two new rows at the same index. Extend `src/http/contract/event-payload.test.ts`, whose
`recordedPayloads` table at `src/http/contract/event-payload.test.ts:50` — `recordedPayloads` is keyed
by event type to an **array** of shapes, one per union member, and whose key order is pinned to
`eventTypes` at `:499` — `Object.keys`.

Add, each as a separate `it`:

1. `"internalTriggerIds and internalTransitions hold eighteen entries in one order"` — extend
   `src/domain/node-trigger.test.ts:118` — `sixteen trigger ids` and `:144` — `sixteen rows` rather
   than adding cases beside them. Raise `assert.equal(internalTriggerIds.length, 16)` at `:119` and
   `assert.equal(internalTransitions.length, 16)` at `:145` to `18`, raise
   `assert.equal(new Set(internalTriggerIds).size, 16)` at `:141` to `18`, and insert the two literals
   into the pinned list at `:120` and the two rows into `expected` at `:16`, each at the index the
   `## Change` names. `assert.deepEqual(internalTransitions.map((row) => row.trigger), [...internalTriggerIds])`
   at `:147` is the order proof and needs no edit.

2. `"each objective aggregation trigger resolves to objective, running and its declared target"` —
   `assert.deepEqual(triggerTransition("objective-aggregated-awaiting-approval"), { levels: ["objective"], from: "running", to: "awaiting_approval" })`
   and
   `assert.deepEqual(triggerTransition("objective-aggregated-discarded"), { levels: ["objective"], from: "running", to: "discarded" })`,
   both by value. Then, in the same case, assert
   `triggerTransition(id).levels.includes("task")` and `triggerTransition(id).levels.includes("initiative")`
   are each `false` for both ids, which is the level restriction proven in the refusing direction.
   **The control for that negative is in the same case**: assert
   `triggerTransition("initiative-aggregated-discarded").levels.includes("initiative")` is `true`, so
   the membership test is proven to find a level that is declared. This is the epic's gate row 4.

3. `"parentObjectiveOutcome names only trigger ids the internal table declares"` — import
   `parentObjectiveOutcome` from `src/domain/outcome.ts` and, for every `terminalStates` value, assert
   `internalTriggerIds.includes(parentObjectiveOutcome(projected).trigger)` is `true`, and that
   `triggerTransition` of that trigger returns a `to` equal to `parentObjectiveOutcome(projected).state`.
   This is what binds Story 1 (`01-the-parent-objective-outcome`)'s literal union to this story's
   table, and it fails if either text moves alone.

4. `"the union of the external and internal id sets holds twenty-eight ids"` — extend
   `src/domain/node-trigger.test.ts:180` — `disjoint` and raise `assert.equal(union.size, 26)` at
   `:189` to `28`. Also extend `src/domain/node-trigger.test.ts:225` — `covers every pair` so its
   pinned sorted list gains `"objective|running|awaiting_approval"` and
   `"objective|running|discarded"` at their sorted positions, taking the list from twenty to
   twenty-two members. `src/domain/node-trigger.test.ts:168` — `names a legal cell` needs no edit,
   because both cells already pass `canTransition` at the objective level.

5. `"a tasks-terminal payload parses against node.awaitingApproval and against node.discarded"` — add
   a second shape to `recordedPayloads["node.awaitingApproval"]` at
   `src/http/contract/event-payload.test.ts:91` and to `recordedPayloads["node.discarded"]` at `:107`,
   each `{ from: "running", to: <the target>, reason: "tasks-terminal", taskStates: ["done", "discarded"], projection: <the value> }`.
   Assert `eventPayloads["node.awaitingApproval"].parse(shape)` and
   `eventPayloads["node.discarded"].parse(shape)` each do not throw. Extend
   `src/http/contract/event-payload.test.ts:500` — `node.done` with
   `assert.equal(recordedPayloads["node.awaitingApproval"]?.length, 2)` and the same for
   `"node.discarded"`, so the union arity is pinned the way the two shipped unions are. This is half
   of the epic's gate row 5.

6. `"the shipped object-attested payload still parses, and a tasks-terminal payload carrying objectId is refused"`
   — assert `eventPayloads["node.awaitingApproval"].parse(<the shipped six-field object-attested shape>)`
   does not throw, which is the half of gate row 5 that proves the lift changed nothing. Then
   `assert.throws(() => eventPayloads["node.awaitingApproval"].parse({ …the tasks-terminal shape, objectId: "a".repeat(40) }))`
   and the same against `"node.discarded"`. **The refusal is the control that the union stayed
   strict**: neither member admits the extra key, so no shape passes by matching the other arm.

7. `"the two unions add no OpenAPI component and the catalogue keeps its thirty-nine keys"` — assert
   `Object.keys(buildOpenApiDocument().components.schemas).length` is `158`, unchanged, and that the
   emitted `node.awaitingApproval` and `node.discarded` schemas each hold an `anyOf` of exactly two
   members and no `$defs`. Assert in the same case that the catalogue key count at
   `src/http/contract/openapi.test.ts:417` — `39` is unchanged. This settles the generated-artifact
   question before dispatch rather than at build time.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/node-trigger.test.ts` and
`src/http/contract/event-payload.test.ts` in `PASS EPIC-053`.
`src/http/contract/openapi.test.ts` sits beyond the epic's Proof block and is named here because
case 7 asserts the generated closure this story's unions produce.
