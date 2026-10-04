# Plan 02: Intake Service — outbound record

## Scope

This plan delivers:

- The outbound store of `src/intake/outbound-store.ts`: the insert of a `pending` request, the read by `(operation, request_key)`, the conditional state writes and the projection.
- The outbound runner of `src/intake/outbound.ts`: authorize and release before the insert, the insert committed before the call, the in-flight set, the deadline through an `AbortController`, the state write after the call, the repeat rules and the read-back. Plans 03 and 04 run every outbound write through it.
- The human operations `intake.outbound.request.list`, `get` (task 02.3), `discard` and `delete` (task 02.4) with their handlers and their OpenAPI.
- The `intake` CLI group with the leaves `outbound list`, `outbound get`, `outbound discard` and `outbound delete`.

Out of scope:

- Every outbound operation and its platform call (plans 03 and 04). The runner takes the authorization, the call and the read-back as functions.
- The CLI transport and its code `intake.outbound.request.cli_unavailable` (decision D5).
- A caller read of a request: no `client` or `service` operation reads one (`intake-service.impl.md:192`).

## Sources

- `docs/reference/erd/03-integration.md:73–83` — the columns of `intake_outbound_request`.
- `docs/reference/erd/03-integration.md:118–119` — no remote effect commits with a SQLite transaction; a request commits as `pending` before its call; `succeeded` commits only after a 2xx answer or a read-back match.
- `docs/reference/erd/03-integration.md:140–150` — the constraints of the outbound request.
- `docs/reference/erd/03-integration.md:30` — the set of running requests stays in memory.
- `docs/brainstorm/intake-service.md:136–173` — outbound requests, the state, the repeat and the read-back.
- `docs/brainstorm/intake-service.md:188–190` — the human delete with a filter and with force.
- `docs/brainstorm/intake-service.md:194–195` — every authenticated human holds the authority to list, read, discard and delete an outbound request.
- `docs/brainstorm/intake-service.vocabulary.md:60–82` — outbound request, request key, outbound request state, read-back.
- `docs/brainstorm/intake-service.impl.md:94–115` — the error codes.
- `docs/brainstorm/intake-service.impl.md:160–174` — the outbound record.
- `docs/brainstorm/intake-service.impl.md:184–192` — the human operations.
- `docs/brainstorm/intake-service.impl.md:238–243` — the tests of the outbound record.
- `docs/brainstorm/architecture.impl.md:116–121`, `:697–712` — a transaction awaits nothing; a handler separates asynchronous work from its commit; the index of ruled writes admits the `pending` insert and the `failed` write of an outbound request.
- `docs/brainstorm/architecture.impl.md:179–189` — pagination.
- `docs/brainstorm/architecture.impl.md:349` — the CLI code of one command.
- `docs/brainstorm/gateway-service.impl.md:394–434` — idempotency of a mutation.
- `engine/docs/cli/intake.md:41–69` — the command table, the routes, the lifetime and the mutation flag.
- `engine/docs/cli/intake.md:113–127`, `:129–133` — the synopses and the shared rules of a leaf.
- `engine/docs/cli/intake.md:137–169` — the flags and their request mapping.
- `engine/docs/cli/intake.md:326–377` — the outbound commands and their statuses.
- `engine/docs/cli/intake.md:420–473` — the output conventions and the error codes.
- `engine/docs/cli/other.md` "Error codes" — `cli.<group>.<command>.token_required`, `cli.<group>.<command>.indeterminate`, `cli.idempotency_key.invalid`, `cli.pagination.*`, `system.pagination.cursor_invalid`.
- `engine/docs/cli/common-flags.md` — `[M]`, `[R]`, `[L]`.
- `engine/src/kernel/identity.ts` — `identitySchema`, `createIdentity`.
- `engine/src/kernel/json.ts` — `canonicalJSON`.
- `engine/src/apps/cli/scheduler-execution.ts`, `engine/src/apps/cli/shared.ts` — the leaf pattern: `requireToken`, `resolveKey`, `httpClient`.
- Decisions D3, D12, D23 of `decisions.md`.

### Contract keys

