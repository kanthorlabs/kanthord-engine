# Story 7 — The worker contract

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: Story 1 (`01-run-authority`), for `runAuthorityRefusals`. Story 3 (`03-the-renew`) through Story 6 (`06-the-report-prelude`) need this story's request fields; implement this story before all four.
Kind: story-foundation

EPIC 050.1 Story 1 (`01-the-claim-contract`) already carried the `node.claim` half of the wire: `available`, the claim response
fields, `run.opened`, `run.expired` and the claim refusal codes. This story carries everything else,
and after it the worker protocol is one shape.

## Change

### 1 — the `renew` path segment

`src/http/contract/path.ts:40-65` holds `actionSegments`, a bytewise-sorted closed array of 24 values. Insert `"renew"` between `"rename"` and `"report"` — `"rename" < "renew"` because `a` (0x61) precedes `e` (0x65) at the fourth character, and `"renew" < "report"` because `n` precedes `p`. Do not remove `"heartbeat"`; it stays in the closed set as an unused segment, and removing a segment is not what this epic asks for.

Update `src/http/contract/path.test.ts:40` from `assert.equal(actionSegments.length, 24)` to `25`. The sorted-and-unique guard at `:23-35` then re-verifies the insertion point. Add one case in the file's convention (`:167`, `:187`): `"renew is an action segment sorted between rename and report"`.

### 2 — `node.heartbeat` becomes `node.renew`

In `src/http/contract/execution.ts:309-327`, change `operationId` to `"node.renew"` and the path to `[resource("node"), parameter("node"), action("renew")]`. Rename `nodeHeartbeatRequest` (`:33-35`), `nodeHeartbeatResponse` (`:52-56`) and `nodeHeartbeatExamples` (`:150-180`) to `nodeRenewRequest`, `nodeRenewResponse` and `nodeRenewExamples`. The old operation id is removed, not kept beside the new one.

### 3 — the request and response fields

`src/http/contract/execution.ts:33-60`:

- `nodeRenewRequest` gains `runId: identity("run")` and `runFence: z.int().min(1)` as **required** fields, beside the shipped lease `fence`. The run fence is named `runFence` to keep the two distinct, matching the command inputs of Story 3.
- `nodeRenewResponse` gains `expiresAt: z.int()` and `renewAfterMs: z.int().min(1)`, the same two fields EPIC 050.1 put on the claim response, and **loses `heartbeatIntervalMs`**.
- `nodeReleaseRequest` (`:37-39`) gains the same two required fields.
- `nodeReportRequest` in `src/http/contract/outcome.ts:23-53` is a six-member discriminated union. Add `runId` and `runFence` as required fields to **all six** members, including the `closed` member at `:49-52` which carries no lease `fence` today. A worker that cannot name its run has no authority to write, so the schema says so rather than a refusal code.

Update every example literal that these schemas parse: `nodeRenewExamples.request` at `:151`, `nodeReleaseExamples.request` at `:183`, and `nodeReportExamples.request` at `src/http/contract/outcome.ts:75`. `src/http/contract/example.test.ts:73-142` parses each against its schema.

**`heartbeatIntervalMs` is removed, not renamed.** It is `Math.floor(leaseTtlMs / 3)` at `src/commands/node/claim-node.ts:356` — `heartbeatIntervalMs` and again at `src/commands/node/claim-node.ts:415` — `heartbeatIntervalMs`, a third copy beside `src/commands/node/heartbeat-node.ts:112` — `heartbeatIntervalMs` with no shared constant, and derived from a lease this block replaces, and the epic states its replacement: `expiresAt` as the deadline and `renewAfterMs` as the relative hint. EPIC 050.1 removed it from the claim response; this story removes its last producer and every remaining site listed in section 5b. A response field removal is outside the closed list of `docs/proposal/api/README.md:100`, which is exactly what Story 8's policy amendment and capability retirement authorise.

### 3b — the claim response carries two run fences

