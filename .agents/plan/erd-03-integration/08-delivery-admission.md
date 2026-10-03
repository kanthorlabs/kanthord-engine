# Plan 08: Mission Service — delivery admission

## Scope

This plan delivers:

- The GitHub event decoder of the Repository component: a pure function from an inbound event to the address of its external object.
- The `service` operation `mission.delivery.admit` with the proposed contract of decision D16.
- The match of a request evidence by the canonical JSON of its `platform` asset among the unresolved requests of the open attempts of the project, with the refusals `ambiguous`, `unmatched` and `undecodable` and the disposition `duplicate`.
- The Intake check before the admission transaction, and the transaction that writes the end state and the landed-commit evidence with `inbound_event_id` in its provenance.
- The check of the calling service by name, the revalidation of the match at the commit, and the refusal of a match whose node holds a live claim.

Out of scope:

- Acceptance as a human act, the linked human identity and the human-act idempotency (decision D5; `docs/brainstorm/HANDOFF.md:29`).
- A request for new WHAT and the inbound request contract (`docs/brainstorm/HANDOFF.md:40`, POSTPONED).
- The deduplication key of an unchanged state (B9 C3, `docs/brainstorm/HANDOFF.md:107`) and the reversal of an accepted state (C5).
- The span of the disposition (decision D15). The answer of the operation carries the disposition.
- The handoff that calls the operation (plan 09).

## Sources

- `docs/reference/erd/03-integration.md:11–12`, `:33`, `:92`, `:153–162`, `:172` — admission sets the end state; the disposition is a span; the provenance reference; the constraints of the Mission Service.
- `docs/brainstorm/mission-service.md:257–273` — the request evidence, its end state, the fold of the Intake Service.
- `docs/brainstorm/mission-service.md:284`, `:288` — the landed commit and its evidence.
- `docs/brainstorm/mission-service.md:604–605` — the transitions of `External.Requested`.
- `docs/brainstorm/mission-service.md:801` — admission needs no claim.
- `docs/brainstorm/mission-service.md:817–869` — delivery admission and check.
- `docs/brainstorm/mission-service.vocabulary.md:655–681` — delivery admission, disposition, external input, linked human identity.
- `docs/brainstorm/mission-service.impl.md:25–33` — the service actor.
- `docs/brainstorm/mission-service.impl.md:241–252` — the request record, `PlatformAddress`, the landed-commit evidence with `inbound_event_id`, `mission.delivery.admit`.
- `docs/brainstorm/intake-service.md:115–131` — the handoff and the consumer.
- `docs/brainstorm/intake-service.vocabulary.md:24–27`, `:29–33` — the consumer set, the inbound event.
- `docs/brainstorm/repository.md:48–52` — the decoder is pure and performs no API operation.
- `docs/brainstorm/repository.impl.md:33` — the GitHub implementation decodes a webhook payload.
- `docs/brainstorm/architecture.impl.md:664–669`, `:695–708` — the `service` policy, the calling service by name, the handler.
- `docs/brainstorm/architecture.impl.md:191–200` — canonical JSON.
- `engine/docs/cli/mission.md:532`, `:881` — only delivery admission and node check set the end state; admission has no CLI command.
- `engine/src/mission/node-check.ts:55–167` — `requestContext` and `applyEndState`.
- `engine/src/mission/contract.ts:731–744` — `PlatformAddress`.
- Decisions D3, D5, D7, D15, D16 of `decisions.md`.

### Contract keys

| Key                                              | Where                                      | Owner line                                                                           |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `inboundEventId`                                 | input body                                 | `docs/reference/erd/03-integration.md:92`, `:172` (`inbound_event_id`); decision D16 |
| `inboundId`, `projectId`, `platform`, `resource` | input body: the facts of the inbound       | `mission-service.md:834` "resolves the project from the inbound"; `repository.md:47` |
| `eventId`, `event`, `metadata`                   | input body: the stored event               | `docs/reference/erd/03-integration.md:66–68`; `intake-service.md:123`                |
| `disposition`, `reason`, `evidenceId`            | answer                                     | `mission-service.vocabulary.md:663–667`; `mission-service.impl.md:250`; decision D16 |
| `inbound_event_id`                               | the provenance of a landed-commit evidence | `mission-service.impl.md:248`; `docs/reference/erd/03-integration.md:159`            |

