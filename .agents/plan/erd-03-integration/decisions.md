# ERD 3 plan decisions

The plans cite these decisions as D1 to D24. Each decision binds every plan and every task. A decision that repeats an ERD 1 or ERD 2 decision names it, and the earlier wording stands where this file says nothing else.

## D1 — A blocker is only a real gap

ERD 2 decision D1 stands. A blocker is a behavior question that no page, sibling, ERD page or CLI page answers, or a real conflict between two of them. Grep the sources before you write a blocker, and cite the line that proves the gap. Cross-plan alignment, reading a source, splitting a task and a one-line fix are plan work. A gap that an open HANDOFF item names is no blocker when the page as written is implementable: the task implements the page as written and states the gap in one line. A POSTPONED HANDOFF item is out of scope (`docs/brainstorm/HANDOFF.md:16`, `:47`).

A task that a blocker of `00-index.md` affects waits for the ruling of Ulrich and the publication of that ruling on its page. The plan records the recommendation of the blocker and names the task that implements it after the ruling. No plan edits a design source.

## D2 — Error codes

ERD 2 decision D2 stands. A task uses each code verbatim from its owning page and from `engine/docs/cli/intake.md` or the CLI page of the owning group. A code that no page names carries the mark `code: proposed` with the page line that rules the condition, and `00-index.md` "Codes for Ulrich" lists it. No plan edits a design page, a vocabulary page, a sibling, an ERD page or an `engine/docs/cli/` page. A task that needs a proposed code waits for its publication before its commit.

## D3 — One commit at the end, and the ruled writes before it

ERD 1 decision D3 and ERD 2 decision D3 stand with the index of ruled writes (`architecture.impl.md:700–704`). A handler completes its asynchronous work before its final `caller.commit`, and a handler that answers a result performs one `caller.commit` at the end. A ruled write commits in a synchronous transaction that the handler owns, at the point that the owning sibling rules. An error exit requires no additional `caller.commit`, and a failure before or inside the final `caller.commit` undoes no ruled write that committed earlier. The ERD 3 handlers meet these entries of the index:

- The outbound handler commits the `pending` request before the call (`intake-service.impl.md:166`; `docs/reference/erd/03-integration.md:119`, `:145`): `intake.action.perform` (plan 03) and `intake.storage.delete` (plan 04).
- A handler that releases material before a remote call commits any pin and drain of that release in its transaction before the call, and a later failure of the handler keeps them (`custody.impl.md:131`). Under an execution identity the release pins the revision (`custody.impl.md:177`), and under every identity it runs the drain check (`custody.impl.md:182–183`). This binds the action and storage operations of plans 03 and 04 and the poll create of plan 07.
- An outbound operation that answers an error commits its `failed` state in its own transaction before the handler answers the error, and a later failure of the handler keeps it (`intake-service.impl.md:170`; `mission-service.impl.md:368`): `intake.storage.delete` (plan 04).

ERD 2 already commits per result in `mission.node.check`, the fourth entry of the index (`mission-service.impl.md:261`; `engine/src/mission/node-check.ts:230`). Delivery admission writes nothing before its check and answers every disposition through its one final `caller.commit` (`mission-service.impl.md:256–257`). The dispatcher, the poll loop and the checks of the health report run outside a handler and own their transactions.

## D4 — Collaborations are required

ERD 1 decision D4 and ERD 2 decision D4 stand. Every collaboration and every client in a `Dependencies` type is required. Colocated tests inject fakes. The composition root wires the real implementation in the plan that provides it.

## D5 — Boundary and order

The set covers the three tables of `docs/reference/erd/03-integration.md`, the operations that write and read them, the outbound operations and checks that ERD 2 consumes as seams, the custody release of an inbound and of a Mission-authorized entity, the webhook and poll acquisition of GitHub, the handoff and `mission.delivery.admit`. The order is 01 foundation, 02 outbound record, 03 repository actions and check, 04 storage grants, 05 inbounds, 06 webhook, 07 poll, 08 delivery admission, 09 events and handoff, 10 health, Gateway, CLI and E2E.