`nodeClaimResponse` at `src/http/contract/execution.ts:53-64` returns `runId`, `objectiveRunId` and a
top-level `fence`, and no fence of the objective run. A caller that must present a run fence for the
objective therefore presents `objectiveLease.fence`, which is a different counter: a lease fence
rises when a lease is taken again after it expires, at
`src/services/lease/sqlite.ts:165` — `fence = lease.fence + 1`, and a run fence rises only when a run
ends. A claim reuses an active structural objective run at
`src/commands/node/claim-node.ts:330` — `reusableObjectiveRun`, so the objective lease fence reaches
2 while the reused objective run's fence stays 1, and the presented value is refused `fence-stale`.

The response therefore names four credentials, each with its own name:

- `lease.fence` — the task lease fence, unchanged.
- `runFence` — the task run fence. The top-level `fence` is **renamed** to it, because on
  `nodeRenewRequest` and `nodeReleaseRequest` the field `fence` means the lease fence, and one name
  for two counters is the defect above.
- `objectiveLease.fence` — the objective lease fence, unchanged.
- `objectiveRunFence` — new, `z.int().min(1)`.

`ClaimNodeResult` at `src/commands/node/claim-node.ts:112-124` carries `runFence: run.fence` and
`objectiveRunFence: objectiveRun?.fence ?? run.fence`; the non-task claim opens one structural run,
so both fields name that one run there. The handler passes the command result through and changes
nothing. Update `src/http/contract/field-decisions.fixture.ts`, the `node.claim` success example, and
`docs/proposal/api/execution.md`.

`src/cli/node/claim.ts:49-55` prints the four values under four names:

```text
kanthord: claimed <id> lease-fence <n> expires <n>
kanthord: run <id> run-fence <n> attempt <n> objective-run <id> objective-run-fence <n> objective-lease-fence <n>
```

`scripts/e2e/lib/scenario/harness.ts` parses all four and `HarnessTaskResult` carries all four, so a
scenario presents a run fence to `--run-fence` and a lease fence to `--fence`. This is the only
parser of that output.

**This section changes `node.claim`, which EPIC 050.1 settled.** The two epics are one wire
generation delivered in two commits and no build is published between them, and the claim is the only
place a worker can learn a run fence it must later present. Story 8's compatibility record lists this
change with the rest.

### 4 — the error codes

Add the six authority codes plus `lifetime-exceeded` to `src/http/contract/errors.ts:7-31`. EPIC 050.1 Story 1 already added the five claim refusals. The ordering convention is ascending HTTP status, and within a status group the proposal table's order. `src/http/contract/errors.test.ts:28` — `it` pins the exact key array and `src/http/contract/errors.test.ts:94` — `it` pins the per-status grouping. Neither array lives in `src/http/contract/errors.ts`; that file holds `src/http/contract/errors.ts:7` — `errorStatuses` and its 409 group at `:14` through `:23`.

Every new code is a **409 precondition**, appended to the end of the ten-member 409 group, in this order:

```
"run-not-found", "run-ended", "run-expired", "run-caller-mismatch",
"target-outside-run", "fence-stale", "lifetime-exceeded"
```

`run-not-found` is 409 and not 404: the run exists in the caller's hand and the daemon refuses its authority, which is a precondition failure, not a missing resource. Every 409 is a `PreconditionCode`, and `httpError` at `src/http/contract/errors.ts:95-111` then **requires** a `details` argument for each — which matches Story 1, where every refusal carries `{ runId }`.

Add a details schema per code to `src/http/contract/error-details.ts`, shaped exactly as the command throws it in Stories 3 to 6. Register the new codes on the three operations' `errors` records in `execution.ts` and `outcome.ts`, and add each to `operationAdditions` at `src/http/contract/coverage.test.ts:19` — `operationAdditions`, whose `node.heartbeat` key is `src/http/contract/coverage.test.ts:51` — `node.heartbeat`. `node.report`'s error map is not the others': `src/http/contract/outcome.ts:150` — `errors` omits `plan-invalid` and adds `acknowledgement-required`, so one map cannot be copied into four places.

