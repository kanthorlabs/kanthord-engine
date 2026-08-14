# EPIC 019 — Outcome report and aggregation — stories

Epic: `.agent/plan/epics/019-outcome-report.md`
Prereq: EPIC 018 (sequence order). EPIC 014 supplies the transition table, the drive-mode pin and the consumer map; EPIC 015 supplies `allowedActors` and the actor kinds; EPIC 016 supplies `setNodeState` and readiness; EPIC 018 supplies the claim, the lease service and `services/execution`.

A harness reports the outcome of the task it holds through `POST /v1/node/:id/report`, attests one combined object id for the objective, and a human closes the attested objective, which rolls the initiative up — all through the real composition root.

## Dispatch order

Numeric order, `01` to `20`. **Every story is independently green**: `npm run verify` exits 0 at the close of each one. Two pairs are coupled and take no verify gate between their members, because neither half is independently valid:

- **7 + 8** — the command and its event payload edit one file.
- **13 + 14** — `eventTypes` and the payload map are one contract.

Story 1 and Story 18 are **not** a coupled pair. Story 18 carries the proposal Routes-table row itself, so the parity assertion never goes red between them.

Four ordering facts are load-bearing:

- Story 4 precedes Story 5, because `taskReportEffect` returns `attempt-failed` and `report-cancelled`.
- Story 10 precedes Story 11, because `closeObjective` calls `aggregateInitiative`.
- Story 12 follows Stories 7, 9 and 11, because the on-disk consumer assertion needs the four command files.
- Story 20 is last; it runs the whole Proof block.

## Stories

- 1 — the proposal amendment: the `node.report` section and the spend clause → `01-proposal-amendment.md`
- 2 — the EPIC 014 amendment, verified and not re-landed → `02-epic-014-precondition-check.md`
- 3 — every closed attempt spends a try → `03-attempt-spend-clause.md`
- 4 — the two external transition rows and the two consumer entries → `04-external-transition-rows.md`
- 5 — the report effect as data, plus the one shared result record → `05-report-effect-data.md`
- 6 — `services/execution` gains `stampRunHead` and `latestRunOfNode` → `06-execution-service-methods.md`
- 7 — `reportOutcome`, the command → `07-report-outcome-command.md`
- 8 — the `outcome.reported` event payload, fixed key by key → `08-outcome-reported-payload.md`
- 9 — `reportObjective`, the attestation command → `09-report-objective.md`
- 10 — `aggregateInitiative` → `10-aggregate-initiative.md`
- 11 — `closeObjective` → `11-close-objective.md`
- 12 — the second consumption assertion, on disk → `12-consumer-on-disk-assertion.md`
- 13 — `eventTypes`, the closed list → `13-event-type-registry.md`
- 14 — the typed event payload contract, total and self-policing → `14-event-payload-contract.md`
- 15 — `node.show` returns what the human closes → `15-node-show-attested.md`
- 16 — readiness after a terminal transition → `16-readiness-after-terminal.md`
- 17 — the claim reuses an active run of its own driver → `17-claim-run-reuse.md`
- 18 — the proposal route row, the contract row, the handler and the actor row → `18-contract-row-handler-actor.md`
- 19 — the composition root and the CLI → `19-composition-root-and-cli.md`
- 20 — the real-composition-root loop → `20-real-composition-root-loop.md`

The EPIC lists eighteen Story bullets. Two bullets split, each because one half cannot be verified when the other lands:

- `019-outcome-report.md:66` splits into Story 4 (the rows and the map entries) and Story 12 (the on-disk assertion, which needs the four command files).
- `019-outcome-report.md:80-82` splits into Story 13 (`eventTypes`) and Story 14 (the payload map, the honesty test and the `event.ts` wiring).

## Settled after the EPIC amendment

`019-outcome-report.md:52,80,82,84,175-179` were amended before this expansion shipped, so no story carries an open decision:

- **`eventView.payload` stays `z.unknown()`.** The payload schemas reach a client as named OpenAPI components. A closed union of current shapes would reject a payload an earlier build wrote and fail `event.list` on the history `eventView.type` stays `z.string()` to serve. Story 14 therefore edits neither `src/http/contract/event.ts` nor the field-decision fixture.
- **The honesty scan covers `src/commands/` and `src/services/`**, because `src/services/readiness/dependency.ts` writes `node.ready` and `node.pending`.
- **`eventTypes` holds 35 members**, `actor.tokenRotated` included, plus a `retiredEventTypes` list that is empty here.
- **The scan and the registry meet in two subset relations**, never a bare equality, because an append-only registry cannot equal a scan of the current tree.
- **`field-decisions.fixture.ts` grows from `node.report` alone**, in Story 18, and the delta is reviewed rather than accepted from a diff.

## Facts (needed for implementation)

