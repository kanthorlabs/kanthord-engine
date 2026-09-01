# Story 7 — The worker contract

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: Story 1 (`runAuthorityRefusals`). Stories 3 to 6 need this story's request fields and event types; implement this story before all four.
Kind: story-foundation

EPIC 050.1 Story 1 already carried the `node.claim` half of the wire: `available`, the claim response
fields, `run.opened`, `run.expired` and the claim refusal codes. This story carries everything else,
and after it the worker protocol is one shape.

## Change

### 1 — the `renew` path segment

`src/http/contract/path.ts:40-65` holds `actionSegments`, a bytewise-sorted closed array of 24 values. Insert `"renew"` between `"rename"` and `"report"` — `"rename" < "renew"` because `a` (0x61) precedes `e` (0x65) at the fourth character, and `"renew" < "report"` because `n` precedes `p`. Do not remove `"heartbeat"`; it stays in the closed set as an unused segment, and removing a segment is not what this epic asks for.

Update `src/http/contract/path.test.ts:40` from `assert.equal(actionSegments.length, 24)` to `25`. The sorted-and-unique guard at `:23-35` then re-verifies the insertion point. Add one case in the file's convention (`:167`, `:187`): `"renew is an action segment sorted between rename and report"`.

### 2 — `node.heartbeat` becomes `node.renew`

In `src/http/contract/execution.ts:265-283`, change `operationId` to `"node.renew"` and the path to `[resource("node"), parameter("node"), action("renew")]`. Rename `nodeHeartbeatRequest` (`:31-33`), `nodeHeartbeatResponse` (`:50-54`) and `nodeHeartbeatExamples` (`:129-159`) to `nodeRenewRequest`, `nodeRenewResponse` and `nodeRenewExamples`. The old operation id is removed, not kept beside the new one.

### 3 — the request and response fields

`src/http/contract/execution.ts:29-58`:

- `nodeRenewRequest` gains `runId: identity("run")` and `runFence: z.int().min(1)` as **required** fields, beside the shipped lease `fence`. The run fence is named `runFence` to keep the two distinct, matching the command inputs of Story 3.
- `nodeRenewResponse` gains `expiresAt: z.int()` and `renewAfterMs: z.int().min(1)`, the same two fields EPIC 050.1 put on the claim response, and **loses `heartbeatIntervalMs`**.
- `nodeReleaseRequest` (`:35-37`) gains the same two required fields.
- `nodeReportRequest` in `src/http/contract/outcome.ts:23-53` is a six-member discriminated union. Add `runId` and `runFence` as required fields to **all six** members, including the `closed` member at `:49-52` which carries no lease `fence` today. A worker that cannot name its run has no authority to write, so the schema says so rather than a refusal code.

Update every example literal that these schemas parse: `nodeRenewExamples.request` at `:130`, `nodeReleaseExamples.request` at `:162`, and `nodeReportExamples.request` at `src/http/contract/outcome.ts:75`. `src/http/contract/example.test.ts:73-142` parses each against its schema.

**`heartbeatIntervalMs` is removed, not renamed.** It is `Math.floor(leaseTtlMs / 3)` at `src/commands/node/claim-node.ts:356`, derived from a lease this block replaces, and the epic states its replacement: `expiresAt` as the deadline and `renewAfterMs` as the relative hint. EPIC 050.1 removed it from the claim response; this story removes its last producer and every remaining site listed in section 5b. A response field removal is outside the closed list of `docs/proposal/api/README.md:100`, which is exactly what Story 8's policy amendment and capability retirement authorise.

### 4 — the error codes

Add the six authority codes plus `lifetime-exceeded` to `src/http/contract/errors.ts:7-31`. EPIC 050.1 Story 1 already added the five claim refusals. The ordering convention is ascending HTTP status, and within a status group the proposal table's order — `src/http/contract/errors.test.ts:28-54` pins the exact key array and `:94-128` pins the per-status grouping.

Every new code is a **409 precondition**, appended to the end of the 409 group, in this order:

```
"run-not-found", "run-ended", "run-expired", "run-caller-mismatch",
"target-outside-run", "fence-stale", "lifetime-exceeded"
```

`run-not-found` is 409 and not 404: the run exists in the caller's hand and the daemon refuses its authority, which is a precondition failure, not a missing resource. Every 409 is a `PreconditionCode`, and `httpError` at `src/http/contract/errors.ts:95-111` then **requires** a `details` argument for each — which matches Story 1, where every refusal carries `{ runId }`.

Add a details schema per code to `src/http/contract/error-details.ts`, shaped exactly as the command throws it in Stories 3 to 6. Register the new codes on the three operations' `errors` records in `execution.ts` and `outcome.ts`, and add each to `operationAdditions` in `src/http/contract/coverage.test.ts:19-59`, which is the closed map of extra codes per operation.