Add matching rows to the error-code table in `docs/proposal/api/README.md:222` — `## Errors`. `src/http/contract/errors.test.ts:16-26` compares the key set and the status of every code against that table, so the code list and the document must agree.

### 5 — the event types are not this story's

`run.renewed` and `run.ended` are registered by the stories that write their producers: Story 3
(`03-the-renew`) and Story 5 (`05-the-release`). `src/http/contract/event-payload.test.ts:344` — `it`
asserts every produced type is declared, and `src/http/contract/event-payload.test.ts:365` — `it`
asserts every declared non-retired type has a producer, both by literal string scan over
`src/commands` and `src/services`. This story dispatches before all four command stories, so
declaring a type here would fail the producer scan and retiring one here would fail the produced
scan. Touch `src/domain/event-type.ts` and `src/http/contract/event-payload.ts` in neither direction.

### 5b — every remaining site, enumerated by grep

The list above is the contract package only. Run `grep -rn "heartbeat\|Heartbeat" src docs/proposal` and change every hit. As of authoring there are 35 files beyond the four renamed modules. Each of these is a site the fan-out above does not reach, and an unlisted one fails `pnpm run verify`:

| site                                                        | what it holds                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/http/contract/field-decisions.fixture.ts` (15 hits)    | one line per `node.heartbeat` request and response field                                                                                                                                                             |
| `src/main.claim.test.ts` (14 hits)                          | the end-to-end claim-and-heartbeat flow                                                                                                                                                                              |
| `src/http/contract/registry.test.ts` (10 hits)              | the pinned lists at `:33`, `:120`, `:152`, `:687`, `:841`, `:844`, `:857`, `:868`, `:870`, plus a **second** occurrence at `src/http/contract/registry.test.ts:1060` — `node.heartbeat` in the `allowedActors` block |
| `docs/proposal/api/execution.md` (8 hits)                   | the route row **and** its surrounding prose                                                                                                                                                                          |
| `src/http/server/node/refusals.ts` (7 hits)                 | `src/http/server/node/refusals.ts:4` — `HeartbeatNodeError`, the `instanceof` branch at `:36`, `heartbeatRefusal` at `:181`, and the two type unions at `:234` and `:266`                                            |
| `src/cli/reachability.test.ts` (6 hits)                     | CLI-command-to-operationId reachability                                                                                                                                                                              |
| `src/main.ts` (5 hits)                                      | `src/main.ts:85` — `heartbeatNode`, `src/main.ts:161` — `heartbeatNodeHandler`, and the handler map entry `src/main.ts:570` — `node.heartbeat` through `:583`                                                        |
| `src/http/contract/path.test.ts` (4 hits)                   | the three-name action-segment case                                                                                                                                                                                   |
| `src/cli/inventory.test.ts` (4 hits)                        | the CLI inventory fixture                                                                                                                                                                                            |
| `src/http/contract/openapi.test.ts` (3 hits)                | the component list                                                                                                                                                                                                   |
| `src/commands/node/claim-node.ts` (3 hits)                  | **`heartbeatIntervalMs` only** — removed by EPIC 050.1 Story 1                                                                                                                                                       |
| `src/cli/node/claim.test.ts` (3 hits)                       | the claim CLI output fixture                                                                                                                                                                                         |
| `src/http/server/node/claim-node.test.ts` (2 hits)          | `heartbeatIntervalMs` in the response fixture                                                                                                                                                                        |
| `src/http/contract/system.test.ts` (2 hits)                 | the third copy of the request and response lists                                                                                                                                                                     |
| `src/commands/node/release-node.test.ts` (2 hits)           | imports the old command to build state                                                                                                                                                                               |
| `src/commands/node/claim-node.test.ts` (2 hits)             | `heartbeatIntervalMs` assertions                                                                                                                                                                                     |
| `src/cli/program.ts` (2 hits)                               | `src/cli/program.ts:44` — `registerNodeHeartbeat` and the registration at `src/cli/program.ts:378` — `registerNodeHeartbeat`                                                                                         |
| `src/cli/program.test.ts` (2 hits)                          | the registered-command list                                                                                                                                                                                          |
| `src/cli/inventory.ts` (2 hits)                             | `src/cli/inventory.ts:68` — `heartbeat` and `src/cli/inventory.ts:69` — `node.heartbeat`                                                                                                                             |
| `docs/proposal/phase-2/agents-and-workers.md` (2 hits)      | prose                                                                                                                                                                                                                |
| `docs/proposal/phase-1/README.md` (2 hits)                  | prose                                                                                                                                                                                                                |
| `src/main.test.ts`                                          | the production handler map                                                                                                                                                                                           |
| `src/http/server/app.handler-result.test.ts:45`             | the `["src/http/server/node/heartbeat-node.ts", [200]]` entry                                                                                                                                                        |
| `src/http/contract/proposal-amendment-execution.test.ts:39` | asserts a proposal sentence naming `POST /v1/node/:id/heartbeat` verbatim                                                                                                                                            |
| `src/http/contract/path.ts`                                 | the `actionSegments` entry, kept per section 1                                                                                                                                                                       |
| `src/http/contract/example.test.ts`                         | the examples list                                                                                                                                                                                                    |
| `src/http/contract/coverage.test.ts`                        | `operationAdditions`                                                                                                                                                                                                 |
| `src/http/contract/capability.ts`                           | the `external-drive` entry, retired by Story 8                                                                                                                                                                       |
| `src/http/contract/authorization.test.ts`                   | the second copy of the harness list                                                                                                                                                                                  |
| `src/cli/parity.test.ts:99`                                 | the `"node heartbeat"` command-name row                                                                                                                                                                              |
| `src/cli/node/claim.ts:51`                                  | the claim CLI output string                                                                                                                                                                                          |
| `docs/proposal/phase-1/runtime-capability-matrix.md`        | the matrix row                                                                                                                                                                                                       |
| `docs/proposal/open-items.md`                               | prose                                                                                                                                                                                                                |
| `docs/proposal/memory/write-path.md`                        | prose                                                                                                                                                                                                                |

The registry total stays **73** and the routed total stays **50**: one operation is renamed, none is added and none is removed. Do not change the counts at `src/http/contract/registry.test.ts:48-50` and `:64-72`.

### 6 — the parity and matrix documents

- `docs/proposal/api/execution.md` — change the `node.heartbeat` row to `node.renew` with path `/v1/node/:id/renew`, keeping `phase-1` and `routed`. `src/http/contract/parity.test.ts:12-22` compares operationId, method, rendered path, `introducedIn` and `status` against every `*.md` under `docs/proposal/api/` except `README.md` and `new-decisions.md`, and pins the comparable count at **73** — unchanged by a rename.
- `docs/proposal/phase-1/runtime-capability-matrix.md` — rename the `node.heartbeat` row and move it to its bytewise position among the routed operations. `src/http/contract/runtime-matrix.test.ts:77-79` asserts the document rows equal the registry order, and `:81-92` asserts every row has exactly nine cells. The count stays **50** at `:72-75`.

## Constraints

- Add `"renew"` to `actionSegments`; do not remove `"heartbeat"`.
- Keep the registry at 73 operations and 50 routed. This story renames; it adds no operation.
- Every new error code is 409, appended in the stated order at the end of the 409 group.
- `runId` and `runFence` are required on `node.renew`, `node.release` and `node.report`.
- Do not touch `node.claim`'s request. Section 3b is the only change to its response, and it adds `objectiveRunFence` and renames `fence` to `runFence` and nothing else.
- `heartbeatIntervalMs` appears in no schema and no production file when this story ends.
- Touch neither `src/domain/event-type.ts` nor `src/http/contract/event-payload.ts`. Story 3 (`03-the-renew`) and Story 5 (`05-the-release`) own both, because a declared type must have a producer in the same story.

## Verify

```
node --test src/http/contract/parity.test.ts src/http/contract/registry.test.ts src/http/contract/path.test.ts src/http/contract/errors.test.ts src/http/contract/example.test.ts src/http/contract/coverage.test.ts src/http/contract/runtime-matrix.test.ts src/services/config/convict.test.ts src/http/contract/openapi.test.ts src/http/contract/openapi-source.test.ts src/http/contract/authorization.test.ts src/http/contract/system.test.ts src/http/contract/proposal-amendment-execution.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts src/cli/inventory.test.ts src/cli/program.test.ts src/main.test.ts src/main.claim.test.ts src/http/server/app.handler-result.test.ts
```

Every file this story edits appears in that command.

Add:

1. `"node.heartbeat is absent from the registry"` — in `src/http/contract/registry.test.ts`, assert `findOperation("node.heartbeat") === undefined`.

2. `"node.renew is routed"` — assert `findOperation("node.renew")!.status === "routed"` and `renderPath(...) === "/v1/node/:id/renew"`. Cases 1 and 2 are asserted together so the rename is complete rather than additive.

3. `"renew is an action segment sorted between rename and report"` — assert `actionSegments.includes("renew")` and that its index is exactly one after `"rename"` and one before `"report"`.

4. `"a node.report omitting runId fails schema validation with the issue path runId"` — for **each of the six members** of the union, parse a body carrying every other field of that member and assert `result.success === false` and that some issue has `path` deep-equal to `["runId"]`. The `closed` member at `src/http/contract/outcome.ts:50` — `closed` carries no lease fence, and it is asserted like the rest; `nodeReportRequest` is a `z.discriminatedUnion`, so there is no shared base object and each member is checked on its own.

5. `"nodeRenewResponse carries expiresAt and renewAfterMs and no heartbeatIntervalMs"` — parse the example and assert both new fields, and assert the key set holds no `heartbeatIntervalMs`.

6. `"heartbeatIntervalMs appears in no contract schema"` — walk the registry's request and response schemas and assert the identifier is absent. The removal is the assertion, not a comment.

7. `"renewAfterMs is one third of runTtlMs"` — assert the `node.renew` response example's `renewAfterMs` equals `Math.floor(runTtlMs / 3)` for the configured default of `300000`, read from `src/services/config/convict.ts:249` — `default`. The shipped `src/services/config/convict.test.ts:450` — `it` pins that default, so the two cannot drift.

8. `"every new refusal code maps to 409"` — assert `errorStatuses[code] === 409` for each of the seven. Update the pinned key array, which is `src/http/contract/errors.test.ts:29` — `deepEqual` through `:53`, whose first member is `src/http/contract/errors.test.ts:36` — `stale-revision`, and the 409 group, which is `src/http/contract/errors.test.ts:107` — `409` through `:118`. Both are positional `deepEqual` comparisons, so appending is not enough.

9. `"the claim response carries both run fences"` — parse the `node.claim` success example and assert `runFence` and `objectiveRunFence` are integers at least 1, and assert `nodeClaimResponse.shape` holds no `fence`. Both halves are asserted, so the rename is complete rather than additive.

10. `"the objective run fence and the objective lease fence are separate counters"` — in `src/commands/node/claim-node.test.ts`, claim a task, end its run, expire the owner's leases, return the task to `ready`, and claim again. Assert the second claim reuses the objective run id, that `objectiveLease.fence` is 2 and `objectiveRunFence` is 1, and that `objectiveRunFence` equals the run row's `fence`. Without this case both values are 1 everywhere and the fix is unfalsifiable.

11. `"the claim prints four named fences"` — assert the two CLI lines exactly, over a fixture whose four fences are four different numbers.

12. `"the error code table and the proposal agree"` — the shipped case at `src/http/contract/errors.test.ts:16` — `it` reads `docs/proposal/api/README.md` through `test/helpers/proposal.ts:89` — `readErrorCodeMatrix` and asserts sorted key equality plus per-code status. It fails until the markdown table carries the seven new rows, so the document edit is not optional.

`pnpm run verify` exits 0. It emits and validates the master OpenAPI document and every feature slice in a temporary directory, so a schema or component drift fails there too.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.2`.