| Key                                                                                   | Where                                  | Owner line                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `id`, `projectId`, `operation`, `requestKey`, `state`, `result`, `error`, `createdAt` | the outbound read projection           | `engine/docs/cli/intake.md:328–330`                |
| `outboundRequestId`                                                                   | path parameter                         | `engine/docs/cli/intake.md:158`                    |
| `projectId`, `state`, `operation`, `limit`, `cursor`                                  | query of `outbound list`               | `engine/docs/cli/intake.md:159–161`, `:144`        |
| `force`, `state`, `from`, `to`, `ids`                                                 | body of `outbound delete`              | `engine/docs/cli/intake.md:160–164`, `:361–362`    |
| `count`                                                                               | answer of `outbound delete`            | `engine/docs/cli/intake.md:368`                    |
| `items`, `nextCursor`                                                                 | a list page                            | `architecture.impl.md:184`                         |
| `code`, `message`, `created_at`                                                       | an item of `error`, in its stored form | `docs/reference/erd/03-integration.md:137`, `:148` |
| `idempotencyKey`                                                                      | stdout of a mutation leaf              | `engine/docs/cli/intake.md:428`                    |

## Depends on

- Plan 01: `src/intake/contract.ts` with `OutboundOperation`, `OutboundRequestState` and the constants of decision D12; `intake_outbound_request`; `appendError`; the composed `IntakeService`.
- ERD 2 plan 05: `CustodyComponent.release` and `Material` with `drop()` (`engine/src/custody/service.ts:377`; `engine/src/custody/facility.ts:35–57`). The runner takes a released `Material` from its caller; plan 03 adds `consume` for a grant without a credential.
- No stand-in.

## Provides

