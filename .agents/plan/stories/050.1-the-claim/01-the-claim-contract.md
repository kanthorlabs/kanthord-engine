# Story 1 — The claim contract

Epic: `.agents/plan/epics/050.1-the-claim.md`
Depends on: EPIC 050 Story 5 and EPIC 050 Story 6 (the refusal shapes). Story 2 needs the `run.expired` event type, and Stories 3 to 5 need the request field; implement this story before all four.
Kind: story-foundation

This story carries the `node.claim` half of the wire. EPIC 050.2 Story 7 carries `node.renew`,
`node.release` and `node.report`, and Story 8 of that epic carries the capability announcement for
both halves.

## Change

### 1 — the request and the response

`src/http/contract/execution.ts:29-58`:

- `nodeClaimRequest` (`:29`) becomes `z.strictObject({ available: z.boolean() })`. It is a **required** field: a caller that does not state its availability has not run the self health check the daemon relies on.
- `nodeClaimResponse` (`:39-48`) keeps `runId: identity("run")` and `objectiveRunId: identity("run")` and gains `fence: z.int().min(1)`, `expiresAt: z.int()` and `renewAfterMs: z.int().min(1)`. `node.claim` returns these fields and receives none.
- `nodeClaimResponse` **loses `heartbeatIntervalMs`**. It is `Math.floor(leaseTtlMs / 3)` at `src/commands/node/claim-node.ts:356`, derived from a lease this block replaces. An absolute `expiresAt` alone is not a sufficient replacement: a worker comparing a server timestamp against its own clock renews late under skew or network delay. `renewAfterMs` is `Math.floor(runTtlMs / 3)`, and a worker renews after it and treats `expiresAt` as the deadline.

Update the example literal `nodeClaimExamples.request` at `src/http/contract/execution.ts:89` and its response counterpart. `src/http/contract/example.test.ts:73-142` parses each against its schema.

Do not add `runId` or `runFence` to `node.claim`'s request. A claim comes before the run.

### 2 — the claim refusal codes

Add the five claim refusals to `src/http/contract/errors.ts:7-31`, in this order, appended to the end of the 409 group after `"host-key-mismatch"` at `:23`:

```
"pair-illegal", "assignment-held", "unroutable", "review-head-unavailable",
"objective-busy", "subtree-busy"
```

Every one is a **409 precondition**. `httpError` at `src/http/contract/errors.ts:95-111` requires a `details` argument for each, so add a details schema per code to `src/http/contract/error-details.ts`, shaped exactly as the command throws it in Stories 3 to 5:

| code                      | details                                                   |
| ------------------------- | --------------------------------------------------------- |
| `pair-illegal`            | `{ kind, deliverable }`                                   |
| `assignment-held`         | `{ assignment, claimant, maySwitch }`                     |
| `unroutable`              | `{ failedSet }`                                           |
| `review-head-unavailable` | `{ nodeId, runKind }`                                     |
| `objective-busy`          | `{ objectiveId, siblingNodeId, siblingRunId, expiresAt }` |
| `subtree-busy`            | `{ relation, nodeId, runId, expiresAt }`                  |

Delete `initiative-not-claimable` and `run-driver-mismatch` from `errors.ts`, their details schemas and their `operationAdditions` entries. Stories 3 and 4 delete the code that raises them.

Register the new codes on `node.claim`'s `errors` record in `execution.ts`, and add each to `operationAdditions` in `src/http/contract/coverage.test.ts:19-59`, which is the closed map of extra codes per operation.

Add matching rows to the error-code table in `docs/proposal/api/README.md` (section `## Errors`, `:222`). `src/http/contract/errors.test.ts:16-26` compares the key set and the status of every code against that table.

### 3 — the event types

Remove `"lease.claimed"` from `src/domain/event-type.ts`, and add `"run.expired"` and `"run.opened"` in their bytewise positions. An event is an observability contract, not a mechanism contract, and a reader of `event.list` should never learn that the daemon changed its internal exclusion mechanism. There are no deployments, so there is no stored event to keep readable and `retiredEventTypes` stays empty. EPIC 050.2 Story 7 removes the two remaining `lease.*` types.