## Depends on

- Plan 01: the service identity and `AccessPolicy.Service`.
- Plan 03: `intake.action.check`, the changed `IntakeCheck`, the Mission service identity, `GitHubPlatform`, `fakeGitHub` and the repository fixtures.
- ERD 2 plan 04: `applyEndState` and the external closure of `mission.node.check`.
- No stand-in.

## Provides

| Seam                     | TypeScript signature                                                                                                                                                                                                                                                                       | Owner file                 | Consumer plans |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | -------------- |
| `decodeGitHubEvent`      | `({ resource: string; event: Uint8Array; metadata: unknown }): DecodedAddress \| null`, with `DecodedAddress` a structural type declared in the Repository module: `{ kind: "pull_request"; resourceIdentity; number } \| { kind: "branch_push"; resourceIdentity; branch; commit }`       | `src/repository/github.ts` | 08             |
| `EventDecoder`           | `decode({ platform; resource; event: Uint8Array; metadata }): PlatformAddress \| null`, declared inline in Mission and wired structurally by the composition root                                                                                                                          | `src/mission/contract.ts`  | 08             |
| `mission.delivery.admit` | `service` operation; input `{ inboundEventId; inboundId; projectId; platform; resource; eventId; event; metadata }`; answer `{ disposition: "accepted_observation" \| "refused" \| "duplicate"; reason: "ambiguous" \| "unmatched" \| "undecodable" \| null; evidenceId: string \| null }` | `src/mission/contract.ts`  | 09             |
| Service actor provenance | the service actor gains an optional `inbound_event_id`                                                                                                                                                                                                                                     | `src/mission/contract.ts`  | 09, 10         |

## Tasks

### 08.1 Add the GitHub event decoder

- Files: `src/repository/github.ts`, `src/repository/github.test.ts` (edit)
- Do:
  1. Implement `decodeGitHubEvent({ resource, event, metadata })`, pure and with no API call. Validate `metadata` with `z.strictObject({ event: z.string().min(1) })`; parse the bytes as JSON; validate each payload with a local `zod` schema; answer null on every failure.
  2. For `metadata.event` = `pull_request`, require `repository.full_name` = `resource` and a positive integer `number`, and answer `{ kind: "pull_request", resourceIdentity: "repository:github:" + resource, number }`. For `push`, require the same repository, a `ref` of the form `refs/heads/<branch>` and an `after` of 40 lower-case hexadecimal characters that is no all-zero commit, and answer `{ kind: "branch_push", resourceIdentity, branch, commit: after }`.
  3. For the polled types, take the repository from `repo.name`: `PullRequestEvent` answers the pull request of `payload.number`; `PushEvent` answers the branch push of `payload.ref` and `payload.head`.
  4. Answer null for every other event type and for another repository.
  5. Add tests: a merged pull request, a closed one, a push to `main`, a branch delete, a ping, another repository, the two polled types, malformed bytes, JSON `null`, an array, a missing nested object, a zero or negative number, an upper-case commit, metadata of another shape.
- Rules:
  - The GitHub implementation decodes a GitHub webhook payload into GitHub event types; a payload decoder is pure and performs no API operation. `repository.impl.md:33`; `repository.md:51–52`.
  - Admission invokes the decoding of the platform implementation, which answers the address of the external object; admission interprets no platform payload. `mission-service.md:835–836`.
  - A `pull_request` address adds `number`; a `branch_push` address adds `branch` and `commit`. `mission-service.impl.md:244`. The inbound resource maps to the resource identity under decision D14.
  - The Repository module imports no service type (`engine/eslint.config.js:55–57`), so its result type is structural.
- Done when: `node --test --test-timeout=30000 src/repository/github.test.ts` passes; `pnpm run verify` passes.

### 08.2 Add `inbound_event_id` to the service provenance