| Seam             | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner file                     | Consumer plans |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------- |
| Outbound store   | `insertPending(tx, row): string` (the new identity); `findByKey(tx, operation, requestKey): OutboundRow \| null`; `succeed(tx, id, result, expected: readonly OutboundState[]): boolean`; `fail(tx, id, item, now): boolean`; `discard(tx, id): boolean`; `outboundRecord(row): OutboundRequest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `src/intake/outbound-store.ts` | 02, 03, 04     |
| Outbound runner  | `runOutbound<TBody>(dependencies, caller, request: OutboundRun<TBody>): Promise<TBody>` with `OutboundRun<TBody> = { requestKey; deadlineMs; resultCodec: { encode(value): unknown; decode(stored): unknown }; authorize(tx, now): { operation: OutboundOperation; projectId; credential: string \| null; material: Material \| null }; call(material, scope: { context; signal }): Promise<CallAnswer>; readBack(material, scope): Promise<ReadBack>; finalize(answer: OutboundAnswer): { kind: "answer"; body: TBody } \| { kind: "error"; error } }`, `CallAnswer = { ok: true; result: unknown } \| { ok: false; class: ResultClass; code: string; message: string }`, `ReadBack = { match: true; result: unknown } \| { match: false }`, `OutboundAnswer = { ok: true; result: unknown } \| { ok: false; class: ResultClass; code: string; message: string }`. The handler calls `runOutbound`; the runner commits the state write with the external answer of `finalize` in the final `caller.commit`, or writes the state and throws the error of `finalize`. | `src/intake/outbound.ts`       | 03, 04         |
| `ResultClass`    | `confirmed_failure`, `retryable_refusal`, `final_refusal`, `unknown_outcome`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/intake/contract.ts`       | 03, 04         |
| Human operations | `intake.outbound.request.list`, `get`, `discard`, `delete` of `intakeOperations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `src/intake/contract.ts`       | 10             |
| CLI group        | `intake` with the `outbound` leaves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `src/apps/cli/intake.ts`       | 05, 06, 09, 10 |

## Tasks

### 02.1 Add the outbound store

- Files: `src/intake/outbound-store.ts` (create), `src/intake/outbound-store.test.ts` (create), `src/intake/contract.ts` (edit)
- Do:
  1. In `src/intake/contract.ts`, declare `ResultClass` with the four values of `repository.vocabulary.md:28–36` and its schema, and `outboundRequestSchema` = `z.strictObject({ id: identitySchema("outbound_request"), projectId: identitySchema("project"), operation: z.enum(OutboundOperation), requestKey: z.string().min(1), state: z.enum(OutboundRequestState), result: z.unknown().nullable(), error: z.array(z.strictObject({ code: z.string(), message: z.string(), created_at: timestampSchema })).nullable(), createdAt: timestampSchema })`.
  2. Implement `insertPending(tx, row)` with `createIdentity("outbound_request")`, `state = "pending"`, `result = null`, `error = null`, and answer the identity. Detect the unique conflict of `(operation, request_key)` by its SQLite constraint error and throw `OutboundKeyConflict`; let every other failure propagate.
  3. Implement `findByKey`, `findById` and `outboundRecord`, which parses `result` and `error` from their canonical JSON and maps the row to the projection.
  4. Implement the conditional writes: `succeed(tx, id, result, expected)` runs `UPDATE intake_outbound_request SET state = 'succeeded', result = ? WHERE id = ? AND state IN (…)` with the canonical JSON of `result`; `fail(tx, id, item, now)` sets `failed` and `appendError` from `pending` only; `discard(tx, id)` sets `discarded` from `pending` only. Each answers whether one row changed.
  5. Add tests: the insert starts `pending` with null `result` and `error` and answers its identity; a second insert of one key throws `OutboundKeyConflict`; `succeed` from `pending` and from `failed` changes one row and from `succeeded` or `discarded` changes none; `fail` from `failed` changes none; two failures through two requests keep their own arrays; the projection answers `error` items with `created_at`.
- Rules:
  - `id` is `outbound_request_` and a ULID; `result` is JSON text of the bounded 2xx body or null; `error` holds the shape and the byte bound of an inbound event; every property name is snake_case. `intake-service.impl.md:162`, `:165`.
  - A unique index covers `(operation, request_key)`, and an insert that meets it reads the existing request. `intake-service.impl.md:164`, `:167`.
  - The call sets `succeeded` or `failed` through an update conditional on `pending`; a read-back match sets `succeeded` from `pending` or `failed`. `intake-service.impl.md:170–171`; `docs/reference/erd/03-integration.md:145–146`.
  - A human discard sets `discarded` on a `pending` request; `succeeded` and `discarded` are terminal. `docs/reference/erd/03-integration.md:147`.
  - No row holds credential material, the operands of the write or a digest of the operands. `docs/reference/erd/03-integration.md:149`.
- Done when: `node --test --test-timeout=30000 src/intake/outbound-store.test.ts` passes; `pnpm run verify` passes.

### 02.2 Add the outbound runner

- Files: `src/intake/outbound.ts` (create), `src/intake/outbound.test.ts` (create), `src/intake/service.ts` (edit)
- Do:
  1. Keep a module-private `Set<string>` of the request identities whose call or read-back runs, owned by the `IntakeService` instance and passed to the runner. An invocation records whether it added an identity, and only that owner removes it.
  2. Step one, in one `store.transaction` that reads `Date.now()` once: call `request.authorize(tx, now)`, which answers the operation, the project, the credential name and the material, and which throws its refusal before any insert; read `findByKey(tx, operation, requestKey)`. With no row, insert the `pending` row with `projectId` and `credential` from the authorization and add its identity to the set in the same synchronous step; an `OutboundKeyConflict` reads the existing row and takes the repeat rules below. With a row in the set, throw 409 `intake.outbound.request.in_flight` and add nothing. With a `discarded` row, throw 409 `intake.outbound.request.discarded`. With a `succeeded` row, take the finalization with the decoded stored result. With a `pending` or a `failed` row, add its identity to the set and take the read-back path.
  3. Step two, a fresh row: open one deadline scope, a `CancellationContext` of the caller `Context` with the deadline `request.deadlineMs`, and pass `{ context, signal }` to `request.call(material, scope)`. Race the call with the end of that scope, so a call that ignores the signal settles at the deadline; a later settlement is ignored and writes nothing. The outcome is the call answer, or `timeout` at the deadline.
  4. Step two, the read-back path: open the same deadline scope and race `readBack(material, scope)` once. The outcome is a match with its result, no match, or an unsuccessful read-back (a result class, a thrown error or the deadline), which counts as no match.
  5. Step three, one guarded state writer `writeState(tx, outcome)`: for a fresh success, encode the result with `request.resultCodec.encode`, assert that its canonical JSON fits `RESULT_MAX_BYTES`, then `succeed(… ["pending"])`; for a fresh failure, `fail` with `{ code: class, message: code + ": " + message }`; for a fresh timeout, `fail` with `{ code: "timeout", message }`; for a read-back match, encode the result and `succeed(… ["pending", "failed"])`; for no match, write nothing. A conditional write that changes no row reads the row again: a row in another state keeps that state; an absent row, which a human deleted during a read-back, is never recreated and never looked up again by its key.
  6. Step four, the finalization: `request.finalize(answer)` maps the runner answer to `{ kind: "answer"; body }` or `{ kind: "error"; error }`. The runner answer is the call result or the match result; `{ ok: false, class, code, message }` with the Repository code for a fresh failure; `unknown_outcome` with `code: "timeout"` at the deadline; for no match, `unknown_outcome` for a `pending` row and the newest stored error item for a `failed` row, with `class` = the stored `code` when it is a result class and `unknown_outcome` for `timeout`. For an answer, run `caller.commit((tx) => { writeState(tx, outcome); return body; })`, so the state write and the external answer commit together. For an error, run `store.transaction((tx) => writeState(tx, outcome))` and then throw the error, because a throw inside `caller.commit` rolls the state back.
  7. Remove an owned identity from the set, release the deadline scope and call `material?.drop()` in one `finally` block of every path, including a refusal of step one, a rejected call, a rejected read-back and a failed commit.
  8. Add tests with a fake authorization, a fake call, a fake read-back and a fake finalization:
     - a write whose answer times out after the effect answers `unknown_outcome` and stores `failed` with `timeout`, and a repeat whose read-back matches stores `succeeded` with one call in total;
     - a call that never settles and ignores its signal ends at the deadline, and its late resolution writes nothing;
     - a restart after the insert: a fixture closes the store after step one, a new service opens the same file, the start calls nothing, the row stays `pending`, and a repeat with no match answers `unknown_outcome` with no second call;
     - two concurrent runs of one key make one call and answer one 409 `intake.outbound.request.in_flight`; a discard after that refused repeat and before the first call ends still answers 409 `intake.outbound.request.in_flight`;
     - a repeat of `succeeded` answers its decoded result with no call and no read-back;
     - a repeat of a `failed` request whose read-back finds nothing answers the newest stored error exactly, with no second call;
     - a timed-out or refused read-back of a `pending` and of a `failed` request leaves the state and the error history unchanged;
     - a human delete of a `failed` request during its read-back, then a match: no row is recreated, and the repeat answers the match result;
     - a repeat of a `discarded` request answers 409 `intake.outbound.request.discarded`;
     - a refusal of `authorize` inserts no row and calls nothing;
     - a finalization to an error commits the `failed` state before the error reaches the caller;
     - a rejected call and a rejected read-back leave no owned identity in the set;
     - a result that fails its codec or its bound fails the commit and leaves no owned identity in the set;
     - `drop()` runs after a success, a failure and a refusal; no stored result, error or log record holds the material of the fake.
- Rules:
  - The handler authorizes, obtains the release, inserts the request as `pending`, commits, and only then performs the call. `intake-service.impl.md:166`; `docs/reference/erd/03-integration.md:144–145`. The `pending` insert and the `failed` write of an error answer are ruled writes of the index, each in a synchronous transaction that the handler owns; a later failure of the handler keeps them. `architecture.impl.md:700–704`; `intake-service.impl.md:170`; decision D3.
  - An insert that meets the unique index reads the existing request and answers the repeat rule. `intake-service.impl.md:167`.
  - A module-private `Set` holds every request whose call runs; the handler adds the identity in the synchronous step of its insert and removes it after the write of the answer; a repeat and a discard read the set and write in one synchronous step. `intake-service.impl.md:168`. A refused repeat owns no membership, so it removes none.
  - The deadline aborts the call through an `AbortController`; the handler then sets `failed` with `timeout`, and a late answer writes nothing. `intake-service.impl.md:169`. The timeout write belongs to the fresh call alone; a read-back that finds nothing changes no state. `intake-service.md:169`.
  - `code` holds the result class, the HTTP status, `timeout` or `cli.exit_<n>`. `intake-service.impl.md:170`. The runner stores the result class or `timeout`; the message keeps the Repository code (decision D11).
  - A repeat of `succeeded` answers `result`; of a running request 409 `intake.outbound.request.in_flight`; of `discarded` 409 `intake.outbound.request.discarded`; of `pending` with no running call or of `failed` the read-back once; no match answers `unknown_outcome` for `pending` and the newest error for `failed`. `intake-service.impl.md:172–173`; `intake-service.md:160–164`.
  - A read-back runs only inside a repeat, under the authorization and the release path of the write. `intake-service.md:166–168`.
  - Every outbound operation of ERD 3 declares a read-back (`intake-service.impl.md:178–181`), so `readBack` is required. `intake-service.md:171` lets an operation without a read-back leave `failed` through a discard, and `intake-service.impl.md:188` admits a discard of `pending` alone; no in-scope operation meets that conflict, and the report lists it for Ulrich.
  - `result` holds the bounded body of the 2xx answer with snake_case properties. `docs/reference/erd/03-integration.md:126`, `:148`. Each operation names its result codec, so a stored result keeps snake_case and the answer keeps the external field names.
  - A delete removes the row (`architecture.impl.md:103`), so a delete during a read-back is final.
  - A start runs nothing for an outbound request. `intake-service.impl.md:174`.
  - The holder drops the material in `finally`. `custody.impl.md:136`.
  - A read-back holds the in-flight set, so a discard during a read-back answers 409 `intake.outbound.request.in_flight`. The read-back is the call of the repeat (`intake-service.md:166`).
  - Gap: the byte bound of `result` is open (`docs/brainstorm/HANDOFF.md:46`); the constant follows decision D12.
- Done when: `node --test --test-timeout=30000 src/intake/outbound.test.ts` passes; `pnpm run verify` passes.

### 02.3 Declare the outbound list and get

- Files: `src/intake/contract.ts`, `src/intake/outbound-read.ts` (create), `src/intake/outbound-read.test.ts` (create), `src/intake/service.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `intakeOperations` in `src/intake/contract.ts` with `service: INTAKE_SERVICE_NAME`, `store: Operational`, `lifetime: Unary`, `access: Human` and the default 30 s timeout:
     - `outbound.request.list`: `GET /api/intake/outbound`, `mutation: false`, query `{ projectId?, state?, operation?, limit?, cursor? }`, output `{ items: OutboundRequest[], nextCursor: string \| null }`.
     - `outbound.request.get`: `GET /api/intake/outbound/:outboundRequestId`, `mutation: false`, output `OutboundRequest`.
  2. Implement both handlers inside one `caller.commit`: the list pages by `id` descending with the filters combined by AND, the shared cursor and `limit`; the get answers 404 `intake.outbound.request.not_found` for an absent row.
  3. Register both handlers. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Add `intakeOperations` to `apiOperations` of `openapi-integration.test.ts`, and assert both paths and their `x-access-policy` `human`.
  4. Add tests: an empty list answers `{ items: [], nextCursor: null }`; each filter and their combination; a page of two answers the newest first and a cursor; a malformed cursor answers 400 `system.pagination.cursor_invalid`; an unknown identity answers 404.