Add matching rows to the error-code table in `docs/proposal/api/README.md` (section `## Errors`, `:222`). `src/http/contract/errors.test.ts:16-26` compares the key set and the status of every code against that table, so the code list and the document must agree.

### 5 — the event types

Remove `"lease.renewed"` and `"lease.released"` from `src/domain/event-type.ts`, and add `"run.ended"` and `"run.renewed"` in their bytewise positions. EPIC 050.1 already removed `"lease.claimed"` and added `"run.opened"` and `"run.expired"`, so after this story no `lease.*` type remains and `retiredEventTypes` is still empty: there are no deployments, so there is no stored event to keep readable.

Add both payloads to `eventPayloads` in `src/http/contract/event-payload.ts`, in the same bytewise positions. The record is typed `Readonly<Record<EventType, ZodType>>`, so omitting one fails type checking:

```ts
"run.ended": z.strictObject({
  runId: z.string(),
  nodeId: z.string(),
  fence,
  outcome: z.string(),
  reason: z.string().nullable(),
}),
"run.renewed": z.strictObject({
  runId: z.string(),
  nodeId: z.string(),
  fence,
  expiresAt: z.number().int(),
}),
```

`fence` is the shared alias declared at `src/http/contract/event-payload.ts:29-35`. Each payload shape is exactly what Story 3 and Story 5 append.

### 5b — every remaining site, enumerated by grep

The list above is the contract package only. Run `grep -rn "heartbeat\|Heartbeat" src docs/proposal` and change every hit. As of authoring there are 35 files beyond the four renamed modules. Each of these is a site the fan-out above does not reach, and an unlisted one fails `pnpm run verify`:

