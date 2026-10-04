# Plan 06: Intake Service — webhook

## Scope

This plan delivers:

- The `delivery` route outside `/api/`: the registry rule of the `/hooks/` prefix, its HTTP route and its OpenAPI entry (decision D13).
- The receipt `intake.inbound.event.receive` at `POST /hooks/:inboundId`: the inbound lookup, the signature verification over the exact bytes, the verified handshake, the capacity bound, the deduplicated insert and the acknowledgement after the commit.
- The delivery classification of the GitHub implementation of the Repository component.
- The event reads `intake.inbound.event.list` and `intake.inbound.event.get` with their CLI leaves `event list` and `event get`. They move here from plan 09, because the receipt is the first writer of `intake_inbound_event` and its E2E needs a CLI read of the stored event (ERD 1 decision D13).
- The fixture extension `deliver`.

Out of scope:

- The handoff and the human event writes `retry`, `discard` and `delete` (plan 09). An event of this plan stays `pending` until plan 09.
- A `GET` receipt route and a Slack challenge (`docs/brainstorm/HANDOFF.md:59`; `intake-service.impl.md:57`).
- The content of an event in `event get` (`docs/brainstorm/HANDOFF.md:61`).
- The webhook resource healthcheck (plan 10).
- Every platform call for a webhook inbound: kanthord registers no webhook at a platform, and a human sets the address, the verification secret and the events at the platform (`intake-service.impl.md:39–40`; `docs/reference/erd/03-integration.md:128`). The create and the delete of a webhook inbound are complete in plan 05.

## Sources

- `docs/reference/erd/03-integration.md:62–71`, `:114`, `:127–128`, `:131–139` — the event columns; the derived secret; a human sets the address and the secret at the platform; the event constraints.
- `docs/brainstorm/intake-service.md:87–102` — inbound events: verification, storage, acknowledgement, handshake, deduplication.
- `docs/brainstorm/intake-service.md:177–179` — the capacity bound: a webhook receives a retryable refusal; no acknowledged event is dropped.
- `docs/brainstorm/intake-service.vocabulary.md:27–41` — inbound event, handshake, platform event identity.
- `docs/brainstorm/intake-service.impl.md:37–61` — the webhook acquisition, the secret, the receipt `intake.inbound.event.receive`.
- `docs/brainstorm/intake-service.impl.md:94–115` — the error codes.
- `docs/brainstorm/intake-service.impl.md:225–228` — the tests of the receipt.
- `docs/brainstorm/gateway-service.impl.md:41`, `:204–210` — the `delivery` policy; the exact bytes and the 50 MiB limit.
- `docs/brainstorm/gateway-service.impl.md:482–501`, `:507–512` — the `/hooks/*` path group and the entry paths.
- `docs/brainstorm/architecture.impl.md:645–647` — the delivery policy mints no identity; the acknowledgement follows the commit.
- `docs/brainstorm/repository.md:43–49` — the platform implementation fills the event identity and the metadata, and declares its handshakes.
- `docs/brainstorm/repository.impl.md:15` — the GitHub implementation.
- `engine/docs/cli/intake.md:56–57`, `:94–99`, `:154–155`, `:173–184`, `:265–289` — the event reads.
- `engine/docs/cli/intake.md:379–399` — the receipt route.
- `engine/src/kernel/operation.ts:122–140` — the path rule and the delivery rules of the registry.
- `engine/src/gateway/service.ts:376–470`, `engine/src/gateway/invocation.ts:288–290` — the exact-byte adapter.
- Decisions D12, D13, D14, D15, D17 of `decisions.md`.

### Contract keys

| Key                                                                     | Where                         | Owner line                                |
| ----------------------------------------------------------------------- | ----------------------------- | ----------------------------------------- |
| `inboundId`                                                             | path of the receipt           | `engine/docs/cli/intake.md:381`           |
| `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`            | headers of a GitHub delivery  | `intake-service.impl.md:54`, `:57`, `:60` |
| `event`                                                                 | `metadata` of a webhook event | `intake-service.impl.md:60`               |
| `id`, `inboundId`, `eventId`, `metadata`, `state`, `error`, `createdAt` | the event read projection     | `engine/docs/cli/intake.md:267–269`       |
| `inboundEventId`                                                        | path of `event get`           | `engine/docs/cli/intake.md:150`           |
| `inboundId`, `state`, `limit`, `cursor`                                 | query of `event list`         | `engine/docs/cli/intake.md:154–155`       |

