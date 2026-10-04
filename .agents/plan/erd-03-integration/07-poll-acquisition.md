# Plan 07: Intake Service — poll

## Scope

This plan delivers:

- The GitHub events read of the Repository component with its ETag and its `checkpoint` schema.
- The poll create: one request with the credential before the insert.
- The permanent poll loop: one loop per poll inbound, a fixed interval, one request at a time, a release per request, the batch and its `checkpoint` in one transaction, the discard of a batch whose inbound is gone, the capacity pause, and the lifecycle of the loops.
- The fixture extension of `fakeGitHub` for the events route.

Out of scope:

- A poll that ends at an event of its resource: every poll is permanent (root `AGENTS.md` "Rejected proposals").
- An enable or a disable of an inbound and a poll-now command (`engine/docs/cli/intake.md:132–133`).
- The handoff of the stored events (plan 09) and the poll resource healthcheck (plan 10).

## Sources

- `docs/reference/erd/03-integration.md:58`, `:124`, `:127–130`, `:139` — `checkpoint`; the poll names a credential; the create request; the batch with the checkpoint; the capacity bound.
- `docs/brainstorm/intake-service.md:24–28` — the Intake Service owns the connection lifetime and the meaning of a poll checkpoint.
- `docs/brainstorm/intake-service.md:62`, `:67`, `:72–75` — the poll create; the delete calls no platform; the permanent poll and its checkpoint.
- `docs/brainstorm/intake-service.md:177–179`, `:186` — the poll pauses beyond the bound; no promise of every update.
- `docs/brainstorm/intake-service.vocabulary.md:43–46` — the checkpoint holds the newest event identity and the ETag.
- `docs/brainstorm/intake-service.impl.md:19–24`, `:30` — the release per call; the platform implementation validates `checkpoint`.
- `docs/brainstorm/intake-service.impl.md:63–71` — the poll acquisition.
- `docs/brainstorm/intake-service.impl.md:219–220`, `:223`, `:229–230` — the tests of the poll.
- `docs/brainstorm/custody.impl.md:131`, `:140` — the pin and drain commit before a remote call; the refusal in the span of the holder.
- `docs/brainstorm/architecture.impl.md:458–479` — timers stop in phase 1; resources release in phase 4.
- `docs/brainstorm/repository.md:43`, `:47–48` — the platform implementation fills the event identity and the metadata at its poll.
- `engine/docs/cli/intake.md:193–198`, `:216–226`, `:401–402` — the poll create and the pause.
- Decisions D11, D12, D15, D17, D24 of `decisions.md`.

### Contract keys

| Key                       | Where                                                 | Owner line                                                                                 |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `etag`, `newest_event_id` | `checkpoint` of a GitHub poll                         | `intake-service.vocabulary.md:46`; `docs/reference/erd/03-integration.md:126` (snake_case) |
| `event`                   | `metadata` of a polled event: the GitHub event `type` | `intake-service.impl.md:68`                                                                |
| `id`                      | the GitHub event identity that fills `event_id`       | `intake-service.impl.md:68`                                                                |
| `pollIntervalMs`          | the fixture option of `gatewayFixture`                | decision D17                                                                               |

## Depends on

- Plan 03: `GitHubPlatform`, `fakeGitHub`.
- Plan 05: the inbound store, `commitInbound`, `credentialRefusal`, the inbound grant with the operation `poll`, the create with its per-kind step, the delete, `inboundRemoved`.
- Plan 06: `insertEvent`, `pendingCount`, `wake()`, the event reads.
- No stand-in.

## Provides

| Seam                        | TypeScript signature                                                                                                                                                                                    | Owner file                        | Consumer plans            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------- |
| `GitHubPlatform.listEvents` | `(call, { owner; repo; etag: string \| null }): Promise<GitHubAnswer<{ notModified: true } \| { notModified: false; etag: string \| null; events: { id: string; type: string; body: Uint8Array }[] }>>` | `src/repository/github.ts`        | 07, 10                    |
| `githubCheckpointSchema`    | `z.strictObject({ etag: z.string().nullable(), newest_event_id: z.string().regex(/^[0-9]+$/).nullable() })`                                                                                             | `src/repository/github.ts`        | 07, 10                    |
| Poll loops                  | `PollLoops { start(inboundId): void; stop(inboundId): void; stopAll(): Promise<void> }`                                                                                                                 | `src/intake/poll.ts`              | 05 (`inboundRemoved`), 10 |
| Fixture                     | `fakeGitHub.events(owner, repo, list)`, `fakeGitHub.failEvents(status)`, the ETag and the 304 answer; `gatewayFixture` option `intake: { pollIntervalMs }`                                              | `src/apps/server/test-support.ts` | 09, 10                    |