- Rules:
  - The two operations are `human`, `unary` reads at the routes of the command table. `engine/docs/cli/intake.md:61–62`, `:66–69`; `intake-service.impl.md:186–187`.
  - The list answers a bounded page in the order of `id`, filtered by project, state and operation. `intake-service.impl.md:186`; decision D23.
  - The projection holds no credential and no operand. `engine/docs/cli/intake.md:328–330`.
  - Each task publishes exactly the operations that it registers. ERD 2 `00-index.md` "Shared files".
- Done when: `node --test --test-timeout=30000 src/intake/outbound-read.test.ts src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 02.4 Declare the outbound discard and delete

- Files: `src/intake/contract.ts`, `src/intake/outbound-write.ts` (create), `src/intake/outbound-write.test.ts` (create), `src/intake/service.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `outbound.request.discard` (`POST /api/intake/outbound/:outboundRequestId/discard`, `mutation: true`, no body, output `OutboundRequest`) and `outbound.request.delete` (`POST /api/intake/outbound/delete`, `mutation: true`, body `z.strictObject({ force: z.boolean().optional(), state: z.enum(OutboundRequestState).optional(), from: identitySchema("outbound_request").optional(), to: identitySchema("outbound_request").optional(), ids: z.array(identitySchema("outbound_request")).min(1).max(DELETE_IDS_MAX).optional() })`, output `{ count: number }`).
  2. Discard: 404 for an absent row; inside the commit, read the in-flight set and answer 409 `intake.outbound.request.in_flight` for a running request, 409 `intake.outbound.request.state_conflict` for a state other than `pending`, else `discard` and answer the projection.
  3. Delete: `force` absent or not `true` answers 400 `intake.outbound.request.force_required`; then exactly one filter form must stand, `{ state, from, to }` with all three or `{ ids }`, and the state must not be `pending`, else 400 `intake.outbound.request.filter_invalid`; an `ids` list that names a `pending` row answers 409 `intake.outbound.request.state_conflict` and deletes nothing; a range deletes the rows of its one state whose `id` lies in the inclusive range; delete the matching rows in the commit and answer `{ count }`.
  4. Register both handlers, regenerate OpenAPI and assert both paths.
  5. Add tests through the HTTP adapter: a delete with `force` absent and with `force: false` answers 400 `intake.outbound.request.force_required`; no filter, both filters and the state `pending` answer 400 `intake.outbound.request.filter_invalid`; an `ids` list with a `succeeded` and a `pending` row deletes nothing; a range of `failed` removes the `failed` rows of the range alone; an `ids` delete with a missing identity counts the others; a discard of a running request answers 409 and the running write keeps its result; a discard of a `failed` request answers 409 `intake.outbound.request.state_conflict`.