## Depends on

- Plan 01: `intake_inbound_event`, the closed sets, `PENDING_EVENT_LIMIT`.
- Plan 03: `GitHubPlatform`.
- Plan 05: the inbound store, `webhookSecret`, and the create and delete operations of a webhook inbound.
- No stand-in. `IntakeService.wake()` is a method of this plan that does nothing until plan 09 adds the dispatcher.

## Provides

| Seam                        | TypeScript signature                                                                                                                                                                     | Owner file                                                                    | Consumer plans |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------- |
| Delivery route              | an operation with `access: Delivery` and a path under `/hooks/`                                                                                                                          | `src/kernel/operation.ts`, `src/gateway/service.ts`, `src/gateway/openapi.ts` | 06             |
| `GitHubPlatform` (delivery) | `classifyDelivery(headers): { kind: "handshake"; status: 204 } \| { kind: "event"; eventId; metadata: { event } } \| { kind: "invalid" }`                                                | `src/repository/github.ts`                                                    | 06             |
| Event store (part)          | `findEvent(tx, inboundId, eventId)`; `insertEvent(tx, { inboundId; eventId; event: Uint8Array; metadata }): string`; `pendingCount(tx): number`; `readEvent(tx, id)`; `eventRecord(row)` | `src/intake/event-store.ts`                                                   | 07, 09         |
| `IntakeService.wake`        | `(): void` — no-op until plan 09                                                                                                                                                         | `src/intake/service.ts`                                                       | 07, 09         |
| Receipt                     | `intake.inbound.event.receive`                                                                                                                                                           | `src/intake/contract.ts`                                                      | 09, 10         |
| Event reads                 | `intake.inbound.event.list`, `intake.inbound.event.get`; CLI `event list`, `event get`                                                                                                   | `src/intake/contract.ts`, `src/apps/cli/intake.ts`                            | 09, 10         |
| Fixtures                    | `deliver(fixture, { inboundId; secret; event; deliveryId; body; signature?: string \| null })` answering `{ status; body }`; the `gatewayFixture` option `intake: { pendingEventLimit }` | `src/apps/server/test-support.ts`                                             | 07, 09, 10     |

## Tasks

### 06.1 Admit a delivery route under `/hooks/`

- Files: `src/kernel/operation.ts`, `src/kernel/operation.test.ts`, `src/gateway/service.ts`, `src/gateway/openapi.ts`, `src/gateway/openapi.test.ts`, `src/gateway/service.test.ts` (all edit)
- Do:
  1. In `register`, admit a path that starts with `/hooks/` for an operation with `access: Delivery` alone; keep `/api/` for every other operation; replace the message "Delivery verification and deduplication belong to the Scheduler Service." with "A delivery operation is no mutation."
  2. In `registerRoutes`, register the delivery route like any route; it reads the exact bytes already (`src/gateway/service.ts:420–425`).
  3. In `src/gateway/openapi.ts`, emit the path with `x-access-policy: delivery`, an `application/octet-stream` request body, no security requirement, and the empty responses that the operation declares (`202` and `204`).
  4. Add tests: a delivery at `/hooks/:id` registers; a `human` operation under `/hooks/` throws; the handler receives the exact bytes of a body that is not canonical JSON; a body above 50 MiB answers 413; the emitted path holds no security and both empty responses.
- Rules:
  - A delivery uses the path group `/hooks/*`; a webhook delivery enters through a route of the registry; each operation declares its own policy. `gateway-service.impl.md:485`, `:488`, `:507–508`.
  - The `/hooks/*` handler reads `arrayBuffer()`, passes the exact bytes and headers, parses no JSON and validates no schema; the body limit of a delivery is 50 MiB. `gateway-service.impl.md:206–210`.
  - The delivery policy mints no caller identity. `architecture.impl.md:646`.
  - The route set of the registry equals the committed OpenAPI. `architecture.impl.md:837`.
- Done when: `node --test --test-timeout=30000 src/kernel/operation.test.ts src/gateway/openapi.test.ts src/gateway/service.test.ts` passes; `pnpm run verify` passes.

### 06.2 Add the delivery classification

