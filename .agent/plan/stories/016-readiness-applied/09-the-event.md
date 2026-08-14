# Story 9 — The event

Epic: `.agent/plan/epics/016-readiness-applied.md`
Depends on: Story 3. The two stories edit the same file; implement them as one pair.

## Change

### `src/services/readiness/dependency.ts`

Pin the append `DependencyReadiness.apply` makes for each transition it returns:

```ts
this.dependencies.events.append(transaction, {
  subjectKind: "node",
  subjectId: transition.nodeId,
  type: transition.to === "ready" ? "node.ready" : "node.pending",
  actorKind: "daemon",
  actorId: this.dependencies.instanceId,
  payload: {
    from: transition.from,
    to: transition.to,
    reason:
      transition.to === "ready"
        ? "dependency-satisfied"
        : "dependency-unsatisfied",
    revision: input.cause.revision,
    importId: input.cause.importId,
  },
});
```

Every field is fixed:

- `type` follows the direction. `pending → ready` appends `node.ready`. `ready → pending` appends `node.pending`. No third type exists.
- `actorKind` is the literal `"daemon"`. It is never an input.
- `actorId` is the daemon instance identity from the constructor. It is never an input of `apply`.
- The payload holds exactly five keys, in this key order: `from`, `to`, `reason`, `revision`, `importId`.
- `reason` is `"dependency-satisfied"` on a promotion and `"dependency-unsatisfied"` on a demotion.
- The append shares the caller's transaction, so a transition and its event never split.

One append per applied transition, in the order `deriveReadiness` returned.

## Constraints

- Add no sixth payload key and drop none of the five.
- Do not read `input.projectId` into the payload. `subjectId` names the node, and the revision names the write.
- Do not mint an id and do not read a clock. `SqliteEventLog.append` mints the event id from its own `IdGenerator` and derives `occurredAt` from the ULID.
- Do not append a project-level summary event. `plan.imported` at `src/commands/plan/import-plan.ts:481` is the only project-level event of an import.
- `ActorKind` accepts `"daemon"` today at `src/services/event/index.ts:3`, and EPIC 015 Story 11 widens the union without removing it. Do not edit that file.

## Verify

Add to `src/services/readiness/dependency.test.ts`, over the recording `EventLog` fake of Story 3.

- `it("a promotion appends node.ready with reason dependency-satisfied", ...)` — assert the whole recorded `AppendEventInput` with `assert.deepEqual` against the literal object, including `subjectKind: "node"`, `actorKind: "daemon"`, `actorId` equal to the constructed `instanceId`, and the five-key payload.
- `it("a demotion appends node.pending with reason dependency-unsatisfied", ...)` — assert the whole recorded input the same way.
- `it("actorId is the constructed instance identity and never an input", ...)` — construct two `DependencyReadiness` instances with different `instanceId` values over the same fake, run the same promotion through each, and assert the two recorded `actorId` values differ and each equals its own constructor value.
- `it("the payload carries the cause revision and importId", ...)` — drive `cause: { revision: "revision_x", importId: "import_x" }` and assert both payload values. Drive `cause: { revision: "revision_y", importId: null }` and assert `payload.importId === null`.
- `it("the payload holds exactly five keys in order", ...)` — assert `Object.keys(payload)` deep-equals `["from", "to", "reason", "revision", "importId"]`.
- `it("a mixed pass appends one node.ready and one node.pending", ...)` — assert the recorded `type` sequence on the mixed fixture of Story 2, in bytewise node order.
- `it("no transition appends no event", ...)` — assert `recorded.length === 0`.
- `node --test src/services/readiness/dependency.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/services/readiness/dependency.test.ts`.