- **`setNodeState`** — `src/services/plan/index.ts`, added by `.agent/plan/stories/016-readiness-applied/04-closed-mutation-api.md`: `setNodeState(transaction, { id, from, to, trigger, blockReason, at, cause })` returns `readonly ReadinessTransition[]`. `trigger` is required. `cause` is `{ revision: string, importId: string | null }`.
- **`accountAttempts`** — `src/domain/attempt-accounting.ts:32-82`. Input `{ attempts: readonly {attemptNo, outcome}[], limit }`; output `{ counter, rejections, exhausted, nextAttemptNo }`. `exhausted` is at `:71-74` and Story 3 widens it.
- **`attemptOutcomes`** — `src/domain/attempt.ts:6-12`: `accepted`, `rejected`, `failed`, `timed-out`, `cancelled`.
- **`aggregate`** — `src/domain/aggregation.ts:17-44`. It throws `empty-parent` on an empty child list and `invalid-child-state` when an objective sees a `partial` task.
- **`objectiveOutcome`** — `src/domain/outcome.ts:17-23`: `discarded` in, `discarded` out; anything else gives `awaiting_approval`.
- **`initiativeOutcome`** — `src/domain/outcome.ts:25-42`. With `"not-applicable"` it returns the projection unchanged, and `discarded` short-circuits at `:29`.
- **No production file imports `aggregate`, `objectiveOutcome` or `initiativeOutcome` today.** This epic is their first consumer.
- **`objectId`** — `src/domain/column.ts:6`: `z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/)`. Reuse it; hard-code no length.
- **`Lease`** — `src/services/lease/index.ts:47-52`. `release(transaction, { subjectKind, subjectId, fence })`. `LeaseRecord` carries `owner`, `fence`, `acquiredAt`, `renewedAt` and `expiresAt`, all nullable except `subjectKind`, `subjectId` and `fence`.
- **`EventLog.append`** — `src/services/event/index.ts:47`: `append(transaction, { subjectKind, subjectId, type, actorKind, actorId, payload })`. `payload` is `unknown` at the service boundary and stays so. `ActorKind` at `:3` gains `harness` in EPIC 015.
- **`Transaction`** — `src/services/storage/index.ts:1`; `storage.transact(work)` at `:33`.
- **Eighteen event type literals exist under `src/commands/` today**, including the two in the ternary at `src/commands/startup/recover-expired-leases.ts:157-160`. A scan that looks only for `type: "` misses those two.
- **`node.ready` and `node.pending` are written in `src/services/readiness/dependency.ts`**, not under `src/commands/`. The honesty scan of Story 14 therefore covers `src/commands/` **and** `src/services/`.
- **`eventView.payload`** — `src/http/contract/event.ts:26` is `z.unknown()` and stays so. `eventView.type` at `:21` and `eventListRequest.type` at `:14` stay `z.string()`. This epic edits that file not at all.
- **`Operation`** — `src/http/contract/operation.ts:32-47`; EPIC 015 adds the required `allowedActors`.
- **`actionSegments`** — `src/http/contract/path.ts:36-52`, alphabetical; `report` goes between `rename` and `resolve`.
- **`errorStatuses`** — `src/http/contract/errors.ts:7-30` already holds `illegal-transition`, `acknowledgement-required` and `lease-held`. EPIC 015 adds `actor-forbidden`.
- **`invalidRequestDetails`** — `src/http/contract/error-details.ts:75-79`: `{ refusal, detail?, ids? }`. There is no `leaseHeldDetails` today; EPIC 018 adds it (`018-claim-and-lease.md:115`).
- **Parity counts** — `src/http/contract/parity.test.ts:16` is `54` and `:25` is `58`. One routed row makes them `55` and `59`.
- **Field decisions are derived and exact** — `src/http/contract/coverage.test.ts:262-286` walks every `query`, `request` and `response` of the **whole** registry, sorts bytewise at `:282-284`, and asserts `assert.deepEqual(rows, fieldDecisions)`. Adding `node.report` and typing `eventView.payload` both grow `src/http/contract/field-decisions.fixture.ts`; take the derived list from the assertion diff, never by hand.
- **`nodeListItem`** is `src/http/contract/graph.ts:103-113` and **`nodeShowResponse`** is `:119-126`. Only the latter grows.
- **`showNode`** — `src/queries/node/show-node.ts:28-35` returns `plan.readNode` directly today; Story 15 makes it compose inside one transaction.
- **Handler pattern** — `src/http/server/node/show-node.ts` (parse, invoke, format) and `src/http/server/plan/refusals.ts:5-40` (refusal mapping, re-throw at `:39`).
- **Command error pattern** — `ImportPlanError` at `src/commands/plan/import-plan.ts:78-88`: a `refusal` union plus an opaque `details`.
- **`src/main.ts`** — the handler map is `:213-337`, `node.show` is `:307-309`, `unimplementedFor(handlers)` is `:338`, and the instance ULID is minted inline at `:136`.
- **CLI pattern** — `src/cli/project/show.ts` end to end; `src/cli/program.ts:53-197` registers; `src/cli/inventory.ts:6` declares the command-to-operation map, and `["plan","import"]` at `:27-30` shows one command naming three operations.
- **`launchDaemon`** — `test/helpers/daemon.ts:29` spawns `src/main.ts` with `--config`, `--home` and `serve`.
- **SQLite row order is unspecified without `ORDER BY`.** Every read this epic adds declares one: attempts by `attempt_no` ascending, runs by `id` descending, node lists sorted bytewise by node id through `Buffer.compare`. Any list a payload or a response exposes is ordered explicitly, even when the computation over it is order-insensitive.
- **`test/helpers/proposal.ts`** reads the route matrix and compares `sql` fences with comments stripped. No proposal `sql` fence may move.