## Tasks

### 07.1 Add the GitHub events read

- Files: `src/repository/github.ts`, `src/repository/github.test.ts` (edit)
- Do:
  1. Add `listEvents`: `GET /repos/{owner}/{repo}/events?per_page=100` with `If-None-Match` set to `etag` when it is given. A 304 answers `{ notModified: true }`. A 200 answers the `ETag` header and each event as `{ id, type, body }`, where `body` holds the UTF-8 bytes of the canonical JSON of the event object.
  2. Declare `githubCheckpointSchema` and `newerEvents(events, newest)`, which keeps the events whose numeric `id` is greater than `newest` in ascending order, comparing two decimal strings by length, then lexically.
  3. Add tests: the ETag round trip; the 304 answer; `newerEvents` with a null checkpoint, with an equal identity and with identities of different length; a 500 answers `retryable_refusal` after one request, with no retry; a closed connection retries inside the deadline.
- Rules:
  - The GitHub poll reads the events of the resource with `If-None-Match` set to the ETag of `checkpoint`; a 304 answer stores nothing. `intake-service.impl.md:67`.
  - Each event inserts `event_id` from the event `id`, the event JSON in `event` and `{ "event": <type> }` in `metadata`. `intake-service.impl.md:68`.
  - The checkpoint keeps the newest event identity and the ETag of the last answer. `intake-service.vocabulary.md:46`; the platform implementation validates it. `intake-service.impl.md:30`.
  - A read retries a transport error within the deadline. `repository.md:82`; decision D11.
- Done when: `node --test --test-timeout=30000 src/repository/github.test.ts` passes; `pnpm run verify` passes.

### 07.2 Add the poll create

- Files: `src/intake/inbound-create.ts`, `src/intake/inbound-create.test.ts`, `src/intake/contract.ts` (edit)
- Do:
  1. Admit `kind: "poll"` with a required `credential`; a poll without a credential answers 400 `gateway.request.validation_failed`.
  2. Generate the inbound identity. In one `store.transaction`, authorize and release a `poll` grant from the validated input, map a credential refusal with `credentialRefusal`, and commit the drain of the release before the call. Call `listEvents` with a null ETag, and drop the material in `finally`. A result class answers 422 `intake.inbound.platform_refused` and inserts nothing. A 401 or 403 is a refusal that belongs in the span of the create (decision D9).
  3. Insert through `commitInbound` with a null `checkpoint`, then call `pollLoops.start(id)` after the commit.
  4. Add tests: a create performs one request and inserts one row; a failed first request inserts no row; a poll without a credential answers 400; an unknown credential and a credential of another platform answer 422 `intake.inbound.credential_invalid` with no platform call; a credential archive between the first request and the insert refuses the insert and leaves no row; a failure after the release keeps the drain; the create starts one loop.
- Rules:
  - The create of a poll performs one request with the credential before the insert. `docs/reference/erd/03-integration.md:129`; `intake-service.md:62`.
  - A poll names a credential, and a webhook holds a null `credential`. `docs/reference/erd/03-integration.md:127`; `intake-service.md:54`.
  - A test covers a create of a poll whose first request fails, and it asserts no row; a test covers a credential archive between the first request and the insert, and it asserts that the insert refuses and that no row remains. `intake-service.impl.md:219–220`.
  - The create stores no event of its validation request; the first interval acquires the events of the answer, and the Intake Service promises no receipt of every update. `intake-service.md:186`.
  - The drain of the release commits before the call, and a later failure of the handler keeps it. `custody.impl.md:131`; `architecture.impl.md:702`; decision D3.
  - The platform refuses the first request of a poll create with 422 `intake.inbound.platform_refused`. `intake-service.impl.md:112`; `engine/docs/cli/intake.md:225–226`.
- Done when: `node --test --test-timeout=30000 src/intake/inbound-create.test.ts` passes; `pnpm run verify` passes.

### 07.3 Add the poll loop

