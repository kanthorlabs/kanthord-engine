# Story 13 — The contract carries the run, the fence and the availability assertion

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 9 (`runAuthorityRefusals`). Story 7 needs this story's event-type registration, and Story 8 and Story 10 need its request fields; implement this story before both.

## Change

### 1 — the `renew` path segment

`src/http/contract/path.ts:40-65` holds `actionSegments`, a bytewise-sorted closed array of 24 values. Insert `"renew"` between `"rename"` and `"report"` — `"rename" < "renew"` because `a` (0x61) precedes `e` (0x65) at the fourth character, and `"renew" < "report"` because `n` precedes `p`. Do not remove `"heartbeat"`; it stays in the closed set as an unused segment, and removing a segment is not what this epic asks for.

Update `src/http/contract/path.test.ts:40` from `assert.equal(actionSegments.length, 24)` to `25`. The sorted-and-unique guard at `:23-35` then re-verifies the insertion point. Add one case in the file's convention (`:167`, `:187`): `"renew is an action segment sorted between rename and report"`.

### 2 — `node.heartbeat` becomes `node.renew`

In `src/http/contract/execution.ts:265-283`, change `operationId` to `"node.renew"` and the path to `[resource("node"), parameter("node"), action("renew")]`. Rename `nodeHeartbeatRequest` (`:31-33`), `nodeHeartbeatResponse` (`:50-54`) and `nodeHeartbeatExamples` (`:129-159`) to `nodeRenewRequest`, `nodeRenewResponse` and `nodeRenewExamples`. The old operation id is removed, not kept beside the new one.

### 3 — the request and response fields

`src/http/contract/execution.ts:29-58`:

- `nodeClaimRequest` (`:29`) becomes `z.strictObject({ available: z.boolean() })`. It is a **required** field: a caller that does not state its availability has not run the self health check the daemon relies on.
- `nodeClaimResponse` (`:39-48`) gains `runId: identity("run")` — already present at `:42` — and `fence: z.int().min(1)`. `node.claim` returns both and receives neither.
- `nodeRenewRequest` gains `runId: identity("run")` and `fence: z.int().min(1)` as **required** fields, beside the shipped lease `fence`. Name the run fence `runFence` to keep the two distinct, matching the command inputs of Story 10.
- `nodeReleaseRequest` (`:35-37`) gains the same two required fields.
- `nodeReportRequest` in `src/http/contract/outcome.ts:23-53` is a six-member discriminated union. Add `runId` and `runFence` as required fields to **all six** members, including the `closed` member at `:49-52` which carries no lease `fence` today. A worker that cannot name its run has no authority to write, so the schema says so rather than a refusal code.

Update every example literal that these schemas parse: `nodeClaimExamples.request` at `src/http/contract/execution.ts:89`, `nodeRenewExamples.request` at `:130`, `nodeReleaseExamples.request` at `:162`, and `nodeReportExamples.request` at `src/http/contract/outcome.ts:75`. `src/http/contract/example.test.ts:73-142` parses each against its schema.

### 4 — the error codes

Add the six authority codes plus `lifetime-exceeded` and the five claim refusals to `src/http/contract/errors.ts:7-31`. The ordering convention is ascending HTTP status, and within a status group the proposal table's order — `src/http/contract/errors.test.ts:28-54` pins the exact key array and `:94-128` pins the per-status grouping.

Every new code is a **409 precondition**, appended to the end of the 409 group after `"host-key-mismatch"` at `errors.ts:23`, in this order:

```
"run-not-found", "run-ended", "run-expired", "run-caller-mismatch",
"target-outside-run", "fence-stale", "lifetime-exceeded",
"pair-illegal", "assignment-held", "unroutable", "review-head-unavailable",
"objective-busy", "subtree-busy"
```

`run-not-found` is 409 and not 404: the run exists in the caller's hand and the daemon refuses its authority, which is a precondition failure, not a missing resource. Every 409 is a `PreconditionCode`, and `httpError` at `src/http/contract/errors.ts:95-111` then **requires** a `details` argument for each — which matches Story 9, where every refusal carries `{ runId }`.