Add both payloads to `eventPayloads` in `src/http/contract/event-payload.ts:71`, in the same bytewise positions. The record is typed `Readonly<Record<EventType, ZodType>>`, so omitting one fails type checking:

```ts
"run.expired": z.strictObject({
  runId: z.string(),
  nodeId: z.string(),
  fence,
  expiredAt: z.number().int(),
}),
"run.opened": z.strictObject({
  runId: z.string(),
  nodeId: z.string(),
  fence,
  kind: z.string(),
  worker: z.string(),
  expiresAt: z.number().int(),
}),
```

`fence` is the shared alias declared at `src/http/contract/event-payload.ts:29-35`. Each payload shape is exactly what Story 2 and Story 3 append.

### 4 — the `assignment` projection

EPIC 050 Story 4 adds `assignment` to `nodeRow` and `StoredNode`. Add it to the node projection in `src/http/contract/graph.ts` so `node.show` and `project.graph` return it, typed `workerId.nullable()`.

## Constraints

- `available` is required on `node.claim`.
- Do not add `runId` or `runFence` to `node.claim`'s request.
- Do not touch `node.renew`, `node.release` or `node.report`. EPIC 050.2 owns all three, including the `node.heartbeat` rename.
- Keep the registry at 73 operations and 48 routed. This story adds no operation.
- Every new error code is 409, appended in the stated order at the end of the 409 group.
- `heartbeatIntervalMs` appears in no `node.claim` schema and in no claim production file when this story ends.

## Verify

```
node --test src/http/contract/errors.test.ts src/http/contract/example.test.ts src/http/contract/coverage.test.ts src/http/contract/event-payload.test.ts src/http/contract/graph.test.ts src/http/contract/registry.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts
```

Add, each as a separate `it`:

1. `"a node.claim request omitting available fails validation"` — assert the issue path is `["available"]`.

2. `"nodeClaimResponse carries runId, fence, expiresAt and renewAfterMs"` — parse the example and assert all four, and assert `fence >= 1`.

3. `"heartbeatIntervalMs is absent from nodeClaimResponse"` — assert the key set holds no such key. With case 2 the replacement is proven complete rather than additive.

4. `"run.opened and run.expired are registered in bytewise order"` — assert both are members, assert `eventTypes` holds no `"lease.claimed"`, assert `retiredEventTypes` is empty, and assert the list equals its own `Buffer.compare` sort.

5. `"the run.opened payload matches what the claim appends"` — parse `{ runId, nodeId, fence: 1, kind: "execution", worker: "claude@1", expiresAt: 1700000300000 }` and assert success; parse one omitting `worker` and assert failure.

6. `"the run.expired payload matches what the expiry pass appends"` — parse `{ runId, nodeId, fence: 4, expiredAt: 1700000000000 }` and assert success; parse one omitting `fence` and assert failure.

7. `"every claim refusal code maps to 409"` — assert `errorStatuses[code] === 409` for each of the six, and update the pinned key array at `:28-54` and the 409 group at `:94-128`.

8. `"initiative-not-claimable and run-driver-mismatch are absent from the error codes"` — assert both are gone from `errorStatuses`, from `error-details.ts` and from `operationAdditions`.

9. `"the error code table and the proposal agree"` — the shipped `readErrorCodeMatrix()` case at `:16-26` covers it once `docs/proposal/api/README.md` carries the new rows.

10. `"node.show returns the assignment"` — parse a projection carrying `assignment: "claude@1"` and one carrying `null`, asserting both succeed, and one carrying a value outside the worker id grammar, asserting failure.

`pnpm run verify` exits 0. It emits and validates the master OpenAPI document and every feature slice in a temporary directory, so a schema or component drift fails there too.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.1`.