- Files: `src/repository/github.ts`, `src/repository/github.test.ts` (edit)
- Do:
  1. Removed: the hook methods `createHook`, `listHooksPage`, `getHook` and `deleteHook`. kanthord calls no platform for a webhook inbound (`intake-service.impl.md:40`).
  2. Add `classifyDelivery(headers)`: `X-GitHub-Event: ping` answers the handshake with status 204; another event with exactly one `X-GitHub-Delivery` answers `{ kind: "event", eventId, metadata: { event } }`; a missing or repeated `X-GitHub-Event` or `X-GitHub-Delivery` answers `invalid`.
  3. Add tests: the classification of a ping, a push, a missing delivery header and a repeated header.
- Rules:
  - After the verification, the platform implementation classifies the request; a GitHub request with `X-GitHub-Event: ping` is a handshake and answers 204. `intake-service.impl.md:57`.
  - The platform implementation fills the event identity and the metadata and declares its handshakes. `repository.md:43–49`.
- Done when: `node --test --test-timeout=30000 src/repository/github.test.ts` passes; `pnpm run verify` passes.

### 06.3 Add the event store

- Files: `src/intake/event-store.ts` (create), `src/intake/event-store.test.ts` (create), `src/intake/contract.ts` (edit)
- Do:
  1. Implement `findEvent(tx, inboundId, eventId)`, and `insertEvent(tx, input)` with `createIdentity("inbound_event")`, `state = "pending"`, `error = null` and the canonical JSON of `metadata`, answering the identity.
  2. Implement `pendingCount(tx)` over every inbound, `readEvent`, and `eventRecord(row)` for the projection of `engine/docs/cli/intake.md:267–269`, with `error` in its stored form and no `event` content.
  3. Add tests: `findEvent` finds a stored `(inbound, event identity)`; a second insert of one pair throws on the unique index; one event identity in two inbounds inserts twice; the projection holds no content.
- Rules:
  - `intake_inbound_event` has a unique index on `(inbound_id, event_id)`, so a redelivery inside one inbound creates no second row. `docs/reference/erd/03-integration.md:133`.
  - `state` starts as `pending`; `error` is null until the first failure. `docs/reference/erd/03-integration.md:136–137`.
  - A stored row keeps `event` and `metadata` unchanged. `docs/reference/erd/03-integration.md:135`.
- Done when: `node --test --test-timeout=30000 src/intake/event-store.test.ts` passes; `pnpm run verify` passes.

### 06.4 Declare the event reads and their CLI leaves

- Files: `src/intake/contract.ts`, `src/intake/event-read.ts` (create), `src/intake/event-read.test.ts` (create), `src/intake/service.ts`, `src/apps/cli/intake.ts`, `src/apps/cli/index.test.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.event.list` (`GET /api/intake/event`, `human`, query `{ inboundId?, state?, limit?, cursor? }`) and `inbound.event.get` (`GET /api/intake/event/:inboundEventId`, `human`, 404 `intake.inbound.event.not_found`).
  2. Add the CLI leaves `event list [--inbound <id>] [--state <state>] [L] [R]` and `event get <inbound-event-id> [R]` with the local code `cli.intake.event.get.invalid_inbound_event_id` (`engine/docs/cli/intake.md:474`).
  3. Add tests: the list pages newest first with both filters; an unknown identity answers 404; help of both leaves.
- Rules:
  - The event reads and their projection; a platform event identity is no substitute for the event identity. `engine/docs/cli/intake.md:94–99`, `:265–289`.
  - Gap: the content inclusion of `event get` waits for HANDOFF (`docs/brainstorm/HANDOFF.md:61`); the projection omits it.
- Done when: `node --test --test-timeout=30000 src/intake/event-read.test.ts src/apps/cli/index.test.ts` passes; `pnpm run verify` passes.

### 06.5 Declare and implement the receipt