The order swaps two plans of the fixed structure. The handoff calls `mission.delivery.admit` (`intake-service.impl.md:75`), so the handoff consumes the admission. With the admission as plan 08, the handoff of plan 09 calls the real operation, needs no stand-in under ERD 2 decision D9, and its E2E proves the chain from the webhook to the end state of the request. The event reads `intake.inbound.event.list` and `get` move from the handoff plan to plan 06, because the receipt is the first writer of `intake_inbound_event` and the E2E of plan 06 needs a CLI read of a stored event (ERD 1 decision D13).

Out of scope: the CLI transport and every CLI write (`docs/reference/erd/03-integration.md:23`; `intake-service.impl.md:194–206`; the code `intake.outbound.request.cli_unavailable` stays unanswered); Slack, Telegram and Jira (`docs/reference/erd/03-integration.md:19`); the native push send (`docs/brainstorm/HANDOFF.md:58`); the inbound request contract (`docs/brainstorm/HANDOFF.md:47`, POSTPONED); acceptance as a human act and the mapping from a platform account to a human identity (`docs/reference/erd/03-integration.md:21`; `docs/brainstorm/HANDOFF.md:36`); the cross-process identity contract (`docs/brainstorm/HANDOFF.md:16`, POSTPONED); the MCP server and its read tools (ERD 2 decision D5); every HANDOFF failure and recovery item; the stored telemetry of ERD 4.

## D6 — The ERD 2 seams and their stand-ins

ERD 2 decision D6 placed eight `unwired` seams: `IntakeStorage.put`, `check`, `get`, `executionGet`, `delete`, `IntakeCheck.check`, `IntakeActions.perform` and `IntakeActions.read` (`engine/src/apps/server/index.ts:196–239`; `engine/src/apps/server/unwired-import.test.ts:11–20`). The plan that implements a seam deletes its `unwired` literal, its member of the `standIns` option of `composeServices` and `gatewayFixture`, and its fake in `src/apps/server/test-support.ts` (`sinkStorage`, `scriptedCheck`, `scriptedActions`). That plan moves every ERD 2 test that uses the fake onto the real Intake Service over the fixture platforms of decision D17 (ERD 1 decision D14: "The plan that wires the real peer deletes the stand-in"). Plan 03 replaces the check and both action seams; plan 04 replaces the five storage seams. Plan 10 asserts the empty set. `src/apps/server/unwired.ts`, its test and the import test stay, because `architecture.impl.md:966–970` keeps the mechanism for a later ERD, and `unwired-import.test.ts:44` already admits an empty set.

## D7 — The service identity and the `service` policy

No service identity exists in the code (`engine/src/kernel/caller.ts:2`, `:22`), and `AccessPolicy` holds no `service` value (`engine/src/kernel/operation.ts:8–13`). Plan 01 adds them under `architecture.impl.md:665–671`, `:691–694`, `:938–945`: `ServiceIdentity { kind: "service"; service }`, `isServiceIdentity`, the factory `mintServiceIdentity(service)` in `src/kernel/service-mint.ts` that only `src/apps/server/` imports, and `AccessPolicy.Service`. A test that needs a minted service identity sits under `src/apps/server/`, because `architecture.impl.md:821` admits `test-identity.ts` for `caller-mint.ts` alone. A `service` operation has no HTTP route and no OpenAPI entry, the HTTP adapter answers 404 for its path, and the invocation chain admits only a minted service identity for it. The idempotency record of a service caller holds the service name (`architecture.impl.md:719`). The owning service authorizes the calling service by name (`architecture.impl.md:671`): `mission.delivery.admit` admits the service `intake` alone, and the Mission authorization of a request evidence under a service identity admits the service `mission` alone. The composition root mints one identity for each service that calls a peer: Intake in plan 01, Mission in plan 03.

## D8 — An Intake operation takes the entity, never an association

The protected facility takes no association from the caller (`custody.impl.md:119`), and the Mission Service authorizes each storage and repository operation through its own records (`intake-service.impl.md:134–137`; `mission-service.impl.md:567–574`). An Intake operation therefore takes the identity of the entity alone, and the Mission authorization answers every derived fact:

- `intake.action.perform` takes the action key, the operands and the request key; the facts are the `FrozenAction` and the pinned repository binding.
- `intake.action.read` and `intake.action.check` take the request evidence identity; the facts add its `platform` address.
- `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get` and `intake.storage.delete` take the evidence asset identity; the facts are the storage binding, the object key, the version, the size and the SHA-256.
- `intake.storage.put` runs before the asset row exists (`engine/src/mission/evidence-submit.ts:189–213`), so it takes the node, the asset identity, the storage binding identity, the size and the SHA-256. The Mission authorization checks the live claim and the storage binding of the pinned revision, refuses an asset identity that an asset row already holds, and derives the key with `objectKey` (`engine/src/mission/evidence-content.ts:213–225`). The Mission Service authorizes the presigned PUT inside `mission.evidence.submit`, before the asset row exists, and derives the key from the claim and the asset identity that the submission allocates (`mission-service.impl.md:569`). The refusal of an existing identity keeps a caller from addressing the object of a recorded asset. `intake.storage.put` has no HTTP route, so no caller outside the Mission Service selects the destination (`intake-service.impl.md:130`, `:144`).

The seven Intake API operations `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get` and `intake.storage.delete` declare `direct: true`. The direct adapter alone reaches each of them, and its access policy and its execution proof apply to the forwarded identity (`architecture.impl.md:667–669`; `intake-service.impl.md:130`). A `client` operation carries the execution identity in its path, so the invocation chain proves the live claim of the forwarded machine identity on the direct adapter (`architecture.impl.md:648–657`; `engine/src/gateway/invocation.ts:76–104`). The call envelope of each changed seam that calls a `client` operation carries `executionId` beside the context and the identity: `IntakeActions.perform`, `IntakeActions.read`, `IntakeStorage.put`, `IntakeStorage.check` and `IntakeStorage.executionGet`. `IntakeStorage.get` and `IntakeStorage.delete` forward a human identity, and `IntakeCheck.check` the Mission service identity; neither takes an execution (`intake-service.impl.md:124`, `:127–128`; `mission-service.md:802`). The ERD 2 seam types in `src/mission/contract.ts:95–166` and `src/worker/contract.ts:247–269` change to these inputs in plans 03 and 04.

## D9 — The protected facility serves every owner

ERD 2 built the facility for the model inference grant alone (`engine/src/custody/facility.ts:14–27`; `engine/src/custody/contract.ts:108–113`). Plan 03 generalizes it under `custody.impl.md:108–124`:

- `CustodyComponent.authorizeOperation(tx, request): Grant` dispatches on the request kind to the owner of the entity: the Worker Service for `model_inference`, the Mission Service for `frozen_action`, `request_evidence`, `evidence_asset` and `object_put`, and custody itself for `inbound`.
- A grant holds `credential` (a name or null), `platform`, `execution` (the claim or null) and `facts`. `grantFacts(grant)` answers the facts, which hold no secret.
- `release(tx, grant, now)` serves a grant with a credential. It pins the revision under `pinCredential` only when the grant holds an execution (`custody.impl.md:177`), and it resolves the newest live revision otherwise (`intake-service.impl.md:23`). `consume(grant)` serves a grant with a null credential, for `git.merge_push` and the check of a branch push (`intake-service.impl.md:135`).
- The Mission authorization collaborations are Kind 2 collaborations of custody on the Mission Service, because the pin and the authorized chain commit in one transaction (`architecture.impl.md:593–595`; `custody.impl.md:177`).
- Each remote call takes its own grant (`intake-service.md:37`; `intake-service.impl.md:19`; `custody.impl.md:113–114`). The one inbound operation is `poll` (`intake-service.impl.md:20–21`; `custody.impl.md:115`).
- The holder of the material writes a remote refusal into the span of its operation, with the credential name and revision, and custody stores no refusal (`custody.impl.md:140`). The span is ERD 4 work (decision D15). Custody gains no refusal method, and the holder writes no store row for a refusal.

## D10 — Platform implementations

The Repository component holds every git platform implementation (`repository.md:36–51`; `intake-service.md:29–30`), and the Storage component holds every object storage implementation (`storage.md:21–28`; `intake-service.md:31`). The composition root injects them into the Intake Service and the Mission Service:

- `src/repository/github.ts` uses `octokit` at 5.0.5 with `X-GitHub-Api-Version: 2022-11-28` (`repository.impl.md:15`). Plan 03 adds the dependency.
- `src/storage/s3.ts` is the S3 implementation of the Storage component. It uses `@aws-sdk/client-s3` at 3.1139.0 (`storage.impl.md:13`) and `@aws-sdk/s3-request-presigner` at 3.1139.0. No page names the presigner; it is the presigner of the installed client, and plan 04 adds it pinned to the version of the client (`engine/package.json`; root `AGENTS.md` keeps `minimumReleaseAge`). The report lists it for Ulrich.
- The network git write of `git.merge_push` and its read-back extend `src/repository/connector.ts` over `simple-git` (`repository.impl.md:42–58`).
- The decoder of a GitHub event is a pure function of `src/repository/github.ts` (`repository.md:51–52`).

## D11 — The result classes of GitHub and git

The vocabulary fixes the meaning of each class (`repository.vocabulary.md:28–42`), and `repository.impl.md:40–41` leaves the wait form of each platform to an epic. The plans map an HTTP answer to the vocabulary:

- For a write, a transport error before the request leaves the process answers `confirmed_failure` ("fails before dispatch and confirms no effect").
- 429, 408, and 403 with an exhausted `x-ratelimit-remaining` answer `retryable_refusal` ("refuses … because of a rate limit, with no effect, and permits a retry").
- Every other 4xx answers `final_refusal` ("authorization fails").
- For a write, a 5xx, a lost answer after dispatch, an abort and a deadline answer `unknown_outcome` ("loses its response after dispatch"). A write retries nothing (`repository.md:83`).
- For a read, a transport error retries inside the deadline (`repository.md:82`) and, at the end of the deadline, answers `retryable_refusal`; a 5xx answers `retryable_refusal` with no retry, because a read has no effect.
- A GitHub result class answers 502 `repository.platform.github.<class>` with `details: { status }` and the GitHub message. `status` holds the HTTP status of GitHub, or null when the failure carries none, for example a lost answer (`repository.impl.md:29`).
- An S3 result class answers 502 `storage.platform.s3.<class>` with `details: { status }`. `status` holds the HTTP status of the store, or null when the failure carries none (`storage.impl.md:18`). A presigned PUT and a presigned GET sign locally and answer no result class.
- `git.merge_push`: a failure before the push, including a merge conflict, answers `confirmed_failure` with `repository.connector.git_failed`; a failed, aborted or timed-out push answers `unknown_outcome`.

## D12 — Numeric bounds

Two values stand on a page, and each task declares them as named constants in `src/intake/contract.ts`:

| Constant             | Value | Rule                                                        |
| -------------------- | ----- | ----------------------------------------------------------- |
| `POLL_INTERVAL_MS`   | 60000 | `intake-service.impl.md:65`                                 |
| `PRESIGN_LIFETIME_S` | 3600  | `intake-service.impl.md:145`; `mission-service.impl.md:320` |

The pages leave the values below open, and HANDOFF names them for the implementation epics (`docs/brainstorm/HANDOFF.md:46`). Each task declares the constant and states the gap in one line. The values are epic choices for a server under the 1,000-project workload of that item; the epic of HANDOFF sets the acceptance bounds.

| Constant                    | Value  | Rule                                                                       |
| --------------------------- | ------ | -------------------------------------------------------------------------- |
| `PENDING_EVENT_LIMIT`       | 10000  | `docs/reference/erd/03-integration.md:139`; `intake-service.md:177`        |
| `ERROR_ARRAY_MAX_BYTES`     | 16384  | `docs/reference/erd/03-integration.md:137`                                 |
| `ERROR_MESSAGE_MAX_BYTES`   | 1024   | `intake-service.impl.md:79`                                                |
| `RESULT_MAX_BYTES`          | 65536  | `docs/reference/erd/03-integration.md:80`, `:148`                          |
| `DELETE_IDS_MAX`            | 1000   | the `--id` list of `engine/docs/cli/intake.md:157`, `:163`                 |
| `PLATFORM_CALL_DEADLINE_MS` | 30000  | `intake-service.impl.md:39`, `:65`                                         |
| `READ_ANSWER_MARGIN_MS`     | 1000   | `intake-service.impl.md:39`                                                |
| `GIT_WRITE_DEADLINE_MS`     | 540000 | `intake-service.md:127`                                                    |
| `ACTION_PERFORM_TIMEOUT_MS` | 600000 | below the 900 s of `worker.action.request` (`gateway-service.impl.md:302`) |
| `ADMISSION_CONCURRENCY`     | 1      | `mission-service.md:832` (a separate bound of admission processing)        |