- Files: `src/intake/poll.ts` (create), `src/intake/poll.test.ts` (create), `src/intake/service.ts` (edit)
- Do:
  1. Implement one loop per inbound: wait `pollIntervalMs`, then run one cycle, then schedule the next wait after the cycle ends. A `Map<inboundId, { timer; context }>` holds the loops.
  2. A cycle: read the inbound; stop the loop when the row is absent. When `pendingCount` reaches the bound, skip the request and wait for the next interval. Otherwise validate a non-null `checkpoint` with `githubCheckpointSchema` (a null checkpoint sends no ETag), authorize and release a `poll` grant, call `listEvents` with the ETag of `checkpoint` and a deadline of `PLATFORM_CALL_DEADLINE_MS`, and drop the material in `finally`.
  3. A 304 commits nothing. A 200 runs one `store.transaction`: discard the batch when the inbound row is absent; read and validate its `checkpoint`; insert `newerEvents` in ascending order while the pending count stays below the bound, skipping a pair that `findEvent` finds; write `checkpoint` = `{ etag, newest_event_id }`, where `newest_event_id` is the last inserted event, else the previous value (null before any acquisition), and `etag` is the ETag of the answer when no new event stays unstored, an empty or a duplicate-only answer included, and null when the bound left a new event unstored. After the commit, call `wake()`.
  4. A result class or a thrown error leaves `checkpoint` unchanged and logs the inbound identity and the code, with no material.
  5. Add tests with a controlled clock and a fake platform: a slow request starts no second request of that inbound before it ends; a store failure leaves the checkpoint unchanged; a delete of the inbound before the commit stores no event; a batch at the bound stores the events that fit and writes a null ETag, and after the test frees capacity the next interval acquires the rest; an empty 200 answer and a 200 answer of known events keep `newest_event_id` and store the ETag; a bound reached between the request and the commit leaves the new events unstored and writes a null ETag; a repeated event identity inserts no row; a cycle at the bound sends no request; the material drops after a success and after a failure.
- Rules:
  - The poll runs on an interval of 60 seconds per inbound with a release per request; each request carries a deadline. `intake-service.impl.md:65`; decision D12.
  - One poll request per inbound runs at a time; the next interval starts after the previous request ends. `intake-service.impl.md:66`.
  - The transaction that stores the batch also writes `checkpoint`, and it discards the batch when the inbound row no longer exists. `intake-service.impl.md:69`; `docs/reference/erd/03-integration.md:130`.
  - The poll pauses beyond the capacity bound and resumes when the count falls below it. `intake-service.impl.md:70`; `intake-service.md:178`.
  - A failed request leaves `checkpoint` unchanged. `intake-service.impl.md:71`.
  - The Intake Service never acknowledges an event and drops it; a poll acknowledges nothing, so a cut batch stays at the platform for the next request. `intake-service.md:179`.
  - The release under the Intake service identity pins nothing. Decision D24.
  - Gap: the failure span is ERD 4 work (decision D15); the acquisition deadline waits for HANDOFF (`docs/brainstorm/HANDOFF.md:46`). The poll loop runs outside a handler (decision D3).
- Done when: `node --test --test-timeout=30000 src/intake/poll.test.ts` passes; `pnpm run verify` passes.

### 07.4 Bind the poll loops to the service lifecycle

- Files: `src/intake/service.ts`, `src/intake/service.test.ts`, `src/apps/server/index.ts`, `src/apps/server/test-support.ts` (edit)
- Do:
  1. In `run()`, start one loop for every poll inbound. Implement `inboundRemoved(id)` of plan 05 as `pollLoops.stop(id)`.
  2. In `quiesce()`, mark the loops quiescent first, so no create, cycle end or timer starts or re-arms a loop; then stop every timer and cancel the `Context` of every running request; a cancelled request commits nothing. `drain()` awaits the promise of every running cycle, so phase 2 joins the loops before `invocation.stop()`. In `stop()`, await `stopAll()`.
  3. Add `pollIntervalMs` to the Intake `Dependencies` with the default `POLL_INTERVAL_MS`, and the fixture option `intake: { pollIntervalMs }` of `composeServices` and `gatewayFixture`.
  4. Add tests: a start runs one loop per poll inbound and none for a webhook; a delete stops its loop; after `drain()` no request runs and no timer exists; a late platform answer after `quiesce()` commits nothing; a create that ends after `quiesce()` starts no loop; a restart starts the loops again from the stored checkpoint.
- Rules:
  - A poll runs on a fixed interval while its inbound exists. `intake-service.md:73`.
  - Phase 1 stops every timer; phase 4 releases resources. `architecture.impl.md:458–479`.
  - The Intake Service owns the connection lifetime of every acquisition. `intake-service.md:24`.
  - No production code reads an environment variable for a fake. Decision D17.
- Done when: `node --test --test-timeout=30000 src/intake/service.test.ts` passes; `pnpm run verify` passes.

### 07.5 Add the events route to `fakeGitHub`