- Rules:
  - A discard turns a `pending` request with no running call to `discarded`; a running request answers 409 `intake.outbound.request.in_flight`; every other state answers 409 `intake.outbound.request.state_conflict`. `intake-service.impl.md:188`.
  - A delete without `force: true` answers 400 `intake.outbound.request.force_required`; without a filter, with both filters or with the state `pending` 400 `intake.outbound.request.filter_invalid`; a list that names a pending request answers 409 and deletes nothing; one transaction deletes and answers the count. `intake-service.impl.md:189–191`; `docs/reference/erd/03-integration.md:150`.
  - The handler answers `force_required` itself, so the schema admits an absent `force`. `engine/docs/cli/intake.md:164`, `:361–365`.
  - A human override takes the body field `force: true`. Root `AGENTS.md` "Contracts".
  - Gap: the bound of `ids` and the row bound of a range are open (`engine/docs/cli/intake.md:163`, `:319–320`; `docs/brainstorm/HANDOFF.md:46`); decision D12.
- Done when: `node --test --test-timeout=30000 src/intake/outbound-write.test.ts src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 02.5 Add the `intake` CLI group and the `outbound` leaves

- Files: `src/apps/cli/intake.ts` (create), `src/apps/cli/constants.ts`, `src/apps/cli/index.ts`, `src/apps/cli/index.test.ts` (edit)
- Do:
  1. Add `Intake: "intake"` to `CommandName`. Register the `intake` group in `createProgram` with the subgroup `outbound`, and add `intakeOperations` to `apiOperations` of `src/apps/cli/index.ts`.
  2. Add the leaves of the synopses of `engine/docs/cli/intake.md:113–127`: `outbound list [--project <id>] [--state <state>] [--operation <operation>] [--limit <n>] [--cursor <cursor>]`; `outbound get <outbound-request-id>`; `outbound discard <outbound-request-id> [--idempotency-key <ulid>]`; `outbound delete [--force] [--state <state>] [--from <id>] [--to <id>] [--id <id> ...] [--idempotency-key <ulid>]`, where `--id` accumulates and every other value option is single-use (`cli.option.duplicate`). Every leaf takes `--endpoint` and `--token`.
  3. Validate each positional identity with `identitySchema("outbound_request")` and refuse it with `cli.intake.outbound.get.invalid_outbound_request_id` or `cli.intake.outbound.discard.invalid_outbound_request_id` (`engine/docs/cli/intake.md:474`). Send `body.force` as `false` when `--force` is absent, and send an omitted filter as absent.
  4. Resolve the token with `requireToken(token, "cli.intake.outbound.<command>.token_required")`. Map each result through `handleMutationResult` or `handleReadResult` of `src/apps/cli/shared.ts`, so an indeterminate mutation answers `cli.intake.outbound.<command>.indeterminate` with the effective key. A mutation prints the answer with `idempotencyKey`.
  5. Add tests: `intake --help`, `intake outbound --help` and each leaf `--help` exit 0 with no server; each leaf rejects `--config`; `outbound get bad` exits 1 with `cli.intake.outbound.get.invalid_outbound_request_id:`; an indeterminate `outbound discard` with a generated key prints that key on stderr.
- Rules:
  - Every group and leaf supports help without a server or credential; the commands reject unknown arguments, missing values and `--config`. `engine/docs/cli/intake.md:129–131`.
  - The flags map to the query and the body of the request; `--id` is repeatable. `engine/docs/cli/intake.md:143–164`.
  - Mutation results include the effective `idempotencyKey`; the CLI performs no automatic retry. `engine/docs/cli/intake.md:428–432`.
  - The CLI code of one command names that command. `architecture.impl.md:349`. The `invalid_<argument>` codes stand on `engine/docs/cli/intake.md:474`; the `token_required` and `indeterminate` codes follow the templates of `engine/docs/cli/other.md` "Error codes".
  - A machine token authorizes no Intake command. `engine/docs/cli/intake.md:47–48`.
- Done when: `node --test --test-timeout=30000 src/apps/cli/index.test.ts` passes; `pnpm run verify` passes.

### 02.E E2E proof

- Files: `src/apps/server/e2e-outbound-record.test.ts` (create)
- Do:
  1. Start `gatewayFixture` and run the scenarios E02.1 to E02.7 of `## E2E` through the CLI.
  2. Parse stdout as JSON for every success. Assert the exit code and the start of stderr for every refusal.
