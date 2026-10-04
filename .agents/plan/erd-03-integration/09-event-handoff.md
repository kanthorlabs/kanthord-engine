# Plan 09: Intake Service — events and handoff

## Scope

This plan delivers:

- The dispatcher: the in-memory in-flight set, the synchronous selection of a pending event, the one handoff to the consumer of its inbound through the direct adapter under the Intake service identity, the conditional state write with the bounded `error` append, and the handoff of every pending event at a start.
- The human event writes `intake.inbound.event.retry`, `intake.inbound.event.discard` and `intake.inbound.event.delete` with their OpenAPI and their CLI leaves `event retry`, `event discard` and `event delete`.
- The consumer wiring of `mission.delivery.admit`.
- The move of the acquisition tests of plans 06 and 07 to the live dispatcher.
- The E2E of the chain: a signed GitHub delivery, its storage, its handoff, delivery admission, the Intake check and the end state of the request.

Out of scope:

- An automatic retry, a backoff, an attempt bound or a handoff window (root `AGENTS.md` "Rejected proposals").
- An automatic retention or a delete without a filter (root `AGENTS.md` "Rejected proposals").
- The event reads (plan 06) and the content of an event (`docs/brainstorm/HANDOFF.md:61`).

## Sources

- `docs/reference/erd/03-integration.md:29`, `:135–139` — the in-memory set of running handoffs; the event state, the error array, the delete, the bound.
- `docs/brainstorm/intake-service.md:104–122` — the handoff.
- `docs/brainstorm/intake-service.md:177–185` — capacity and retention of events.
- `docs/brainstorm/intake-service.md:194–195` — the human authority over events.
- `docs/brainstorm/intake-service.vocabulary.md:48–53` — the inbound event state.
- `docs/brainstorm/intake-service.impl.md:13–15` — the dispatcher calls a peer with the service identity.
- `docs/brainstorm/intake-service.impl.md:73–90` — the handoff and the event delete.
- `docs/brainstorm/intake-service.impl.md:94–115` — the error codes.
- `docs/brainstorm/intake-service.impl.md:221–222`, `:231–234` — the tests of the handoff and the event writes.
- `docs/brainstorm/mission-service.md:820–829`, `:850` — admission is idempotent; a failed check marks the event failed and a human retries it.
- `docs/brainstorm/architecture.impl.md:458–479`, `:691–693` — the stop phases; a background producer calls a peer through the direct adapter with its service identity.
- `docs/brainstorm/architecture.impl.md:700–708` — the handler and its commit; the dispatcher runs outside a handler.
- `engine/docs/cli/intake.md:56–60`, `:94–111`, `:154–157`, `:265–324` — the event commands and their statuses.
- `engine/docs/cli/intake.md:443–473` — the error codes.
- Decisions D3, D7, D12, D15, D16, D23 of `decisions.md`.

### Contract keys

| Key                                   | Where                         | Owner line                                  |
| ------------------------------------- | ----------------------------- | ------------------------------------------- |
| `inboundEventId`                      | path of `retry` and `discard` | `engine/docs/cli/intake.md:150`             |
| `state`, `from`, `to`, `ids`          | body of `event delete`        | `engine/docs/cli/intake.md:155–157`, `:313` |
| `count`                               | answer of `event delete`      | `engine/docs/cli/intake.md:318`             |
| `code`, `message`, `created_at`       | an item of `error`            | `intake-service.impl.md:79`                 |
| the input of `mission.delivery.admit` | the handoff                   | `mission-service.impl.md:253`; decision D16 |

## Depends on

- Plan 01: `appendError`, the closed sets, the Intake service identity.
- Plan 06: the event store, the receipt, `wake()`, the event reads, `deliver`.
- Plan 07: the poll, which calls `wake()` after a batch.
- Plan 08: `mission.delivery.admit`.
- No stand-in: the handoff calls the real admission (decision D5).

## Provides

| Seam         | TypeScript signature                                                                                                      | Owner file                                         | Consumer plans |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------- |
| Consumers    | `IntakeConsumers = { "mission.delivery.admit": (input, options) => Promise<OperationResult<unknown>> }` (declared inline) | `src/intake/contract.ts`                           | 10             |
| Dispatcher   | `Dispatcher { wake(): void; inFlight(id): boolean; join(): Promise<void> }`                                               | `src/intake/dispatcher.ts`                         | 06, 07, 10     |
| Event writes | `intake.inbound.event.retry`, `discard`, `delete`; CLI `event retry`, `event discard`, `event delete`                     | `src/intake/contract.ts`, `src/apps/cli/intake.ts` | 10             |