- Files: `src/mission/contract.ts`, `src/mission/node-check.ts`, `src/mission/node-check.test.ts` (edit)
- Do:
  1. Extend the service actor of the provenance schema with an optional `inbound_event_id: identitySchema("inbound_event")`.
  2. Give `applyEndState` an optional sixth argument `{ inboundEventId }`, after `now`, which adds `inbound_event_id` to the provenance of each landed-commit evidence; `mission.node.check` passes none.
  3. Add tests: the human check writes the provenance `{ kind: "service", service: "mission" }` with no `inbound_event_id`; a call with the argument writes it; the evidence read answers it.
- Rules:
  - Delivery admission adds `inbound_event_id` to the provenance of a landed-commit evidence; a human check writes the provenance without it. `mission-service.impl.md:248`; `docs/reference/erd/03-integration.md:159`.
  - Every property name inside a JSON column of ERD 3 is snake_case. `docs/reference/erd/03-integration.md:127`; decision D22.
- Done when: `node --test --test-timeout=30000 src/mission/node-check.test.ts` passes; `pnpm run verify` passes.

### 08.3 Declare `mission.delivery.admit` and add the request match

- Files: `src/mission/contract.ts`, `src/mission/delivery-match.ts` (create), `src/mission/delivery-match.test.ts` (create), `src/mission/service.ts`, every Mission fixture that builds `Dependencies`, `src/apps/server/index.ts` (edit)
- Do:
  1. Declare `delivery.admit` through the `service` policy of task 01.2: `access: Service`, `mutation: true`, `lifetime: Unary`, the default timeout, body `z.strictObject({ inboundEventId: identitySchema("inbound_event"), inboundId: identitySchema("inbound"), projectId: identitySchema("project"), platform: z.string().min(1), resource: z.string().min(1), eventId: z.string().min(1), event: canonicalBase64Schema, metadata: z.record(z.string(), z.unknown()) })`, output the answer of "Provides". Its `POST /api/mission/delivery/admit` is the identity of the declaration and no route.
  2. Declare the closed sets `Disposition` (`accepted_observation`, `refused`, `duplicate`) and `AdmissionRefusal` (`ambiguous`, `unmatched`, `undecodable`) as `as const` objects with their schemas (`code: proposed` values).
  3. Declare inline `EventDecoder`, add `decoder: EventDecoder` to the Mission `Dependencies` and to every Mission fixture of `Dependencies`, and wire `decode: ({ platform, resource, event, metadata }) => platform === "github" ? decodeGitHubEvent({ resource, event, metadata }) : null` in `composeServices`.
  4. Implement `matchRequests(tx, projectId, address)`: read every request evidence of a node of the mission of `projectId` together with its `platform` asset, compare the asset content with `canonicalJSON(address)`, and answer `{ unresolved, resolved }`: `unresolved` holds the matches whose attempt is open and whose `end_state` is null, `resolved` holds the matches with an `end_state` in any attempt. Answer `refused` with `ambiguous` for two or more unresolved matches, the one unresolved match, `duplicate` for none and one resolved match at least, and `refused` with `unmatched` for none.
  5. Add tests: a request of an open attempt matches; a request of a closed attempt with no end state does not; two open attempts of two nodes with one address refuse as `ambiguous`; a resolved request answers `duplicate`; a request of another project never matches; a reordered JSON member still matches; the HTTP adapter answers 404 for the path and the OpenAPI holds no operation identity `mission.delivery.admit`.
- Rules:
  - `mission.delivery.admit` is the `service` operation of delivery admission, which the Intake Service calls under its service identity. `mission-service.impl.md:250`; `architecture.impl.md:664–668`.
  - Admission finds the request evidence among the requests of an open attempt of the project that hold no end state, by the canonical JSON of its `platform` asset; more than one match refuses with `ambiguous`; a repeat that finds the end state answers `duplicate`. `docs/reference/erd/03-integration.md:156–157`; `mission-service.md:822`, `:834–840`.
  - The closed set of dispositions; the human act stays out of scope. `mission-service.vocabulary.md:666`; decision D16.
  - Gap: no page names the input, the answer, the disposition values or the reasons `unmatched` and `undecodable` (decision D16, `code: proposed`). The task waits for their publication (decision D2).
- Done when: `node --test --test-timeout=30000 src/mission/delivery-match.test.ts` passes; `pnpm run verify` passes.