- Files: `src/intake/contract.ts`, `src/intake/receipt.ts` (create), `src/intake/receipt.test.ts` (create), `src/intake/service.ts`, `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.event.receive`: `POST /hooks/:inboundId`, `access: Delivery`, `delivery: true`, `mutation: false`, `lifetime: Unary`, `status: 202`, output `z.null()`.
  2. Implement the handler in this order: validate `params.inboundId` with `identitySchema("inbound")`, read the inbound, and answer 404 `intake.inbound.not_found` for an absent row, an invalid identity or a poll; verify the signature; classify the request; for a handshake answer `new Response(null, { status: 204 })` with no write; an `invalid` classification answers 400 `gateway.request.validation_failed`. For an event, in `caller.commit`: answer 202 with no write when `findEvent` finds the pair; else answer 503 `intake.inbound.event.capacity_exceeded` when `pendingCount` reaches the bound; else `insertEvent` with the exact bytes. After the commit, call `wake()` and answer `new Response(null, { status: 202 })`.
  3. Verify in `src/intake/receipt.ts`: read every value of `X-Hub-Signature-256` and refuse unless exactly one value exists with no comma; refuse a value without the `sha256=` prefix, with a non-hexadecimal digest or with a digest of another length than 64; compute `createHmac("sha256", webhookSecret(masterKey, inboundId))` over the exact bytes; compare the two 32-byte digests with `timingSafeEqual`. Every refusal answers 401 `intake.inbound.event.signature_invalid` and stores nothing.
  4. Take the bound from `Dependencies.pendingEventLimit` with the default `PENDING_EVENT_LIMIT`; add the option `intake: { pendingEventLimit }` to `composeServices` and `gatewayFixture`.
  5. Add `deliver(fixture, input)` to `test-support.ts`: post the exact bytes to `/hooks/<inboundId>` with `X-GitHub-Event`, `X-GitHub-Delivery`, `Content-Type: application/json` and `X-Hub-Signature-256` = `"sha256=" + HMAC(secret, body)`; a string `signature` replaces the header value, and `null` omits the header; answer `{ status, body }`.
  6. Add tests on a service that runs no dispatcher: a missing, a duplicate (two header lines through the HTTP adapter), a malformed and a wrong-length signature answer 401 and store nothing; a valid signature over the exact bytes answers 202 and stores one row with `event_id` from `X-GitHub-Delivery`, the exact body and `{ "event": <X-GitHub-Event> }`; a body that differs by one byte answers 401; a repeated `X-GitHub-Delivery` answers 202 and keeps one row with unchanged content, also at the bound; a signed ping answers 204 at the bound and below it, with no row; an unsigned ping answers 401; a poll inbound and an unknown identity answer 404; a new event at the bound answers 503 and stores nothing; a commit failure answers no 2xx; no log record holds the secret.
- Rules:
  - The verification requires exactly one `X-Hub-Signature-256` header and rejects a missing or duplicate header, a value without the prefix, a non-hexadecimal value and a value of another length before any comparison; the HMAC uses SHA-256 over the exact bytes and `timingSafeEqual`; a failure answers 401 and stores nothing. `intake-service.impl.md:54–56`.
  - An unknown inbound identity answers 404, and a poll inbound answers 404. `intake-service.impl.md:53`.
  - Verification precedes storage, storage precedes the acknowledgement, and the Intake Service acknowledges only a stored event. `intake-service.md:93–99`; `architecture.impl.md:647`.
  - A handshake stores no event, skips the capacity bound and reaches no consumer. `intake-service.impl.md:58`.
  - A repeated `event_id` inserts nothing and answers 2xx; the handler answers 2xx after the commit; beyond the capacity bound it answers 503 and stores nothing. `intake-service.impl.md:60–61`. The repeat check precedes the bound, because a stored event takes no new place.
  - The receipt is the `delivery` operation `intake.inbound.event.receive` at `POST /hooks/:inboundId`. `intake-service.impl.md:52`; `engine/docs/cli/intake.md:381`.
  - Statuses and codes of the receipt. `engine/docs/cli/intake.md:391–398`.
  - Gap: the handshake span is ERD 4 work (decision D15); the receipt timeout and file bounds wait for HANDOFF (`docs/brainstorm/HANDOFF.md:60`); the bound value follows decision D12.
- Done when: `node --test --test-timeout=30000 src/intake/receipt.test.ts` passes; `pnpm run verify` passes.

### 06.6 Removed: the public origin of the `/hooks/` path group

kanthord calls no platform for a webhook inbound, so no public origin enters the configuration (`intake-service.impl.md:39–40`; decision D18).

### 06.7 Removed: a webhook create with a platform call

Every webhook inbound names no credential, and its create calls no platform; task 05.5 holds the whole create (`intake-service.impl.md:32`; `intake-service.md:63–65`).