Ulrich accepted the values of this table as the ERD 3 values. The HANDOFF item stays open only for the acceptance tests of the 1,000-project workload.

A range delete of events or of outbound requests that matches more than `DELETE_IDS_MAX` rows is refused with the `filter_invalid` code of that operation and deletes nothing; the caller narrows the range. The bound of an event is the 50 MiB body limit of a delivery (`gateway-service.impl.md:210`). Every other Intake route takes the default 30 s timeout (`gateway-service.impl.md:298`).

## D13 — The webhook receipt route

The receipt is the `delivery` operation `intake.inbound.event.receive` at `POST /hooks/:inboundId` (`intake-service.impl.md:52`; `engine/docs/cli/intake.md:381–399`; `architecture.impl.md:645–647`). The registry admits the prefix `/hooks/` for a `delivery` operation alone (`gateway-service.impl.md:485`, `:488`). A verified handshake answers 204 (`intake-service.impl.md:57`). A stored or a repeated event answers 202, the 2xx of `intake-service.impl.md:60–61`. The handler answers through a `Response`, which the handler type admits (`engine/src/kernel/operation.ts:92–95`).

## D14 — The configuration of an inbound

The fields beyond `resource` wait for HANDOFF (`docs/brainstorm/HANDOFF.md:60`; `engine/docs/cli/intake.md:198`). The GitHub schema of both kinds is `z.strictObject({ resource })`, where `resource` is `<owner>/<repository>` in the character set of the repository address pattern (`engine/src/project/store.ts:38–39`). The resource identity of a GitHub inbound is `repository:github:<resource>`, the form of `project-service.impl.md:75`.

kanthord registers no webhook at a platform. A human sets the address, the verification secret and the events of a webhook inbound at the platform (`intake-service.impl.md:39–40`; `docs/reference/erd/03-integration.md:128`), so no code holds a list of webhook events.

## D15 — Spans of the Tracking Service

No Tracking interface exists in the code (ERD 1 decision D8; ERD 2 decision D7). A span that an ERD 3 page requires (`intake-service.md:69`; `intake-service.impl.md:35`, `:58`, `:71`; `mission-service.impl.md:256`; `docs/reference/erd/03-integration.md:32–33`) is ERD 4 work. Each task that meets one writes nothing for it and states the gap in one line. An operational log record of the failure stays allowed, with no material.

## D16 — The admission contract

`mission-service.impl.md:252–260` rules the contract of `mission.delivery.admit`, and `mission-service.md:836–852` rules its dispositions. The Intake Service loads every input field from its own rows: the immutable inbound row (`docs/reference/erd/03-integration.md:124`) and the unchanged event row (`:135`). The Mission Service trusts those facts because only the minted Intake service identity reaches the operation (decision D7).

- Input body: `inboundEventId`, `projectId`, `platform`, `resource` (from `configuration`), `event` (the exact bytes in canonical base64) and `metadata` (`mission-service.impl.md:253`).
- Answer: `{ disposition, reason }`. `disposition` is `accepted_observation`, `refused` or `duplicate`. `reason` is `ambiguous`, `unmatched` or `undecodable` for `refused`, and null otherwise (`mission-service.impl.md:254`).
- Admission decodes the event first, and a decoding with no address answers `undecodable`. A read transaction then matches the canonical JSON of the address against the `platform` asset of each request evidence of the project. One unresolved match of an open attempt goes to the Intake check. More unresolved matches answer `ambiguous`. No unresolved match answers `duplicate` when a resolved request matches, and `unmatched` otherwise (`mission-service.impl.md:255`; `mission-service.md:838–841`).
- The handler calls the Intake check before its commit. A failed check propagates as an operation failure and writes nothing, so the Intake Service marks the event `failed` (`mission-service.impl.md:256`; `mission-service.md:850`). No live-claim test runs before the Intake check.
- Every disposition returns through the one final `caller.commit`. A `none` result answers `accepted_observation` with a null `reason`, and a refusal, a duplicate and a `none` result commit no write (`mission-service.impl.md:257`).
- For an `expected` or `other` result, the commit first reads the checked request evidence, and an end state on it answers `duplicate`. Otherwise the commit repeats the match. Another evidence that became the one unresolved match answers 409 `mission.delivery.match_changed`, and a live claim on the node answers 409 `mission.node.claim_live` with `details: { nodeId, executionId }` (`mission-service.impl.md:258`; `mission-service.md:851`). Each answers the failure and writes nothing, and a human retries the event.
- Otherwise the commit sets the end state, writes each landed commit of an `expected` result of a repository action as its own evidence with `inbound_event_id`, and writes the node transition and the attempt closure in the same transaction (`mission-service.impl.md:259`; `docs/reference/erd/03-integration.md:154`).
- Each handoff calls the consumer with a fresh ULID idempotency key (`intake-service.impl.md:81`).
- Acceptance as a human act stays out of scope (decision D5; `mission-service.impl.md:252`).