### 08.4 Implement the admission handler

- Files: `src/mission/delivery-admit.ts` (create), `src/apps/server/delivery-admit.test.ts` (create), `src/mission/service.ts` (edit)
- Do:
  1. Stage one, before any transaction: refuse a caller that is not the minted Intake service identity with 403 `mission.authorization.refused` and `details: { reason: "service_mismatch" }`; decode the event, and a null address goes to stage four with `undecodable`.
  2. Stage two, one read `store.transaction` that ends before any await: run `matchRequests`; a refusal or a duplicate goes to stage four with no write; for the one unresolved match, read the live claim of its node through `schedulerClaims.liveExecutionOf` and answer the failure 409 `mission.node.claim_live` (`code: proposed` for this use) when one runs.
  3. Stage three: call `intakeCheck.check(caller.context, evidenceId)`. A failure propagates unchanged and writes nothing.
  4. Stage four, one `caller.commit` with no await inside. An `undecodable`, a refused or a `duplicate` decision of stages one and two returns its answer with no write and no second match. For a checked evidence, run `matchRequests` and the live-claim check again, with these branches: the same evidence is still the one unresolved match and no claim is live → `applyEndState(tx, dependencies, evidenceId, answer, now, { inboundEventId })` and `accepted_observation`, where a `none` answer writes nothing; the evidence resolved meanwhile → `duplicate`; two or more unresolved matches → `refused` with `ambiguous`; no match at all → `refused` with `unmatched`; another evidence became the one unresolved match → the failure 409 `mission.delivery.match_changed` (`code: proposed`), with no write; a claim became live → the 409 of stage two.
  5. After the commit, call `wakeup.wake(projectId)`.
  6. Run one admission at a time through a module-private promise chain of the Mission Service (`ADMISSION_CONCURRENCY`).
  7. Add tests in `src/apps/server/delivery-admit.test.ts`, which mints the identities: a merged pull request sets `expected`, writes one landed-commit evidence with `inbound_event_id` and moves `External.Requested` to `Completed` under a current passing assessment; a closed pull request sets `other` and moves the node to `Blocked`; an open pull request writes nothing; a repeat answers `duplicate` and writes nothing; a failed check writes nothing and propagates its code; a live claim on the node answers 409 and writes nothing; an attempt that closes during the check, a second matching request that appears during the check, a replacement request that becomes the one match during the check (409 `mission.delivery.match_changed`) and a human check that resolves the request during the check each write no second end state; another service identity refuses.
- Rules:
  - Admission calls the check of the Intake Service before its transaction; the transaction writes `end_state` of the request and the landed-commit evidence together; a failed check answers a retryable failure and writes nothing. `docs/reference/erd/03-integration.md:158`; `mission-service.md:842–847`; `mission-service.impl.md:250`.
  - A refusal and a `none` result write nothing. `docs/reference/erd/03-integration.md:160`.
  - The Mission Service sets the end state of a request after the execution releases. `mission-service.md:294`.
  - The end state moves `External.Requested` to `External.Success` or `External.Failed`, and the state transitions close the attempt. `mission-service.md:604–611`. Blocker B11: `docs/reference/erd/03-integration.md:155` names the two rows alone; the task waits for its ruling.
  - Admission needs no claim and operates when a project has no live worker instance. `mission-service.md:801`, `:827`.
  - A transaction awaits nothing, and the handler performs one `caller.commit` at the end. `architecture.impl.md:697–700`.
  - The owning service authorizes the calling service by name. `architecture.impl.md:669`. The reason `service_mismatch` is `code: proposed`.
  - Gap: the bound of admission processing has no value on a page (`mission-service.md:831`; `docs/brainstorm/HANDOFF.md:39`); decision D12. The span of the disposition is ERD 4 work (decision D15).
- Done when: `node --test --test-timeout=30000 src/apps/server/delivery-admit.test.ts` passes; `pnpm run verify` passes.

### 08.E E2E proof