- Files: `src/apps/server/test-support.ts`, `src/apps/server/intake-fixtures.test.ts` (edit)
- Do:
  1. Serve `GET /repos/:owner/:repo/events` from a scripted list with an `ETag` that changes with the list, a 304 for a matching `If-None-Match`, the scripted failure of `respondNext`, and `failEvents(status)` that answers `status` to every events call until `failEvents(null)`, and `holdEvents({ pass })` that answers the next `pass` events calls and holds every later one until its release; a held call reads the scripted failure at its release, and `calls` records the status of every answer.
  2. Add tests of the route: a changed list changes the ETag; a matching ETag answers 304.
- Rules:
  - A remote service is faked through a fixture injection point. Decision D17.
- Done when: `node --test --test-timeout=30000 src/apps/server/intake-fixtures.test.ts` passes; `pnpm run verify` passes.

### 07.E E2E proof

- Files: `src/apps/server/e2e-poll-acquisition.test.ts` (create)
- Do:
  1. Start `fakeGitHub(t)` and `gatewayFixture` with `github: { baseUrl }` and `intake: { pollIntervalMs: 50, pendingEventLimit: 3 }`.
  2. Run E07.1 to E07.7 in one test in table order. Poll a CLI read every 50 ms for at most 5 s where a row waits for a cycle; release every hold of `fakeGitHub` in the test cleanup.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read. ERD 1 decision D13.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-poll-acquisition.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-poll-acquisition.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`, `fakeGitHub`, `kanthord(args, env)`. `H` names the human token.
- `poll.json` names `{ "projectId": <projectId>, "kind": "poll", "platform": "github", "consumer": "mission.delivery.admit", "credential": "github", "configuration": { "resource": "owner/repo" } }`. `ev(n, type)` names a GitHub event `{ "id": "<n>", "type": type, "payload": {} }`.

Setup: the credential `github` of plan 03; `kanthord project create --name polls` → `projectId`; `gitHub.events("owner", "repo", [ev(101, "PushEvent"), ev(100, "PullRequestEvent")])`.

| Id    | Commands                                                                                                                                                                                                                                                 | Exit    | Expect                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E07.1 | `gitHub.respondNext(401, { message: "Bad credentials" })`; `kanthord intake inbound create --file poll.json`; `kanthord intake inbound list --project <projectId>`                                                                                       | —, 1, 0 | stderr starts with `intake.inbound.platform_refused:`; `items` `[]`                                                                                                                                                  |
| E07.2 | `gitHub.holdEvents({ pass: 1 })`; `kanthord intake inbound create --file poll.json` → `P` = `id`                                                                                                                                                         | 0       | `kind` `poll`, `checkpoint` null; one events call completed, the validation request; a later acquisition request can arrive and stays held                                                                           |
| E07.3 | `gitHub.failEvents(500)`; release the events hold; wait until `gitHub.calls` records one events answer of status 500; `kanthord intake inbound get <P>`; `kanthord intake event list --inbound <P>`; `gitHub.failEvents(null)`                           | 0, 0    | `checkpoint` null; `items` `[]`                                                                                                                                                                                      |
| E07.4 | wait; `kanthord intake event list --inbound <P>`; `kanthord intake inbound get <P>`                                                                                                                                                                      | 0, 0    | two items with `eventId` `100` and `101`, `metadata` `{ "event": "PullRequestEvent" }` and `{ "event": "PushEvent" }`, each `pending`; `checkpoint.newest_event_id` `101` and `checkpoint.etag` the ETag of the list |
| E07.5 | wait two intervals; `kanthord intake event list --inbound <P>`                                                                                                                                                                                           | 0       | two items; the later events calls carry `If-None-Match` and answer 304                                                                                                                                               |
| E07.6 | `gitHub.events(…, [ev(103, "PushEvent"), ev(102, "PushEvent"), ev(101, "PushEvent"), ev(100, "PullRequestEvent")])`; wait; `kanthord intake event list --inbound <P>`; `kanthord intake inbound get <P>`; count the events calls over two more intervals | 0, 0, — | three items: `102` is stored and `103` waits, because the bound is 3; `checkpoint.newest_event_id` `102` and `checkpoint.etag` null; no events call while the bound holds                                            |
| E07.7 | `kanthord intake inbound delete <P>`                                                                                                                                                                                                                     | 1       | stderr starts with `intake.inbound.events_pending:`                                                                                                                                                                  |

Until plan 09 no dispatcher reads the events, so they stay `pending`; plan 09 task 09.6 moves the rows that assume a pending event.