## Tasks

### 09.1 Declare and wire the consumer

- Files: `src/intake/contract.ts`, `src/intake/service.ts`, `src/intake/service.test.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. Declare inline `IntakeConsumers` and add `consumers: IntakeConsumers` to the Intake `Dependencies` as a required field; update every Intake fixture of `Dependencies` with a fake that records its calls.
  2. In `composeServices`, pass `consumers: { "mission.delivery.admit": (input, options) => missionClient["delivery.admit"]({ params: {}, query: {}, body: input }, options) }`, where `missionClient = directClient(missionOperations, invocation)`.
  3. Assert at `start()` that `consumers` holds one function for each value of `Consumer`.
- Rules:
  - The consumer of an inbound event is the delivery admission operation that its inbound names. `intake-service.md:106`.
  - The Intake Service reaches a peer through an operation only, and the dispatcher calls it through the direct adapter with the service identity. `intake-service.md:33`; `intake-service.impl.md:15`, `:75`.
  - The closed consumer set holds `mission.delivery.admit`. `intake-service.vocabulary.md:25`.
- Done when: `node --test --test-timeout=30000 src/intake/service.test.ts` passes; `pnpm run verify` passes.

### 09.2 Add the dispatcher module

- Files: `src/intake/dispatcher.ts` (create), `src/intake/dispatcher.test.ts` (create), `src/intake/event-store.ts`, `src/intake/service.ts` (edit)
- Do:
  1. Keep a module-private `Set<string>` of the events whose handoff runs, owned by the `IntakeService` instance.
  2. `wake()` starts one drain when none runs and marks a second pass otherwise. A drain repeats: read the oldest `pending` event outside the set, ordered by `id`, as a candidate; then, in one synchronous step with no await, read the state of the candidate again and add its identity to the set only when it is still `pending`; skip a candidate that left `pending`. With no candidate, end the drain, or run once more when a pass was marked.
  3. Build the admission input from the event row and its inbound row: `inboundEventId`, `projectId`, `platform`, `resource` of `configuration`, `event` in canonical base64 and `metadata`. Call `consumers[inbound.consumer]` with `{ identity: intakeIdentity, idempotencyKey: ulid(), context }`, a fresh ULID idempotency key for each handoff.
  4. In one `store.transaction`, write `succeeded` for `Completed`, or `failed` with `appendError` of `{ code, message, created_at }`: the code and the message of the answer for `Failure`, `indeterminate` with a fixed message for `Indeterminate`, and `system.operation.unknown` with a fixed message for a thrown consumer call, which is a defect; each update is conditional on `pending`. Remove the identity from the set in a `finally` block after that write, so no thrown call leaves a `pending` event that a later wake hands over again.
  5. Keep the dispatcher inactive in this task: the service does not call it yet, and the tests drive it directly.
  6. Add tests with a fake consumer:
     - the restart case: a child process runs a service over a file store and a consumer that never answers; the test kills the child with `SIGKILL` after the event is in flight and still `pending`, starts a new service over the same file, and the start hands the event over once more with the same identity and content;
     - three pending events at a start reach the consumer in the order of `id`, each once;
     - repeated `wake()` calls during a handoff start no second handoff of the event;
     - a store-level discard that wins before the reservation step starts no handoff, and the consumer sees no call;
     - two failures and one retry leave two items in `error`; a `failed` event stays untouched without a retry;
     - an append to a full `error` drops the oldest item and sets `failed`;
     - an indeterminate answer appends `indeterminate`;
     - two handoffs of one event, a first one and one after a human retry, carry two different idempotency keys and the same event identity and content;
     - a 409 `mission.node.claim_live` or 409 `mission.delivery.match_changed` answer of the consumer sets `failed` with that code;
     - a thrown consumer call writes `failed` with `system.operation.unknown`, leaves no identity in the set, and a later wake makes no second call;
     - the error holds no credential material.
- Rules:
  - The dispatcher reads pending events in the order of `id` and hands each one to the `consumer` of its inbound through the direct adapter under the service identity. `intake-service.impl.md:75`; `intake-service.impl.md:15`.
  - A module-private `Set` holds every event whose handoff runs; the dispatcher re-reads the state of one event and adds its identity in one synchronous step; a discard reads the set and writes in one synchronous step. `intake-service.impl.md:76–77`.
  - An answer sets `succeeded`; a declared failure or an indeterminate result sets `failed` and appends the error, conditional on `pending`; the array is bounded and holds no credential material. `intake-service.impl.md:78–79`; `docs/reference/erd/03-integration.md:136–137`.
  - The dispatcher retries nothing and holds no backoff; at a start it hands every pending event over. `intake-service.impl.md:80`; `intake-service.md:110`, `:113`.
  - A repeat carries the same event identity and the same content; each handoff calls the consumer with a fresh ULID idempotency key. `intake-service.impl.md:81`; `intake-service.md:114`; `docs/reference/erd/03-integration.md:135`.
  - The input of `mission.delivery.admit` holds `inboundEventId`, `projectId`, `platform`, `resource`, `event` and `metadata`. `mission-service.impl.md:253`; `engine/docs/cli/mission.md:888`.
  - The disposition stays in the span of the consumer. `intake-service.md:111`; decision D15.
  - The dispatcher runs outside a handler and owns its transactions (decision D3).
  - A declared failure appends its error code, and an indeterminate result appends the code `indeterminate`. `intake-service.impl.md:79`. `engine/docs/cli/intake.md` names the item shape and `indeterminate` in the event read projection.
- Done when: `node --test --test-timeout=30000 src/intake/dispatcher.test.ts` passes; `pnpm run verify` passes.

### 09.3 Declare and implement `retry` and `discard`

- Files: `src/intake/contract.ts`, `src/intake/event-write.ts` (create), `src/intake/event-write.test.ts` (create), `src/intake/service.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.event.retry` (`POST /api/intake/event/:inboundEventId/retry`) and `inbound.event.discard` (`POST /api/intake/event/:inboundEventId/discard`), both `human`, `mutation: true`, no body, output the event projection.
  2. Retry: 404 `intake.inbound.event.not_found` for an absent row; `pending` answers its projection; `failed` turns `pending` with an update conditional on `failed`; `succeeded` and `discarded` answer 409 `intake.inbound.event.state_conflict`. Call `wake()` after the commit.
  3. Discard: 404 for an absent row; inside the commit, read the in-flight set: a `pending` event in the set answers 409 `intake.inbound.event.in_flight`; `pending` or `failed` turns `discarded` with an update conditional on the read state; `succeeded` and `discarded` answer 409 `intake.inbound.event.state_conflict`.
  4. Add tests: each transition and each refusal; a discard after the reservation of a handoff answers 409, and the handoff writes its state; a retried event is handed over once more after task 09.6.
- Rules:
  - `intake.inbound.event.retry` turns a failed event to `pending`; a pending event answers its current state; a succeeded or a discarded event answers 409 `intake.inbound.event.state_conflict`. `intake-service.impl.md:82`.
  - `intake.inbound.event.discard` turns a pending or a failed event to `discarded`; a pending event in the in-flight set answers 409 `intake.inbound.event.in_flight`. `intake-service.impl.md:83`.
  - Discarded is terminal, and every write of the state is conditional. `intake-service.md:117–119`.
  - Statuses. `engine/docs/cli/intake.md:291–309`.
- Done when: `node --test --test-timeout=30000 src/intake/event-write.test.ts` passes; `pnpm run verify` passes.

### 09.4 Declare and implement `event delete`

- Files: `src/intake/contract.ts`, `src/intake/event-write.ts`, `src/intake/event-write.test.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.event.delete`: `POST /api/intake/event/delete`, `human`, `mutation: true`, body `z.strictObject({ state: z.enum(InboundEventState).optional(), from: identitySchema("inbound_event").optional(), to: identitySchema("inbound_event").optional(), ids: z.array(identitySchema("inbound_event")).min(1).max(DELETE_IDS_MAX).optional() })`, output `{ count }`.
  2. Answer 400 `intake.inbound.event.filter_invalid` unless exactly one form stands, `{ state, from, to }` with all three or `{ ids }`, and the state is not `pending`. An `ids` list that names a `pending` event answers 409 `intake.inbound.event.state_conflict` and deletes none of the named rows. A range deletes the events of its one state whose `id` lies in the inclusive range. Delete in the commit and answer the count.
  3. Add tests: no filter, both filters and the state `pending`; a list that names a `succeeded` and a `pending` event deletes neither; each state filter over a range of mixed states removes that state alone, both bounds included.
- Rules:
  - The input holds a state with a ULID range of `id`, or a list of exact identities; a missing filter or the state `pending` answers 400; a list that names a pending event answers 409 and deletes nothing; one transaction deletes and answers the count. `intake-service.impl.md:87–90`; `docs/reference/erd/03-integration.md:138`.
  - A delete removes the three deletable states that are not `pending`. `intake-service.md:183`.
  - No process deletes an event by itself. `intake-service.md:180`.
  - Gap: the row bound of a delete is open (`engine/docs/cli/intake.md:319–320`; `docs/brainstorm/HANDOFF.md:46`); decision D12.
- Done when: `node --test --test-timeout=30000 src/intake/event-write.test.ts` passes; `pnpm run verify` passes.

### 09.5 Add the CLI leaves of the event writes

- Files: `src/apps/cli/intake.ts`, `src/apps/cli/index.test.ts` (edit)
- Do:
  1. Add `event retry <inbound-event-id> [M] [R]`, `event discard <inbound-event-id> [M] [R]` and `event delete (--state <state> --from <inbound-event-id> --to <inbound-event-id> | --id <inbound-event-id> ...) [M] [R]` with the synopsis of the page; the options parse as optional, `--id` accumulates, and an invalid combination reaches the server validation.
  2. Validate each positional identity with `cli.intake.event.<command>.invalid_inbound_event_id` (`engine/docs/cli/intake.md:474`); send an omitted filter as absent; map each result through `handleMutationResult`, so a mutation prints its `idempotencyKey`.
  3. Add tests: help of each leaf; `event retry bad` exits 1 with `cli.intake.event.retry.invalid_inbound_event_id`.
- Rules:
  - The synopses and the flag mapping. `engine/docs/cli/intake.md:101–111`, `:155–157`.
  - Mutation results include the effective `idempotencyKey`. `engine/docs/cli/intake.md:428`.
- Done when: `node --test --test-timeout=30000 src/apps/cli/index.test.ts` passes; `pnpm run verify` passes.

### 09.6 Activate the dispatcher and move the acquisition tests

- Files: `src/intake/service.ts`, `src/intake/service.test.ts`, `src/apps/server/e2e-webhook-acquisition.test.ts`, `src/apps/server/e2e-poll-acquisition.test.ts`, `src/intake/receipt.test.ts`, `src/intake/poll.test.ts` (edit)
- Do:
  1. Call `wake()` at the end of `run()`, after a receipt commit, after a poll batch and after a retry. In `quiesce()`, stop starting new handoffs; `drain()` awaits `join()`, so phase 2 joins the running handoff.
  2. In both E2E files, change every expectation of a `pending` event that the live dispatcher now hands over to its handoff outcome: an event of no request of the project answers `refused` with `unmatched`, so the event reads `succeeded`.
  3. Move the proofs of the capacity bound and of the refused delete with a pending event to `src/intake/receipt.test.ts` and `src/intake/poll.test.ts`, on a service that runs no dispatcher, and delete those rows from the E2E files.
- Rules:
  - An answer of the consumer sets `succeeded` whatever the disposition. `intake-service.md:111`; `intake-service.vocabulary.md:52`.
  - The plan that wires a real peer proves the real rule and keeps no stand-in. ERD 1 decision D14.
- Done when: `node --test --test-timeout=30000 src/intake/service.test.ts src/apps/server/e2e-webhook-acquisition.test.ts src/apps/server/e2e-poll-acquisition.test.ts src/intake/receipt.test.ts src/intake/poll.test.ts` passes; `pnpm run verify` passes. The activation and the moved tests land in one commit, so every intermediate commit passes `pnpm run verify`.

### 09.E E2E proof

- Files: `src/apps/server/e2e-event-handoff.test.ts` (create)
- Do:
  1. Start `fakeGitHub(t)`, the bare repository `gated` and `gatewayFixture` with the fixture platforms of plan 03.
  2. Build objectives P and P2 of plan 03 "E2E" on the binding `gated` to `External.Requested` with the pull requests 1 and 2, P2 after P, and the webhook inbound `W` of `owner/gated` (`hook.json` of plan 06 "E2E" with `"resource": "owner/gated"`) → secret `S`.
  3. Run E09.1 to E09.8 in one test in table order, with the test option `{ timeout: 60000 }`. Poll a CLI read every 50 ms for at most 10 s where a row waits for the dispatcher. Release every hold of `fakeGitHub` in the test cleanup.
- Rules:
  - Setup goes through the CLI; the receipt goes over HTTP through `deliver`; the state check is a CLI read. ERD 1 decision D13.
  - A failed read answers at once for a 5xx (decision D11), so E09.1 needs no retry budget.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-event-handoff.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-event-handoff.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`, `fakeGitHub`, `deliver`, `kanthord(args, env)`. `H` names the human token.