Add a details schema per code to `src/http/contract/error-details.ts`, shaped exactly as the command throws it in Story 8 and Story 10. Register the new codes on the four operations' `errors` records in `execution.ts` and `outcome.ts`, and add each to `operationAdditions` in `src/http/contract/coverage.test.ts:19-59`, which is the closed map of extra codes per operation.

Add matching rows to the error-code table in `docs/proposal/api/README.md` (section `## Errors`, `:222`). `src/http/contract/errors.test.ts:16-26` compares the key set and the status of every code against that table, so the code list and the document must agree.

### 5 — the event type

Add `"run.expired"` to `src/domain/event-type.ts:1-40`. The list is strict bytewise ascending, so it sits between `"repository.registered"` (`:39`) and the end — `"run.expired"` follows every `repository.*` entry because `u` (0x75) follows `e` (0x65) at the third character.

Add the payload to `eventPayloads` in `src/http/contract/event-payload.ts:71`, in the same bytewise position. The record is typed `Readonly<Record<EventType, ZodType>>`, so omitting it fails type checking:

```ts
"run.expired": z.strictObject({
  runId: z.string(),
  nodeId: z.string(),
  fence,
  expiredAt: z.number().int(),
}),
```

`fence` is the shared alias declared at `src/http/contract/event-payload.ts:29-35`. The payload shape is exactly what Story 7 appends.

### 6 — the registry-wide fixtures

Each of these is a hard-coded literal that a routed-operation rename moves. Update every one:

- `src/http/contract/registry.test.ts:113-136` — the 20-name `request` list: `node.heartbeat` becomes `node.renew`, keeping bytewise order.
- `src/http/contract/registry.test.ts:137-170` — the 46-name `response` list, the same.
- `src/http/contract/registry.test.ts:27-46` — `harnessOperations`, the same.
- `src/http/contract/registry.test.ts:671-714` — the 33-name POST idempotency list.
- `src/http/contract/registry.test.ts:839-850` — replace `"node.heartbeat"` with `"node.renew"` in the three-name loop, and `:866-873` — `assert.equal(renderPath(renew!.path), "/v1/node/:id/renew")`.
- `src/http/contract/authorization.test.ts:17-36` — the second copy of the harness list.
- `src/http/contract/system.test.ts:359-436` — the third copy of the request and response lists.
- `src/http/contract/example.test.ts:15-65` — the 47-name examples list.
- `src/http/contract/coverage.test.ts:19-59` and `src/http/contract/field-decisions.fixture.ts:65-216` — the node operations' rows.
- `src/http/contract/openapi.test.ts:283-285` — `node.heartbeat.{error,request,response}` becomes `node.renew.{...}`, and the components stay in bytewise order.

### 6b — every remaining site, enumerated by grep

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
| `src/commands/node/claim-node.ts` (3 hits)                  | **`heartbeatIntervalMs` only** — see the rule below                                                             |
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
| `src/http/contract/capability.ts`                           | the `external-drive` entry, retired by Story 14                                                                 |
| `src/http/contract/authorization.test.ts`                   | the second copy of the harness list                                                                             |
| `src/cli/parity.test.ts:99`                                 | the `"node heartbeat"` command-name row                                                                         |
| `src/cli/node/claim.ts:51`                                  | the claim CLI output string                                                                                     |
| `docs/proposal/phase-1/runtime-capability-matrix.md`        | the matrix row                                                                                                  |
| `docs/proposal/open-items.md`                               | prose                                                                                                           |
| `docs/proposal/memory/write-path.md`                        | prose                                                                                                           |

**`heartbeatIntervalMs` keeps its name.** It is a response field of `node.claim`, not an operation id, and this epic's compatibility record lists four changes and not five. Renaming a response field is forbidden by the `/v1` policy and no human ruling covers it. Every hit above that is the identifier `heartbeatIntervalMs` — in `claim-node.ts:80`, `:356`, `:415`, the two claim test files, the server claim test and `cli/node/claim.ts:51` — is left unchanged. Only the operation id, the path segment, the schema names, the module names and the CLI command name move.

The registry total stays **73** and the routed total stays **48**: one operation is renamed, none is added and none is removed. Do not change the counts at `src/http/contract/registry.test.ts:49-51` and `:64-73`.