### 06.8 Removed: a webhook delete with a platform call

A delete calls no platform for any kind; task 05.7 holds the whole delete (`intake-service.impl.md:34`; `intake-service.md:67–68`).

### 06.E E2E proof

- Files: `src/apps/server/e2e-webhook-acquisition.test.ts` (create)
- Do:
  1. Start `gatewayFixture` with `intake: { pendingEventLimit: 2 }`.
  2. Run E06.1 to E06.11, except the removed row E06.9, in one test in table order. Post every delivery with `deliver`.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read; the receipt has no CLI command, so the test posts it over HTTP. ERD 1 decision D13.
  - Until plan 09, no dispatcher reads the events, so the rows stay `pending`; plan 09 task 09.6 moves the rows that assume a pending event.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-webhook-acquisition.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-webhook-acquisition.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`, `kanthord(args, env)`, `deliver`. `H` names the human token.
- `hook.json` names `{ "projectId": <projectId>, "kind": "webhook", "platform": "github", "consumer": "mission.delivery.admit", "configuration": { "resource": "owner/repo" } }`. `PUSH` names the bytes `{"ref":"refs/heads/main","after":"<40 times a>","repository":{"full_name":"owner/repo"}}`.

Setup (each command exits 0, token H): `kanthord project create --name hooks` → `projectId`.

| Id     | Commands                                                                                                                                                                                        | Exit               | Expect                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E06.1  | `kanthord intake inbound create --file hook.json` → `W` = `id`; `kanthord intake inbound get <W>` → `S` = `secret`                                                                              | 0, 0               | `credential` null; `address` `/hooks/<W>`                                                                                                                                |
| E06.2  | `deliver(W, S, "push", "d-1", PUSH)`; `kanthord intake event list --inbound <W>`                                                                                                                | 202, 0             | one item, `eventId` `d-1`, `metadata` `{ "event": "push" }`, `state` `pending`, `error` null → `E1` = `id`                                                               |
| E06.3  | `deliver(W, S, "push", "d-1", PUSH)`; `kanthord intake event list --inbound <W>`                                                                                                                | 202, 0             | one item                                                                                                                                                                 |
| E06.4  | `deliver` of `PUSH` with `signature: "sha256=" + 64 zeros`; with `signature: null`; with the body `PUSH` plus one space and the signature of `PUSH`; `kanthord intake event list --inbound <W>` | 401 each, 0        | `body.error.code` `intake.inbound.event.signature_invalid` three times; one item                                                                                         |
| E06.5  | `deliver(W, S, "ping", "d-2", "{}")`; the same with `signature: null`                                                                                                                           | 204, 401           | the list keeps one item                                                                                                                                                  |
| E06.6  | `deliver("inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV", S, "push", "d-3", PUSH)`                                                                                                                         | 404                | `intake.inbound.not_found`                                                                                                                                               |
| E06.7  | `deliver(W, S, "push", "d-4", PUSH)`; `deliver(W, S, "push", "d-5", PUSH)`; `deliver(W, S, "push", "d-1", PUSH)`; `deliver(W, S, "ping", "d-6", "{}")`                                          | 202, 503, 202, 204 | `intake.inbound.event.capacity_exceeded` for the third pending event; the redelivery of `d-1` answers 202 at the bound and stores nothing; the handshake skips the bound |
| E06.8  | `kanthord intake event get <E1>`; `kanthord intake inbound delete <W>`                                                                                                                          | 0, 1               | `state` `pending`; stderr starts with `intake.inbound.events_pending:`                                                                                                   |
| E06.9  | Removed: a platform refusal at a webhook create. A webhook create calls no platform.                                                                                                            | —                  | —                                                                                                                                                                        |
| E06.10 | `kanthord intake inbound create --file hook.json` → `W2` = `id`                                                                                                                                 | 0                  | `credential` null; `W2` differs from `W`                                                                                                                                 |
| E06.11 | `kanthord intake inbound delete <W2>`; `kanthord intake inbound get <W2>`                                                                                                                       | 0, 1               | `idempotencyKey` a ULID; stderr starts with `intake.inbound.not_found:`                                                                                                  |

E06.4 to E06.7 assert the receipt codes of `engine/docs/cli/intake.md:395–398`.