## D17 — Fixture platforms

ERD 2 decision D16 stands: no plan performs a real platform call. `composeServices` and `gatewayFixture` gain fixture injection points (ERD 1 decision D13: "A remote service is faked through a fixture injection point"):

- `github: { baseUrl }`: the GitHub implementation calls `fakeGitHub(t)`, an in-process HTTP server of `src/apps/server/test-support.ts` that scripts pull requests and repository events (plans 03, 07).
- The storage binding names the endpoint of `fakeS3(t)`, an in-process path-style S3 emulation that replaces `objectSink` (plan 04).
- `repositoryTransport`: the server-side git write targets local bare repositories through `bareRepository` and `mappedTransport`, which plan 03 lifts into `test-support.ts` from ERD 2 plan 10 task 10.9.
- `intake: { pollIntervalMs }`: the poll interval of the E2E (plan 07). No production code reads an environment variable for a fake.

## D18 — Removed: the public address of a webhook

Removed. kanthord calls no platform for a webhook inbound, so no public origin of the `/hooks/` path group enters the configuration (`intake-service.impl.md:39–40`). The number stays, so the cross-references of the plans stay valid.

## D19 — Plan size

ERD 2 decision D22 stands: a task is one commit of fewer than about 400 changed lines, and a plan holds at most twenty tasks.

## D20 — Database conventions

ERD 2 decision D24 stands. The Intake tables use the indexes `intake_inbound_event_inbound_event` on `(inbound_id, event_id)` and `intake_outbound_request_operation_key` on `(operation, request_key)`, both unique, and no other index (`docs/reference/erd/03-integration.md:125`, `:133`, `:143`). `intake_inbound_event.inbound_id` takes a `REFERENCES intake_inbound(id)` clause, because both tables have one owner and the ERD draws `FK inbound_id` (`docs/reference/erd/03-integration.md:87`). `project_id` is the second column of `intake_inbound` and `intake_outbound_request`. Every JSON property inside a column is snake_case (`docs/reference/erd/03-integration.md:126`).

## D21 — Standing precedents and boundary changes

ERD 2 decision D23 stands. Plan 01 adds `intake` to the `service` element pattern of `eslint.config.js` and the `service-mint.ts` rule of `architecture.impl.md:821`, `:940`. The test files of `apps-server` keep the allowances of ERD 2 decision D23. Plan 03 admits `src/mission/test-support.ts` for the apps-server test files, because the D7 service-identity tests sit under `src/apps/server/`.

## D22 — Pre-existing deviations are findings, not blockers

ERD 2 decision D26 stands. The camelCase properties of the ERD 2 JSON columns stay as built (`docs/brainstorm/HANDOFF.md:57`); every new ERD 3 JSON property is snake_case.

## D23 — Pagination of the Intake lists

`architecture.impl.md:181–188` rules every list: descending primary key, `limit` 1 to 1000 with default 100, base64url cursor of the last key, 400 `system.pagination.cursor_invalid`. The phrase "in the order of `id`" (`intake-service.impl.md:186`; `engine/docs/cli/intake.md:337`) reads as that order.

## D24 — The credential release of an execution, a human and a service

The release under an execution identity pins the revision at its first use (`custody.impl.md:177`; `intake-service.impl.md:135`): the repository credential of `github.pull_request` and of `intake.action.read`, and the storage credential of `intake.storage.put`, `intake.storage.check` and `intake.execution.storage.get`. The release under a human identity (`intake.storage.get`, `intake.storage.delete`) and under a service identity (`intake.action.check`, every `poll` request) resolves the newest live revision and pins nothing.