### 7 — the parity and matrix documents

- `docs/proposal/api/execution.md` — change the `node.heartbeat` row to `node.renew` with path `/v1/node/:id/renew`, keeping `phase-1` and `routed`. `src/http/contract/parity.test.ts:12-22` compares operationId, method, rendered path, `introducedIn` and `status` against every `*.md` under `docs/proposal/api/` except `README.md` and `new-decisions.md`, and pins the comparable count at **73** — unchanged by a rename.
- `docs/proposal/phase-1/runtime-capability-matrix.md` — rename the `node.heartbeat` row and move it to its bytewise position among the routed operations. `src/http/contract/runtime-matrix.test.ts:77-79` asserts the document rows equal the registry order, and `:81-92` asserts every row has exactly nine cells. The count stays **48** at `:72-75`.

## Constraints

- Add `"renew"` to `actionSegments`; do not remove `"heartbeat"`.
- Keep the registry at 73 operations and 48 routed. This story renames; it adds no operation.
- Every new error code is 409, appended in the stated order at the end of the 409 group.
- `available` is required on `node.claim`. `runId` and `runFence` are required on `node.renew`, `node.release` and `node.report`.
- Do not add `runId` or `runFence` to `node.claim`'s request.

## Verify

```
node --test src/http/contract/parity.test.ts src/http/contract/registry.test.ts src/http/contract/path.test.ts src/http/contract/errors.test.ts src/http/contract/example.test.ts src/http/contract/coverage.test.ts src/http/contract/event-payload.test.ts src/http/contract/runtime-matrix.test.ts src/http/contract/openapi.test.ts src/http/contract/openapi-source.test.ts src/http/contract/authorization.test.ts src/http/contract/system.test.ts src/http/contract/proposal-amendment-execution.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts src/cli/inventory.test.ts src/cli/program.test.ts src/main.test.ts src/main.claim.test.ts src/http/server/app.handler-result.test.ts
```

Every file this story edits appears in that command.

Add:

1. `"node.heartbeat is absent from the registry"` — in `src/http/contract/registry.test.ts`, assert `findOperation("node.heartbeat") === undefined`.

2. `"node.renew is routed"` — assert `findOperation("node.renew")!.status === "routed"` and `renderPath(...) === "/v1/node/:id/renew"`. Cases 1 and 2 are asserted together so the rename is complete rather than additive.

3. `"renew is an action segment sorted between rename and report"` — in `src/http/contract/path.test.ts`, assert `actionSegments.includes("renew")` and that its index is exactly one after `"rename"` and one before `"report"`.

4. `"a node.report omitting runId fails schema validation with the issue path runId"` — parse a report body carrying every other field and assert `result.success === false` and that some issue has `path` deep-equal to `["runId"]`. The field is required on the wire, not enforced by a refusal code. Repeat for the `closed` member, which carries no lease fence.

5. `"a node.claim request omitting available fails validation"` — assert the issue path is `["available"]`.

6. `"nodeClaimResponse carries runId and fence"` — parse the example and assert both are present and that `fence >= 1`.

7. `"run.expired is registered as an event type in bytewise order"` — assert `eventTypes.includes("run.expired")` and `assert.deepEqual([...eventTypes], [...eventTypes].sort())` using `Buffer.compare`, matching the file's ordering rule.

8. `"the run.expired payload matches what the expiry pass appends"` — in `src/http/contract/event-payload.test.ts`, parse `{ runId, nodeId, fence: 4, expiredAt: 1700000000000 }` and assert success; parse one omitting `fence` and assert failure.

9. `"every new refusal code maps to 409"` — in `src/http/contract/errors.test.ts`, assert `errorStatuses[code] === 409` for each of the thirteen, and update the pinned key array at `:28-54` and the 409 group at `:94-128`.

10. `"the error code table and the proposal agree"` — the shipped `readErrorCodeMatrix()` case at `:16-26` covers it once `docs/proposal/api/README.md` carries the new rows.

`pnpm run verify` exits 0. It emits and validates the master OpenAPI document and every feature slice in a temporary directory, so a schema or component drift fails there too.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050`.