| site                                                        | what it holds                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/http/contract/field-decisions.fixture.ts` (15 hits)    | one line per `node.heartbeat` request and response field                                                        |
| `src/main.claim.test.ts` (14 hits)                          | the end-to-end claim-and-heartbeat flow                                                                         |
| `src/http/contract/registry.test.ts` (10 hits)              | includes a **second** occurrence at `:1053-1060`, the seven-name harness-set case, beyond the lists named above |
| `docs/proposal/api/execution.md` (8 hits)                   | the route row **and** its surrounding prose                                                                     |
| `src/http/server/node/refusals.ts` (7 hits)                 | `import { HeartbeatNodeError }` at `:4`, the `instanceof` branch at `:35-36`, and `heartbeatRefusal` at `:173`  |
| `src/cli/reachability.test.ts` (6 hits)                     | CLI-command-to-operationId reachability                                                                         |
| `src/main.ts` (5 hits)                                      | the command import at `:83`, the handler import at `:157`, the handler map entry at `:560-561`                  |
| `src/http/contract/path.test.ts` (4 hits)                   | the three-name action-segment case                                                                              |
| `src/cli/inventory.test.ts` (4 hits)                        | the CLI inventory fixture                                                                                       |
| `src/http/contract/openapi.test.ts` (3 hits)                | the component list                                                                                              |
| `src/commands/node/claim-node.ts` (3 hits)                  | **`heartbeatIntervalMs` only** — removed by EPIC 050.1 Story 1                                                  |
| `src/cli/node/claim.test.ts` (3 hits)                       | the claim CLI output fixture                                                                                    |
| `src/http/server/node/claim-node.test.ts` (2 hits)          | `heartbeatIntervalMs` in the response fixture                                                                   |
| `src/http/contract/system.test.ts` (2 hits)                 | the third copy of the request and response lists                                                                |
| `src/commands/node/release-node.test.ts` (2 hits)           | imports the old command to build state                                                                          |
| `src/commands/node/claim-node.test.ts` (2 hits)             | `heartbeatIntervalMs` assertions                                                                                |
| `src/cli/program.ts` (2 hits)                               | `import { registerNodeHeartbeat }` at `:44` and the registration at `:378`                                      |
| `src/cli/program.test.ts` (2 hits)                          | the registered-command list                                                                                     |
| `src/cli/inventory.ts` (2 hits)                             | `path: ["node", "heartbeat"]` and `operationIds: ["node.heartbeat"]` at `:68-69`                                |
| `docs/proposal/phase-2/agents-and-workers.md` (2 hits)      | prose                                                                                                           |
| `docs/proposal/phase-1/README.md` (2 hits)                  | prose                                                                                                           |
| `src/main.test.ts`                                          | the production handler map                                                                                      |
| `src/http/server/app.handler-result.test.ts:44`             | the `["src/http/server/node/heartbeat-node.ts", [200]]` entry                                                   |
| `src/http/contract/proposal-amendment-execution.test.ts:39` | asserts a proposal sentence naming `POST /v1/node/:id/heartbeat` verbatim                                       |
| `src/http/contract/path.ts`                                 | the `actionSegments` entry, kept per section 1                                                                  |
| `src/http/contract/example.test.ts`                         | the examples list                                                                                               |
| `src/http/contract/coverage.test.ts`                        | `operationAdditions`                                                                                            |
| `src/http/contract/capability.ts`                           | the `external-drive` entry, retired by Story 8                                                                  |
| `src/http/contract/authorization.test.ts`                   | the second copy of the harness list                                                                             |
| `src/cli/parity.test.ts:99`                                 | the `"node heartbeat"` command-name row                                                                         |
| `src/cli/node/claim.ts:51`                                  | the claim CLI output string                                                                                     |
| `docs/proposal/phase-1/runtime-capability-matrix.md`        | the matrix row                                                                                                  |
| `docs/proposal/open-items.md`                               | prose                                                                                                           |
| `docs/proposal/memory/write-path.md`                        | prose                                                                                                           |

The registry total stays **73** and the routed total stays **48**: one operation is renamed, none is added and none is removed. Do not change the counts at `src/http/contract/registry.test.ts:49-51` and `:64-73`.

### 6 — the parity and matrix documents

- `docs/proposal/api/execution.md` — change the `node.heartbeat` row to `node.renew` with path `/v1/node/:id/renew`, keeping `phase-1` and `routed`. `src/http/contract/parity.test.ts:12-22` compares operationId, method, rendered path, `introducedIn` and `status` against every `*.md` under `docs/proposal/api/` except `README.md` and `new-decisions.md`, and pins the comparable count at **73** — unchanged by a rename.
- `docs/proposal/phase-1/runtime-capability-matrix.md` — rename the `node.heartbeat` row and move it to its bytewise position among the routed operations. `src/http/contract/runtime-matrix.test.ts:77-79` asserts the document rows equal the registry order, and `:81-92` asserts every row has exactly nine cells. The count stays **48** at `:72-75`.

## Constraints

- Add `"renew"` to `actionSegments`; do not remove `"heartbeat"`.
- Keep the registry at 73 operations and 48 routed. This story renames; it adds no operation.
- Every new error code is 409, appended in the stated order at the end of the 409 group.
- `runId` and `runFence` are required on `node.renew`, `node.release` and `node.report`.
- Do not touch `node.claim`'s request or response. EPIC 050.1 settled both.
- `heartbeatIntervalMs` appears in no schema and no production file when this story ends.

## Verify

```
node --test src/http/contract/parity.test.ts src/http/contract/registry.test.ts src/http/contract/path.test.ts src/http/contract/errors.test.ts src/http/contract/example.test.ts src/http/contract/coverage.test.ts src/http/contract/event-payload.test.ts src/http/contract/runtime-matrix.test.ts src/http/contract/openapi.test.ts src/http/contract/openapi-source.test.ts src/http/contract/authorization.test.ts src/http/contract/system.test.ts src/http/contract/proposal-amendment-execution.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts src/cli/inventory.test.ts src/cli/program.test.ts src/main.test.ts src/main.claim.test.ts src/http/server/app.handler-result.test.ts
```

Every file this story edits appears in that command.

Add:

1. `"node.heartbeat is absent from the registry"` — in `src/http/contract/registry.test.ts`, assert `findOperation("node.heartbeat") === undefined`.

2. `"node.renew is routed"` — assert `findOperation("node.renew")!.status === "routed"` and `renderPath(...) === "/v1/node/:id/renew"`. Cases 1 and 2 are asserted together so the rename is complete rather than additive.

3. `"renew is an action segment sorted between rename and report"` — assert `actionSegments.includes("renew")` and that its index is exactly one after `"rename"` and one before `"report"`.

4. `"a node.report omitting runId fails schema validation with the issue path runId"` — parse a report body carrying every other field and assert `result.success === false` and that some issue has `path` deep-equal to `["runId"]`. Repeat for the `closed` member, which carries no lease fence.

5. `"nodeRenewResponse carries expiresAt and renewAfterMs and no heartbeatIntervalMs"` — parse the example and assert both new fields, and assert the key set holds no `heartbeatIntervalMs`.

6. `"heartbeatIntervalMs appears in no contract schema"` — walk the registry's request and response schemas and assert the identifier is absent. The removal is the assertion, not a comment.

7. `"run.ended and run.renewed are registered in bytewise order, and no lease type remains"` — assert both are members, assert `eventTypes` holds no member starting with `lease.`, assert `retiredEventTypes` is empty, and assert the list equals its own `Buffer.compare` sort.

8. `"the run.ended and run.renewed payloads match what the commands append"` — in `src/http/contract/event-payload.test.ts`, parse one valid payload each and one omitting `fence`, asserting success and failure.

9. `"every new refusal code maps to 409"` — assert `errorStatuses[code] === 409` for each of the seven, and update the pinned key array at `:28-54` and the 409 group at `:94-128`.

10. `"the error code table and the proposal agree"` — the shipped `readErrorCodeMatrix()` case at `:16-26` covers it once `docs/proposal/api/README.md` carries the new rows.

`pnpm run verify` exits 0. It emits and validates the master OpenAPI document and every feature slice in a temporary directory, so a schema or component drift fails there too.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.2`.
