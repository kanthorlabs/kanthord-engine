# Plan 06: Intake Service — webhook

## Scope

This plan delivers:

- The `delivery` route outside `/api/`: the registry rule of the `/hooks/` prefix, its HTTP route and its OpenAPI entry (decision D13).
- The receipt `intake.inbound.event.receive` at `POST /hooks/:inboundId`: the inbound lookup, the signature verification over the exact bytes, the verified handshake, the capacity bound, the deduplicated insert and the acknowledgement after the commit.
- The GitHub hook methods and the delivery classification of the Repository component.
- The ingress origin `intake.ingressUrl` (decision D18, blocker B3).
- The registered webhook create with the registration, the adoption of an indeterminate registration and the deregistration after a refused insert, and the registered webhook delete with the deregistration.
- The event reads `intake.inbound.event.list` and `intake.inbound.event.get` with their CLI leaves `event list` and `event get`. They move here from plan 09, because the receipt is the first writer of `intake_inbound_event` and its E2E needs a CLI read of the stored event (ERD 1 decision D13).
- The fixture extensions `fakeGitHub` hooks and `deliver`.

Out of scope:

- The handoff and the human event writes `retry`, `discard` and `delete` (plan 09). An event of this plan stays `pending` until plan 09.
- A `GET` receipt route and a Slack challenge (`docs/brainstorm/HANDOFF.md:47`; `intake-service.impl.md:58`).
- The content of an event in `event get` (`docs/brainstorm/HANDOFF.md:49`).
- The webhook resource healthcheck (plan 10).

## Sources

- `docs/reference/erd/03-integration.md:63–72`, `:115`, `:128–129`, `:132–140` — the event columns; the derived secret; the registration before the insert; the event constraints.
- `docs/brainstorm/intake-service.md:59–65`, `:71–72`, `:77` — the registered create, the adoption, the crash window; the delete; the registration identity.
- `docs/brainstorm/intake-service.md:96–111` — inbound events: verification, storage, acknowledgement, handshake, deduplication.
- `docs/brainstorm/intake-service.md:186–188` — the capacity bound: a webhook receives a retryable refusal; no acknowledged event is dropped.
- `docs/brainstorm/intake-service.vocabulary.md:29–43` — inbound event, handshake, platform event identity.
- `docs/brainstorm/intake-service.impl.md:19–24`, `:33–35` — the inbound release; the insert refusal after a registration; the delete order.
- `docs/brainstorm/intake-service.impl.md:37–62` — the webhook acquisition, the secret, the receipt.
- `docs/brainstorm/intake-service.impl.md:94–114` — the error codes.
- `docs/brainstorm/intake-service.impl.md:216–229` — the tests of the create, the delete and the receipt.
- `docs/brainstorm/gateway-service.impl.md:41`, `:204–210` — the `delivery` policy; the exact bytes and the 50 MiB limit.
- `docs/brainstorm/gateway-service.impl.md:481–500`, `:506–511` — the ingress and the entry paths.
- `docs/brainstorm/architecture.impl.md:644–646` — the delivery policy mints no identity; the acknowledgement follows the commit.
- `docs/brainstorm/repository.md:43–49` — the platform implementation fills the event identity and the metadata, and declares its handshakes.
- `docs/brainstorm/repository.impl.md:15` — the GitHub implementation.
- `engine/docs/cli/intake.md:56–57`, `:94–99`, `:154–155`, `:173–184`, `:273–297` — the event reads.
- `engine/docs/cli/intake.md:209–230`, `:256–271` — the create and the delete statuses.
- `engine/docs/cli/intake.md:387–406` — the receipt route.
- `engine/src/kernel/operation.ts:122–140` — the path rule and the delivery rules of the registry.
- `engine/src/gateway/service.ts:376–470`, `engine/src/gateway/invocation.ts:288–290` — the exact-byte adapter.
- Decisions D12, D13, D14, D15, D17, D18 of `decisions.md`.

### Contract keys