- Rules:
  - Setup goes through the CLI, and the state check is a CLI read. ERD 1 decision D13.
  - No operation of this plan writes a request, so the E2E proves the empty reads and the refusals; the runner tests of task 02.2 prove the state rules, and plans 03 and 04 prove the rows through their writes (E03, E04).
  - Task 02.5 registers the `intake` group, which plan 01 never asserts absent.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-outbound-record.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-outbound-record.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` and `kanthord(args, env)` of `src/apps/server/cli-support.ts`. A command uses `KANTHORD_TOKEN = fixture.token` unless the row names `[M]`, a machine token of `generateMachineToken` (ERD 2 plan 10 task 10.7).
- `R` names the identity `outbound_request_01ARZ3NDEKTSV4RRFFQ69G5FAV`, which no row holds.

| Id    | Commands                                                                                                                                                                                              | Exit   | Expect                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| E02.1 | `kanthord intake outbound list`                                                                                                                                                                       | 0      | `items` `[]`, `nextCursor` null                                                                                                   |
| E02.2 | `kanthord intake outbound get R`; `kanthord intake outbound discard R`                                                                                                                                | 1, 1   | stderr starts with `intake.outbound.request.not_found:` twice                                                                     |
| E02.3 | `kanthord intake outbound delete --state failed --from R --to R`                                                                                                                                      | 1      | stderr starts with `intake.outbound.request.force_required:`                                                                      |
| E02.4 | `kanthord intake outbound delete --force`; `kanthord intake outbound delete --force --state pending --from R --to R`; `kanthord intake outbound delete --force --state failed --from R --to R --id R` | 1 each | stderr starts with `intake.outbound.request.filter_invalid:` three times                                                          |
| E02.5 | `kanthord intake outbound delete --force --state failed --from R --to R`                                                                                                                              | 0      | `count` 0, `idempotencyKey` a ULID                                                                                                |
| E02.6 | `kanthord intake outbound get bad`; `kanthord intake outbound list --state done`                                                                                                                      | 1, 1   | first stderr starts with `cli.intake.outbound.get.invalid_outbound_request_id:`; second with `gateway.request.validation_failed:` |
| E02.7 | `kanthord intake outbound list` [M]                                                                                                                                                                   | 1      | stderr starts with `gateway.authentication.unauthorized:`                                                                         |