- `closed(n)` names `{ "action": "closed", "number": n, "pull_request": { "merged": true }, "repository": { "full_name": "owner/gated" } }`. `m` names the 40-character commit `eeee…e`. `ev(d)` names the step "`kanthord intake event list --inbound <W>`, then the `id` of the item whose `eventId` is `d`".

| Id    | Commands                                                                                                                                                                                                                                                                                        | Exit               | Expect                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E09.1 | `gitHub.failPulls(502)`; `deliver(W, S, "pull_request", "d-1", closed(1))`; wait; `ev("d-1")` → `E1`; `kanthord intake event get <E1>`; `kanthord mission node get <P>`                                                                                                                         | 202, 0, 0, 0       | `state` `failed` with one `error` item whose `code` is `repository.platform.github.retryable_refusal`; `state` `External.Requested`                                  |
| E09.2 | `kanthord intake event discard <E1>`; `kanthord intake event retry <E1>`                                                                                                                                                                                                                        | 0, 1               | first `state` `discarded`; second stderr starts with `intake.inbound.event.state_conflict:`                                                                          |
| E09.3 | `gitHub.failPulls(null)`; `gitHub.merge(1, m)`; `deliver(W, S, "pull_request", "d-2", closed(1))`; wait; `ev("d-2")` → `E2`; `kanthord intake event get <E2>`; `kanthord mission node get <P>`; `kanthord mission evidence list <P> --attempt 1`                                                | 202, 0, 0, 0, 0    | `state` `succeeded`, `error` null; `state` `Completed`; the landed-commit evidence holds `inbound_event_id` = `E2`                                                   |
| E09.4 | `deliver(W, S, "pull_request", "d-3", closed(1))`; wait; `ev("d-3")` → `E3`; `kanthord intake event get <E3>`; `kanthord mission evidence list <P> --attempt 1`                                                                                                                                 | 202, 0, 0, 0       | `state` `succeeded` (admission answered `duplicate`); one landed-commit evidence                                                                                     |
| E09.5 | `const release = gitHub.hold()`; `deliver(W, S, "pull_request", "d-4", closed(2))`; wait until `gitHub.calls` holds the read of pull request 2; `ev("d-4")` → `E4`; `kanthord intake event discard <E4>`; `release()`; wait; `kanthord intake event get <E4>`; `kanthord mission node get <P2>` | 202, 0, 1, —, 0, 0 | stderr starts with `intake.inbound.event.in_flight:`; `state` `succeeded`; `state` `External.Requested`, because pull request 2 is open and the check answers `none` |
| E09.6 | `kanthord intake event delete --state pending --from <E1> --to <E4>`; `kanthord intake event delete`                                                                                                                                                                                            | 1, 1               | stderr starts with `intake.inbound.event.filter_invalid:` twice                                                                                                      |
| E09.7 | `kanthord intake event delete --state succeeded --from <E1> --to <E4>`; `kanthord intake event list --inbound <W>`                                                                                                                                                                              | 0, 0               | `count` 3; one item `E1` `discarded`                                                                                                                                 |
| E09.8 | `kanthord intake event delete --id <E1>`; `kanthord intake inbound delete <W>`                                                                                                                                                                                                                  | 0, 0               | `count` 1; the inbound delete calls no platform                                                                                                                      |

E09.1 asserts the error item code `repository.platform.github.retryable_refusal` of `engine/docs/cli/intake.md:470`. E09.2, E09.5 and E09.6 assert the codes of `engine/docs/cli/intake.md:446`, `:458–459`.