| Key                                                                     | Where                         | Owner line                                |
| ----------------------------------------------------------------------- | ----------------------------- | ----------------------------------------- |
| `inboundId`                                                             | path of the receipt           | `engine/docs/cli/intake.md:389`           |
| `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`            | headers of a GitHub delivery  | `intake-service.impl.md:55`, `:58`, `:61` |
| `event`                                                                 | `metadata` of a webhook event | `intake-service.impl.md:61`               |
| `id`, `inboundId`, `eventId`, `metadata`, `state`, `error`, `createdAt` | the event read projection     | `engine/docs/cli/intake.md:275–277`       |
| `inboundEventId`                                                        | path of `event get`           | `engine/docs/cli/intake.md:150`           |
| `inboundId`, `state`, `limit`, `cursor`                                 | query of `event list`         | `engine/docs/cli/intake.md:154–155`       |
| `intake.ingressUrl`                                                     | server configuration          | decision D18; blocker B3                  |

## Depends on

- Plan 01: `intake_inbound_event`, the closed sets, `PENDING_EVENT_LIMIT`.
- Plan 03: `GitHubPlatform` and `fakeGitHub`.
- Plan 05: the inbound store, `commitInbound`, `webhookSecret`, the inbound grant, the create and delete operations with their per-kind steps.
- No stand-in. `IntakeService.wake()` is a method of this plan that does nothing until plan 09 adds the dispatcher.

## Provides