- Files: `src/apps/server/e2e-delivery-admission.test.ts` (create)
- Do:
  1. Start `fakeGitHub(t)`, the bare repository `gated` and `gatewayFixture` with the fixture platforms of plan 03.
  2. Build objective P of plan 03 "E2E" (E03.1 to E03.4) to `External.Requested` with the pull request 1.
  3. Call `mission.delivery.admit` through `directClient(missionOperations, fixture.invocation)` with `mintServiceIdentity("intake")` and a fresh idempotency key, because the operation has no route (decision D7). Run E08.1 to E08.7 in one test in table order.
- Rules:
  - A `service` operation has no CLI command and no route; the state check is a CLI read. ERD 1 decision D13; `engine/docs/cli/mission.md:881`.
  - The event bytes are the GitHub payloads of the table, encoded in canonical base64.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-delivery-admission.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-delivery-admission.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`, `fakeGitHub`, `kanthord(args, env)`, `directClient`. `A(e, i)` names `admit({ inboundEventId: i, inboundId: "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV", projectId, platform: "github", resource: "owner/gated", eventId: <fresh string>, event: base64(e), metadata: { event: <type of e> } })` under `mintServiceIdentity("intake")`, where `i` is a fresh `inbound_event_<ulid>` that the test keeps.
- `closed(n, merged)` names the webhook payload `{ "action": "closed", "number": n, "pull_request": { "merged": merged }, "repository": { "full_name": "owner/gated" } }`. `m` names the 40-character commit `eeee…e`.
- E08.3 sets `fakeGitHub.failPulls(502)`; a read answers `retryable_refusal` for a 5xx with no retry (decision D11), so one failed read ends the check.

| Id    | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit       | Expect                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E08.1 | `A(ping, i1)` with `metadata.event` `ping`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —          | `{ disposition: "refused", reason: "undecodable", evidenceId: null }`                                                                                          |
| E08.2 | `A(closed(9, true), i2)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —          | `refused`, `unmatched`                                                                                                                                         |
| E08.3 | `gitHub.failPulls(502)`; `A(closed(1, true), i3)`; `gitHub.failPulls(null)`; `kanthord mission node get <P>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —, —, —, 0 | a failure whose code is `repository.platform.github.retryable_refusal`; `state` `External.Requested`                                                           |
| E08.4 | `gitHub.merge(1, m)`; `A(closed(1, true), i4)`; `kanthord mission node get <P>`; `kanthord mission evidence list <P> --attempt 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —, —, 0, 0 | `accepted_observation` with the request evidence of P; `state` `Completed`; one landed-commit evidence of `m` whose provenance holds `inbound_event_id` = `i4` |
| E08.5 | `A(closed(1, true), i5)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —          | `duplicate`, `evidenceId` the request evidence of P                                                                                                            |
| E08.6 | For two more objectives R and U on the binding `gated`, created after P completes: the flow of plan 03 E03.1 with commits `r` and `u`; `mission.evidence.request` of each through `httpClient(missionOperations, …)` under its evaluation claim with the body `{ ctx(e, x), "requirementKey": "gated.pull_request", "subject": "gated.pull_request", "address": { "kind": "pull_request", "resourceIdentity": "repository:github:owner/gated", "number": 7 } }`; `kanthord scheduler execution release` of each [T] with `release(false)`; `A(closed(7, true), i6)`; `kanthord mission external-action list <R> --attempt 1` | —, 0, —, 0 | both requests complete; the admission answers `refused`, `ambiguous`; `items[0].resolution` `unresolved`                                                       |
| E08.7 | `A(closed(7, true), i7)` under `mintServiceIdentity("mission")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —          | a failure with status 403, `mission.authorization.refused`, `details.reason` `service_mismatch`                                                                |

E08.1 to E08.7 assert `code: proposed` values and wait for their publication and for the ruling of B11 (decision D2).

## Blockers

- B11 of `00-index.md`: the ERD names two written rows, and the end state also moves the node and closes the attempt. Task 08.4 and the E2E wait for its ruling.
- `code: proposed`: the contract of decision D16 (task 08.3), the reason `service_mismatch`, the use of `mission.node.claim_live` and `mission.delivery.match_changed` (task 08.4). Tasks 08.3, 08.4 and 08.E wait for their publication; task 08.1 and task 08.2 do not.