| Seam                     | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                                                                                | Owner file                                                                    | Consumer plans |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------- |
| Delivery route           | an operation with `access: Delivery` and a path under `/hooks/`                                                                                                                                                                                                                                                                                                                                                                                     | `src/kernel/operation.ts`, `src/gateway/service.ts`, `src/gateway/openapi.ts` | 06             |
| `GitHubPlatform` (hooks) | `createHook(call, target, { url; secret; events })`; `listHooksPage(call, target, { page })`: `{ hooks: { id; url }[]; nextPage: number \| null }`; `getHook(call, target, { id })`; `deleteHook(call, target, { id })`; `classifyDelivery(headers): { kind: "handshake"; status: 204 } \| { kind: "event"; eventId; metadata: { event } } \| { kind: "invalid" }`, where `target` is the inbound target `{ kind: "inbound"; resource }` of plan 03 | `src/repository/github.ts`                                                    | 06, 10         |
| Event store (part)       | `findEvent(tx, inboundId, eventId)`; `insertEvent(tx, { inboundId; eventId; event: Uint8Array; metadata }): string`; `pendingCount(tx): number`; `readEvent(tx, id)`; `eventRecord(row)`                                                                                                                                                                                                                                                            | `src/intake/event-store.ts`                                                   | 07, 09         |
| `IntakeService.wake`     | `(): void` — no-op until plan 09                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/intake/service.ts`                                                       | 07, 09         |
| Receipt                  | `intake.inbound.event.receive` (gated by B5)                                                                                                                                                                                                                                                                                                                                                                                                        | `src/intake/contract.ts`                                                      | 09, 10         |
| Event reads              | `intake.inbound.event.list`, `intake.inbound.event.get`; CLI `event list`, `event get`                                                                                                                                                                                                                                                                                                                                                              | `src/intake/contract.ts`, `src/apps/cli/intake.ts`                            | 09, 10         |
| Fixtures                 | `fakeGitHub` hook routes; `deliver(fixture, { inboundId; secret; event; deliveryId; body; signature?: string \| null })` answering `{ status; body }`; the `gatewayFixture` option `intake: { pendingEventLimit }`                                                                                                                                                                                                                                  | `src/apps/server/test-support.ts`                                             | 07, 09, 10     |
| `intake.ingressUrl`      | configuration field and `IntakeConfig.ingressUrl`, normalized to its origin                                                                                                                                                                                                                                                                                                                                                                         | `src/intake/index.ts`, `src/config/index.ts`                                  | 06             |

## Tasks

### 06.1 Admit a delivery route under `/hooks/`

- Files: `src/kernel/operation.ts`, `src/kernel/operation.test.ts`, `src/gateway/service.ts`, `src/gateway/openapi.ts`, `src/gateway/openapi.test.ts`, `src/gateway/service.test.ts` (all edit)
- Do:
  1. In `register`, admit a path that starts with `/hooks/` for an operation with `access: Delivery` alone; keep `/api/` for every other operation; replace the message "Delivery verification and deduplication belong to the Scheduler Service." with "A delivery operation is no mutation."
  2. In `registerRoutes`, register the delivery route like any route; it reads the exact bytes already (`src/gateway/service.ts:420–425`).
  3. In `src/gateway/openapi.ts`, emit the path with `x-access-policy: delivery`, an `application/octet-stream` request body, no security requirement, and the empty responses that the operation declares (`202` and `204`).
  4. Add tests: a delivery at `/hooks/:id` registers; a `human` operation under `/hooks/` throws; the handler receives the exact bytes of a body that is not canonical JSON; a body above 50 MiB answers 413; the emitted path holds no security and both empty responses.
- Rules:
  - The delivery ingress uses the path group `/hooks/*`; a webhook delivery enters through a registered route; each operation declares its own policy. `gateway-service.impl.md:484`, `:487`, `:506–507`.
  - The `/hooks/*` handler reads `arrayBuffer()`, passes the exact bytes and headers, parses no JSON and validates no schema; the body limit of a delivery is 50 MiB. `gateway-service.impl.md:206–210`.
  - The delivery policy mints no caller identity. `architecture.impl.md:645`.
  - The route set of the registry equals the committed OpenAPI. `architecture.impl.md:833`.
- Done when: `node --test --test-timeout=30000 src/kernel/operation.test.ts src/gateway/openapi.test.ts src/gateway/service.test.ts` passes; `pnpm run verify` passes.

### 06.2 Add the GitHub hook methods and the delivery classification

- Files: `src/repository/github.ts`, `src/repository/github.test.ts` (edit)
- Do:
  1. Add `createHook` (`POST /repos/{owner}/{repo}/hooks` with `name: "web"`, `active: true`, `events`, `config: { url, content_type: "json", secret, insecure_ssl: "0" }`), `listHooksPage` (`GET /repos/{owner}/{repo}/hooks` of one page, answering `{ id, url }` and the next page number of the `Link` header), `getHook` (`GET /repos/{owner}/{repo}/hooks/{hook_id}`, answering `active` and `last_response.code`) and `deleteHook` (`DELETE /repos/{owner}/{repo}/hooks/{hook_id}`, where a 404 answers `{ ok: true, value: { found: false } }`). The inbound target supplies the owner and the repository.
  2. Add `classifyDelivery(headers)`: `X-GitHub-Event: ping` answers the handshake with status 204; another event with exactly one `X-GitHub-Delivery` answers `{ kind: "event", eventId, metadata: { event } }`; a missing or repeated `X-GitHub-Event` or `X-GitHub-Delivery` answers `invalid`.
  3. Add tests: each method against a local server; a lost create answer maps to `unknown_outcome`; a two-page list; the classification of a ping, a push, a missing delivery header and a repeated header.
- Rules:
  - The registration, the read and the deregistration of a GitHub webhook use the GitHub implementation; each call carries a deadline. `intake-service.impl.md:39`.
  - The registration names the address, the verification secret and the events (B8). `intake-service.impl.md:40`.
  - A GitHub request with `X-GitHub-Event: ping` is a handshake and answers 204. `intake-service.impl.md:58`.
  - The platform implementation fills the event identity and the metadata, declares its handshakes, and derives the resource from the inbound. `repository.md:43–49`.
  - The result classes of decision D11.
- Done when: `node --test --test-timeout=30000 src/repository/github.test.ts` passes; `pnpm run verify` passes.

### 06.3 Add the event store

- Files: `src/intake/event-store.ts` (create), `src/intake/event-store.test.ts` (create), `src/intake/contract.ts` (edit)
- Do:
  1. Implement `findEvent(tx, inboundId, eventId)`, and `insertEvent(tx, input)` with `createIdentity("inbound_event")`, `state = "pending"`, `error = null` and the canonical JSON of `metadata`, answering the identity.
  2. Implement `pendingCount(tx)` over every inbound, `readEvent`, and `eventRecord(row)` for the projection of `engine/docs/cli/intake.md:275–277`, with `error` in its stored form and no `event` content.
  3. Add tests: `findEvent` finds a stored `(inbound, event identity)`; a second insert of one pair throws on the unique index; one event identity in two inbounds inserts twice; the projection holds no content.
- Rules:
  - `intake_inbound_event` has a unique index on `(inbound_id, event_id)`, so a redelivery inside one inbound creates no second row. `docs/reference/erd/03-integration.md:134`.
  - `state` starts as `pending`; `error` is null until the first failure. `docs/reference/erd/03-integration.md:137–138`.
  - A stored row keeps `event` and `metadata` unchanged. `docs/reference/erd/03-integration.md:136`.
- Done when: `node --test --test-timeout=30000 src/intake/event-store.test.ts` passes; `pnpm run verify` passes.

### 06.4 Declare the event reads and their CLI leaves

- Files: `src/intake/contract.ts`, `src/intake/event-read.ts` (create), `src/intake/event-read.test.ts` (create), `src/intake/service.ts`, `src/apps/cli/intake.ts`, `src/apps/cli/index.test.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.event.list` (`GET /api/intake/event`, `human`, query `{ inboundId?, state?, limit?, cursor? }`) and `inbound.event.get` (`GET /api/intake/event/:inboundEventId`, `human`, 404 `intake.inbound.event.not_found`).
  2. Add the CLI leaves `event list [--inbound <id>] [--state <state>] [L] [R]` and `event get <inbound-event-id> [R]` with the local code `cli.intake.event.get.invalid_inbound_event_id` (`code: proposed`).
  3. Add tests: the list pages newest first with both filters; an unknown identity answers 404; help of both leaves.
- Rules:
  - The event reads and their projection; a platform event identity is no substitute for the event identity. `engine/docs/cli/intake.md:94–99`, `:273–297`.
  - Gap: the content inclusion of `event get` waits for HANDOFF (`docs/brainstorm/HANDOFF.md:49`); the projection omits it.
- Done when: `node --test --test-timeout=30000 src/intake/event-read.test.ts src/apps/cli/index.test.ts` passes; `pnpm run verify` passes.

### 06.5 Declare and implement the receipt

- Files: `src/intake/contract.ts`, `src/intake/receipt.ts` (create), `src/intake/receipt.test.ts` (create), `src/intake/service.ts`, `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.event.receive` (identity gated by B5): `POST /hooks/:inboundId`, `access: Delivery`, `delivery: true`, `mutation: false`, `lifetime: Unary`, `status: 202`, output `z.null()`.
  2. Implement the handler in this order: validate `params.inboundId` with `identitySchema("inbound")`, read the inbound, and answer 404 `intake.inbound.not_found` for an absent row, an invalid identity or a poll; verify the signature; classify the request; for a handshake answer `new Response(null, { status: 204 })` with no write; an `invalid` classification answers 400 `gateway.request.validation_failed`. For an event, in `caller.commit`: answer 202 with no write when `findEvent` finds the pair; else answer 503 `intake.inbound.event.capacity_exceeded` when `pendingCount` reaches the bound; else `insertEvent` with the exact bytes. After the commit, call `wake()` and answer `new Response(null, { status: 202 })`.
  3. Verify in `src/intake/receipt.ts`: read every value of `X-Hub-Signature-256` and refuse unless exactly one value exists with no comma; refuse a value without the `sha256=` prefix, with a non-hexadecimal digest or with a digest of another length than 64; compute `createHmac("sha256", webhookSecret(masterKey, inboundId))` over the exact bytes; compare the two 32-byte digests with `timingSafeEqual`. Every refusal answers 401 `intake.inbound.event.signature_invalid` and stores nothing.
  4. Take the bound from `Dependencies.pendingEventLimit` with the default `PENDING_EVENT_LIMIT`; add the option `intake: { pendingEventLimit }` to `composeServices` and `gatewayFixture`.
  5. Add `deliver(fixture, input)` to `test-support.ts`: post the exact bytes to `/hooks/<inboundId>` with `X-GitHub-Event`, `X-GitHub-Delivery`, `Content-Type: application/json` and `X-Hub-Signature-256` = `"sha256=" + HMAC(secret, body)`; a string `signature` replaces the header value, and `null` omits the header; answer `{ status, body }`.
  6. Add tests on a service that runs no dispatcher: a missing, a duplicate (two header lines through the HTTP adapter), a malformed and a wrong-length signature answer 401 and store nothing; a valid signature over the exact bytes answers 202 and stores one row with `event_id` from `X-GitHub-Delivery`, the exact body and `{ "event": <X-GitHub-Event> }`; a body that differs by one byte answers 401; a repeated `X-GitHub-Delivery` answers 202 and keeps one row with unchanged content, also at the bound; a signed ping answers 204 at the bound and below it, with no row; an unsigned ping answers 401; a poll inbound and an unknown identity answer 404; a new event at the bound answers 503 and stores nothing; a commit failure answers no 2xx; no log record holds the secret.
- Rules:
  - The verification requires exactly one `X-Hub-Signature-256` header and rejects a missing or duplicate header, a value without the prefix, a non-hexadecimal value and a value of another length before any comparison; the HMAC uses SHA-256 over the exact bytes and `timingSafeEqual`; a failure answers 401 and stores nothing. `intake-service.impl.md:55–57`.
  - An unknown inbound identity answers 404, and a poll inbound answers 404. `intake-service.impl.md:54`.
  - Verification precedes storage, storage precedes the acknowledgement, and the Intake Service acknowledges only a stored event. `intake-service.md:102–108`; `architecture.impl.md:646`.
  - A handshake stores no event, skips the capacity bound and reaches no consumer. `intake-service.impl.md:59`.
  - A repeated `event_id` inserts nothing and answers 2xx; the handler answers 2xx after the commit; beyond the capacity bound it answers 503 and stores nothing. `intake-service.impl.md:61–62`. The repeat check precedes the bound, because a stored event takes no new place.
  - Statuses and codes of the receipt. `engine/docs/cli/intake.md:398–405`.
  - Gap: the handshake span is ERD 4 work (decision D15); the receipt timeout and file bounds wait for HANDOFF (`docs/brainstorm/HANDOFF.md:48`); the bound value follows decision D12. The operation identity waits for B5.
- Done when: `node --test --test-timeout=30000 src/intake/receipt.test.ts` passes; `pnpm run verify` passes.

### 06.6 Add the ingress origin

- Files: `src/intake/index.ts`, `src/intake/config.ts` (create), `src/config/index.ts`, `src/config/index.test.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. Declare the `convict` fragment `intake.ingressUrl`: a string, default `""`, whose format accepts the empty string or an absolute `http` or `https` URL with no path other than `/`, no query, no fragment and no credentials. Pass `new URL(value).origin`, or the empty string, to `IntakeService`.
  2. Add tests: `config init` writes the default; a path, a query and a URL with credentials refuse; `https://hooks.example.test` and `https://hooks.example.test/` both answer the origin `https://hooks.example.test`.
- Rules:
  - The implementation sibling of a service names the fields of its section, and the composition root passes the parsed section. `architecture.impl.md:279–289`.
  - A delivery needs no confidentiality of the ingress, so both schemes stand; the origin never derives from a forwarded header. `gateway-service.impl.md:491`, `:499`.
  - Gap: no page names the field (blocker B3). The task waits for the ruling of B3; decision D18 is the recommendation.
- Done when: `node --test --test-timeout=30000 src/config/index.test.ts` passes; `pnpm run verify` passes.

### 06.7 Add the registered webhook create

- Files: `src/intake/inbound-create.ts`, `src/intake/inbound-create.test.ts`, `src/intake/contract.ts`, `src/apps/server/test-support.ts` (edit)
- Do:
  1. Extend `fakeGitHub` with the hook routes: hooks in memory with their `config` and `events`, pages of 30 hooks, and `lastResponse(id, code)`.
  2. Admit a webhook with a `credential`. Allocate the inbound identity `id` first; answer 422 `intake.inbound.ingress_unset` (`code: proposed`) when the origin is empty; the address is `<origin>/hooks/<id>`.
  3. In one `store.transaction`, authorize the `inbound` grant with the operation `webhook-register` and the facts of the validated input and of `id`, and release it; map a credential refusal with `credentialRefusal`. Call `createHook` with the address, `webhookSecret(masterKey, id)` and the event list of B8.
  4. On an `unknown_outcome`, read the hook pages until the one whose `url` equals the address; each page takes its own `webhook-read` grant and drops its material; the reads stay inside `PLATFORM_CALL_DEADLINE_MS`. Adopt a match; with no match, answer 422 `intake.inbound.platform_refused` and insert nothing. Every other result class answers 422 `intake.inbound.platform_refused`, and a 401 or 403 reaches `reportRefusal`.
  5. Insert through `commitInbound(tx, id, …)` with `registration_id` = the hook identity as text. When the insert refuses, deregister the hook, then answer the refusal; the material of that deregistration waits for B9.
  6. Drop every material in `finally`.
  7. Add tests: a create registers one hook whose URL ends with `/hooks/<id>` of the inserted row; a lost registration answer followed by a read that finds the hook on the second page inserts one row and leaves one hook; a refused registration inserts no row; an unknown credential and a credential of another platform answer 422 `intake.inbound.credential_invalid` with no platform call; a credential removal between the registration and the insert refuses the insert and leaves no row; an empty origin refuses before any platform call; a repeat with the same idempotency key answers the same inbound and registers nothing.
- Rules:
  - The create of a registered webhook registers the address at the platform, then inserts the row with the registration identity. `intake-service.md:61`; `docs/reference/erd/03-integration.md:129`.
  - An uncertain registration result makes the create read the registrations; the create adopts the registration that names the same address, or it inserts nothing. `intake-service.md:62–64`; `intake-service.impl.md:41`.
  - When the insert refuses after a registration, the create deregisters, then answers the refusal. `intake-service.impl.md:33`. The material of that call is blocker B9.
  - Each remote call of an inbound takes one single-use grant; at a create the facts come from the validated input. `intake-service.impl.md:19`, `:22`.
  - A create answers its platform refusal and changes no row. `intake-service.impl.md:35`. Statuses: `engine/docs/cli/intake.md:226–230`.
  - The verification secret derives from the inbound identity, so the registered address, the secret and the row share one identity. `intake-service.impl.md:46`.
  - Gap: the failure span is ERD 4 work (decision D15). The event list is blocker B8, the ingress origin blocker B3, the compensation blocker B9, and the drain of each release before its call blocker B1; the task waits for the four rulings.
  - After the ruling of B9, the compensation test asserts the ruled registration outcome beside the absent row (`intake-service.impl.md:219`).
- Done when: `node --test --test-timeout=30000 src/intake/inbound-create.test.ts` passes; `pnpm run verify` passes.

### 06.8 Add the registered webhook delete

- Files: `src/intake/inbound-delete.ts`, `src/intake/inbound-delete.test.ts` (edit)
- Do:
  1. In the removal step of a webhook with a `registration_id`, authorize and release a `webhook-deregister` grant and call `deleteHook`. A `found: false` answer counts as done; a result class answers 422 `intake.inbound.platform_refused` and keeps the row; a 401 or 403 reaches `reportRefusal`.
  2. Keep the first pending check before the call and the second inside the delete transaction (task 05.7).
  3. Add tests: a delete deregisters and removes the row; a not-found deregistration removes the row; a refused deregistration keeps the row; a pending event that arrives during the deregistration refuses the transaction and keeps the row without its registration, then the test sets that event to `discarded` through the event store, and a second delete meets a not-found deregistration and removes the row and its events; a delete with a pending event answers 409 and leaves the hook at the platform.
- Rules:
  - A delete of a registered webhook first refuses with 409 `intake.inbound.events_pending`, then deregisters with a not-found answer counting as done, then checks again and deletes in one transaction. `intake-service.impl.md:34`.
  - A refused deregistration keeps the row. `intake-service.md:72`.
  - The drain of the release before the call waits for B1 (decision D3).
- Done when: `node --test --test-timeout=30000 src/intake/inbound-delete.test.ts` passes; `pnpm run verify` passes.

### 06.E E2E proof

- Files: `src/apps/server/e2e-webhook-acquisition.test.ts` (create)
- Do:
  1. Start `fakeGitHub(t)` and `gatewayFixture` with `github: { baseUrl }`, the configuration `intake.ingressUrl` = `"https://hooks.example.test"` and `intake: { pendingEventLimit: 2 }`.
  2. Run E06.1 to E06.11 in one test in table order. Post every delivery with `deliver`.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read; the receipt has no CLI command, so the test posts it over HTTP. ERD 1 decision D13.
  - Until plan 09, no dispatcher reads the events, so the rows stay `pending`; plan 09 task 09.6 moves the rows that assume a pending event.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-webhook-acquisition.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-webhook-acquisition.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`, `fakeGitHub`, `kanthord(args, env)`, `deliver`. `H` names the human token.
- `hook.json` names `{ "projectId": <projectId>, "kind": "webhook", "platform": "github", "consumer": "mission.delivery.admit", "credential": "github", "configuration": { "resource": "owner/repo" } }`. `PUSH` names the bytes `{"ref":"refs/heads/main","after":"<40 times a>","repository":{"full_name":"owner/repo"}}`.

Setup (each command exits 0, token H): `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`; `kanthord project create --name hooks` → `projectId`.

| Id     | Commands                                                                                                                                                                                        | Exit               | Expect                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E06.1  | `kanthord intake inbound create --file hook.json` → `W` = `id`; `kanthord intake inbound get <W>` → `S` = `secret`                                                                              | 0, 0               | `registrationId` a nonempty string; `gitHub.hooks` holds one hook with `config.url` `https://hooks.example.test/hooks/<W>`, `events` `["pull_request","push"]` and `config.secret` = `S` |
| E06.2  | `deliver(W, S, "push", "d-1", PUSH)`; `kanthord intake event list --inbound <W>`                                                                                                                | 202, 0             | one item, `eventId` `d-1`, `metadata` `{ "event": "push" }`, `state` `pending`, `error` null → `E1` = `id`                                                                               |
| E06.3  | `deliver(W, S, "push", "d-1", PUSH)`; `kanthord intake event list --inbound <W>`                                                                                                                | 202, 0             | one item                                                                                                                                                                                 |
| E06.4  | `deliver` of `PUSH` with `signature: "sha256=" + 64 zeros`; with `signature: null`; with the body `PUSH` plus one space and the signature of `PUSH`; `kanthord intake event list --inbound <W>` | 401 each, 0        | `body.error.code` `intake.inbound.event.signature_invalid` three times; one item                                                                                                         |
| E06.5  | `deliver(W, S, "ping", "d-2", "{}")`; the same with `signature: null`                                                                                                                           | 204, 401           | the list keeps one item                                                                                                                                                                  |
| E06.6  | `deliver("inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV", S, "push", "d-3", PUSH)`                                                                                                                         | 404                | `intake.inbound.not_found`                                                                                                                                                               |
| E06.7  | `deliver(W, S, "push", "d-4", PUSH)`; `deliver(W, S, "push", "d-5", PUSH)`; `deliver(W, S, "push", "d-1", PUSH)`; `deliver(W, S, "ping", "d-6", "{}")`                                          | 202, 503, 202, 204 | `intake.inbound.event.capacity_exceeded` for the third pending event; the redelivery of `d-1` answers 202 at the bound and stores nothing; the handshake skips the bound                 |
| E06.8  | `kanthord intake event get <E1>`; `kanthord intake inbound delete <W>`                                                                                                                          | 0, 1               | `state` `pending`; stderr starts with `intake.inbound.events_pending:`; `gitHub.hooks` still holds the hook                                                                              |
| E06.9  | `gitHub.respondNext(422, { message: "Validation Failed" })`; `kanthord intake inbound create --file hook.json`; `kanthord intake inbound list --project <projectId>`                            | —, 1, 0            | stderr starts with `intake.inbound.platform_refused:`; the list holds `W` alone                                                                                                          |
| E06.10 | `gitHub.dropNextAfterApply()`; `kanthord intake inbound create --file hook.json` → `W2` = `id`                                                                                                  | 0                  | `registrationId` names the second hook; `gitHub.hooks` holds two hooks, and the second URL ends with `/hooks/<W2>`                                                                       |
| E06.11 | `kanthord intake inbound delete <W2>`; `kanthord intake inbound get <W2>`                                                                                                                       | 0, 1               | `gitHub.hooks` holds one hook; `intake.inbound.not_found:`                                                                                                                               |

E06.4 to E06.7 assert the receipt codes of `engine/docs/cli/intake.md:402–405`. E06.1, E06.9 and E06.10 wait for the rulings of B3, B8 and B9; E06.2 to E06.7 wait for the operation identity of B5.

## Blockers

- B3 of `00-index.md`: no page names the ingress origin of a registered webhook. Tasks 06.6 and 06.7 wait for its ruling; decision D18 is the recommendation, and the refusal `intake.inbound.ingress_unset` is `code: proposed`.
- B8 of `00-index.md`: the configuration names no event list. Task 06.7 waits for its ruling; the recommendation is `pull_request` and `push`.
- B9 of `00-index.md`: the compensation deregistration of task 06.7 reuses the material of the registration against the per-call release. Step 5 of task 06.7 waits for its ruling.
- B5 of `00-index.md`: no page names the operation identity of the receipt. Task 06.5 waits for its ruling; the recommendation is `intake.inbound.event.receive`.
- Structure: the event reads move here from plan 09, because the receipt is their first writer and the E2E of this plan needs a CLI read of a stored event (ERD 1 decision D13).
