# Plan 08: Mission Service — delivery admission

## Scope

This plan delivers:

- The GitHub event decoder of the Repository component: a pure function from an inbound event to the address of its external object.
- The `service` operation `mission.delivery.admit` with the contract of `mission-service.impl.md:252–260` (decision D16).
- The match of a request evidence by the canonical JSON of its `platform` asset among the unresolved requests of the open attempts of the project, with the refusals `ambiguous`, `unmatched` and `undecodable` and the disposition `duplicate`.
- The Intake check before the commit, and the commit that writes the end state, the landed-commit evidence with `inbound_event_id` in its provenance, the node transition and the attempt closure.
- The check of the calling service by name, the repeat of the match at the commit, and the refusals 409 `mission.delivery.match_changed` and 409 `mission.node.claim_live` at the commit of a result that sets an end state.

Out of scope:

- Acceptance as a human act, the linked human identity and the human-act idempotency (decision D5; `docs/brainstorm/HANDOFF.md:36`).
- A request for new WHAT and the inbound request contract (`docs/brainstorm/HANDOFF.md:47`, POSTPONED).
- The deduplication key of an unchanged state (the failure and recovery item C3, `docs/brainstorm/HANDOFF.md:119`) and the reversal of an accepted state (C5).
- The span of the disposition (decision D15). The answer of the operation carries the disposition.
- The handoff that calls the operation (plan 09).

## Sources

- `docs/reference/erd/03-integration.md:11–12`, `:33`, `:91`, `:152–161`, `:171` — admission sets the end state; the disposition is a span; the provenance reference; the constraints of the Mission Service.
- `docs/brainstorm/mission-service.md:257–273` — the request evidence, its end state, the fold of the Intake Service.
- `docs/brainstorm/mission-service.md:284`, `:288` — the landed commit and its evidence.
- `docs/brainstorm/mission-service.md:605–606` — the transitions of `External.Requested`.
- `docs/brainstorm/mission-service.md:802` — admission needs no claim.
- `docs/brainstorm/mission-service.md:818–874` — delivery admission and check, with the dispositions `unmatched` and `undecodable` (`:840–841`) and the live claim at an end state (`:851–852`).
- `docs/brainstorm/mission-service.vocabulary.md:656–682` — delivery admission, disposition, external input, linked human identity.
- `docs/brainstorm/mission-service.impl.md:25–33` — the service actor.
- `docs/brainstorm/mission-service.impl.md:243–262` — the request record, `PlatformAddress`, the landed-commit evidence with `inbound_event_id`, the contract of `mission.delivery.admit` (`:252–260`).
- `docs/brainstorm/intake-service.md:106–122` — the handoff and the consumer.
- `docs/brainstorm/intake-service.vocabulary.md:22–25`, `:27–31` — the consumer set, the inbound event.
- `docs/brainstorm/repository.md:48–52` — the decoder is pure and performs no API operation.
- `docs/brainstorm/repository.impl.md:36` — the GitHub implementation decodes a webhook payload.
- `docs/brainstorm/architecture.impl.md:665–671`, `:697–712` — the `service` policy, the calling service by name, the handler.
- `docs/brainstorm/architecture.impl.md:191–200` — canonical JSON.
- `engine/docs/cli/mission.md:538`, `:888` — only delivery admission and node check set the end state; admission has no CLI command; its input and answer.
- `engine/docs/cli/mission.md:987`, `:1026` — `mission.delivery.match_changed` and `mission.node.claim_live` for delivery admission.
- `engine/src/mission/node-check.ts:55–167` — `requestContext` and `applyEndState`.
- `engine/src/mission/contract.ts:731–744` — `PlatformAddress`.
- Decisions D3, D5, D7, D15, D16 of `decisions.md`.

### Contract keys

| Key                                 | Where                                      | Owner line                                                                    |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `inboundEventId`                    | input body                                 | `mission-service.impl.md:253`; `docs/reference/erd/03-integration.md:91`      |
| `projectId`, `platform`, `resource` | input body: the facts of the inbound       | `mission-service.impl.md:253`; `mission-service.md:835`                       |
| `event`, `metadata`                 | input body: the stored event               | `mission-service.impl.md:253`; `docs/reference/erd/03-integration.md:66–67`   |
| `disposition`, `reason`             | answer                                     | `mission-service.impl.md:254`; `engine/docs/cli/mission.md:888`; decision D16 |
| `inbound_event_id`                  | the provenance of a landed-commit evidence | `mission-service.impl.md:250`; `docs/reference/erd/03-integration.md:158`     |

## Depends on

- Plan 01: the service identity and `AccessPolicy.Service`.
- Plan 03: `intake.action.check`, the changed `IntakeCheck`, the Mission service identity, `GitHubPlatform`, `fakeGitHub` and the repository fixtures.
- ERD 2 plan 04: `applyEndState` and the external closure of `mission.node.check`.
- No stand-in.

## Provides

| Seam                     | TypeScript signature                                                                                                                                                                                                                                                                 | Owner file                 | Consumer plans |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | -------------- |
| `decodeGitHubEvent`      | `({ resource: string; event: Uint8Array; metadata: unknown }): DecodedAddress \| null`, with `DecodedAddress` a structural type declared in the Repository module: `{ kind: "pull_request"; resourceIdentity; number } \| { kind: "branch_push"; resourceIdentity; branch; commit }` | `src/repository/github.ts` | 08             |
| `EventDecoder`           | `decode({ platform; resource; event: Uint8Array; metadata }): PlatformAddress \| null`, declared inline in Mission and wired structurally by the composition root                                                                                                                    | `src/mission/contract.ts`  | 08             |
| `mission.delivery.admit` | `service` operation; input `{ inboundEventId; projectId; platform; resource; event; metadata }`; answer `{ disposition: "accepted_observation" \| "refused" \| "duplicate"; reason: "ambiguous" \| "unmatched" \| "undecodable" \| null }`                                           | `src/mission/contract.ts`  | 09             |
| Service actor provenance | the service actor gains an optional `inbound_event_id`                                                                                                                                                                                                                               | `src/mission/contract.ts`  | 09, 10         |

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
  - The GitHub implementation decodes a GitHub webhook payload into GitHub event types; a payload decoder is pure and performs no API operation. `repository.impl.md:36`; `repository.md:51–52`.
  - Admission invokes the decoding of the platform implementation, which answers the address of the external object; admission interprets no platform payload. `mission-service.md:836–837`.
  - A `pull_request` address adds `number`; a `branch_push` address adds `branch` and `commit`. `mission-service.impl.md:246`. The inbound resource maps to the resource identity under decision D14.
  - The Repository module imports no service type (`engine/eslint.config.js:55–57`), so its result type is structural.
- Done when: `node --test --test-timeout=30000 src/repository/github.test.ts` passes; `pnpm run verify` passes.

### 08.2 Add `inbound_event_id` to the service provenance

- Files: `src/mission/contract.ts`, `src/mission/node-check.ts`, `src/mission/node-check.test.ts` (edit)
- Do:
  1. Extend the service actor of the provenance schema with an optional `inbound_event_id: identitySchema("inbound_event")`.
  2. Give `applyEndState` an optional sixth argument `{ inboundEventId }`, after `now`, which adds `inbound_event_id` to the provenance of each landed-commit evidence; `mission.node.check` passes none.
  3. Add tests: the human check writes the provenance `{ kind: "service", service: "mission" }` with no `inbound_event_id`; a call with the argument writes it; the evidence read answers it.
- Rules:
  - Delivery admission adds `inbound_event_id` to the provenance of a landed-commit evidence; a human check writes the provenance without it. `mission-service.impl.md:250`; `docs/reference/erd/03-integration.md:158`.
  - Every property name inside a JSON column of ERD 3 is snake_case. `docs/reference/erd/03-integration.md:126`; decision D22.
- Done when: `node --test --test-timeout=30000 src/mission/node-check.test.ts` passes; `pnpm run verify` passes.

### 08.3 Declare `mission.delivery.admit` and add the request match

- Files: `src/mission/contract.ts`, `src/mission/delivery-match.ts` (create), `src/mission/delivery-match.test.ts` (create), `src/mission/service.ts`, every Mission fixture that builds `Dependencies`, `src/apps/server/index.ts` (edit)
- Do:
  1. Declare `delivery.admit` through the `service` policy of task 01.2: `access: Service`, `mutation: true`, `lifetime: Unary`, the default timeout, body `z.strictObject({ inboundEventId: identitySchema("inbound_event"), projectId: identitySchema("project"), platform: z.string().min(1), resource: z.string().min(1), event: canonicalBase64Schema, metadata: z.record(z.string(), z.unknown()) })`, output the answer of "Provides". Its `POST /api/mission/delivery/admit` is the identity of the declaration and no route.
  2. Declare the closed sets `Disposition` (`accepted_observation`, `refused`, `duplicate`) and `AdmissionRefusal` (`ambiguous`, `unmatched`, `undecodable`) as `as const` objects with their schemas.
  3. Declare inline `EventDecoder`, add `decoder: EventDecoder` to the Mission `Dependencies` and to every Mission fixture of `Dependencies`, and wire `decode: ({ platform, resource, event, metadata }) => platform === "github" ? decodeGitHubEvent({ resource, event, metadata }) : null` in `composeServices`.
  4. Implement `matchRequests(tx, projectId, address)`: read every request evidence of a node of the mission of `projectId` together with its `platform` asset, compare the asset content with `canonicalJSON(address)`, and answer `{ unresolved, resolved }`: `unresolved` holds the matches whose attempt is open and whose `end_state` is null, `resolved` holds the matches with an `end_state` in any attempt. Answer `refused` with `ambiguous` for two or more unresolved matches, the one unresolved match, `duplicate` for none and one resolved match at least, and `refused` with `unmatched` for none.
  5. Add tests: a request of an open attempt matches; a request of a closed attempt with no end state does not; two open attempts of two nodes with one address refuse as `ambiguous`; a resolved request answers `duplicate`; a request of another project never matches; a reordered JSON member still matches; the HTTP adapter answers 404 for the path and the OpenAPI holds no operation identity `mission.delivery.admit`.
- Rules:
  - `mission.delivery.admit` is the `service` operation of delivery admission, which the Intake Service calls under its service identity; the input and the answer. `mission-service.impl.md:252–254`; `architecture.impl.md:665–670`; `engine/docs/cli/mission.md:888`.
  - Admission decodes the event first, and no address answers `undecodable`; a read transaction matches the canonical JSON of the address against the `platform` asset of each request evidence of the project; more than one unresolved match answers `ambiguous`; no unresolved match answers `duplicate` when a resolved request matches, and `unmatched` otherwise. `mission-service.impl.md:255`; `mission-service.md:838–841`; `docs/reference/erd/03-integration.md:155–156`.
  - The closed set of dispositions; acceptance as a human act stays out of scope. `mission-service.impl.md:252`, `:254`; `mission-service.vocabulary.md:667`; decision D16.
- Done when: `node --test --test-timeout=30000 src/mission/delivery-match.test.ts` passes; `pnpm run verify` passes.

### 08.4 Implement the admission handler

- Files: `src/mission/delivery-admit.ts` (create), `src/apps/server/delivery-admit.test.ts` (create), `src/mission/service.ts` (edit)
- Do:
  1. Stage one, before any transaction: refuse a caller that is not the minted Intake service identity with 403 `mission.authorization.refused` and `details: { reason: "service_mismatch" }`; decode the event, and a null address goes to stage four with `undecodable`.
  2. Stage two, one read `store.transaction` that ends before any await: run `matchRequests`; a refusal or a duplicate goes to stage four with no write. Read no live claim in this stage.
  3. Stage three: call `intakeCheck.check(caller.context, evidenceId)` for the one unresolved match. A failure propagates unchanged and writes nothing.
  4. Stage four, one `caller.commit` with no await inside. An `undecodable`, a refused or a `duplicate` decision of stages one and two returns its answer with no write. A `none` result answers `accepted_observation` with a null `reason` and writes nothing. For an `expected` or `other` result, read the checked request evidence first: an end state on it answers `duplicate`. Otherwise run `matchRequests` again with the same priority and the same refusal and duplicate answers: two or more unresolved matches answer `refused` with `ambiguous`; no unresolved match answers `duplicate` when a resolved request matches and `refused` with `unmatched` otherwise; another evidence that became the one unresolved match answers the failure 409 `mission.delivery.match_changed` with no write. For the same evidence, read the live claim of its node through `schedulerClaims.liveExecutionOf`: a live claim answers the failure 409 `mission.node.claim_live` with `details: { nodeId, executionId }` and no write. Otherwise run `applyEndState(tx, dependencies, evidenceId, answer, now, { inboundEventId })`, which writes the end state, the landed-commit evidence of an `expected` result of a repository action, the node transition and the attempt closure, and answer `accepted_observation`.
  5. After the commit, call `wakeup.wake(projectId)`.
  6. Run one admission at a time through a module-private promise chain of the Mission Service (`ADMISSION_CONCURRENCY`).
  7. Add tests in `src/apps/server/delivery-admit.test.ts`, which mints the identities: a merged pull request sets `expected`, writes one landed-commit evidence with `inbound_event_id` and moves `External.Requested` to `Completed` under a current passing assessment; a closed pull request sets `other` and moves the node to `Blocked`; an `expected` result whose attempt holds a further required action leaves the attempt open for the continuation claim; an open pull request writes nothing and answers `accepted_observation` with a null `reason`; a repeat answers `duplicate` and writes nothing; a failed check writes nothing and propagates its code; under a live claim on the node, a `none` result answers `accepted_observation` and writes nothing, and a conclusive result answers 409 `mission.node.claim_live` with `details: { nodeId, executionId }` and writes nothing; a live claim on the node does not stop the Intake check, which runs once; a delete of the checked request evidence during the check answers `refused` with `unmatched`, or 409 `mission.delivery.match_changed` when another evidence is the one unresolved match; an attempt that closes during the check, a second matching request that appears during the check and a human check that resolves the request during the check each write no second end state; another service identity refuses with `service_mismatch`.
- Rules:
  - The handler calls the Intake check before its commit, because a transaction awaits nothing; a failed check propagates as an operation failure and writes nothing. `mission-service.impl.md:256`; `mission-service.md:845–850`; `docs/reference/erd/03-integration.md:157`.
  - Every disposition returns through the one final `caller.commit`; a refusal, a duplicate and a `none` result commit no write. `mission-service.impl.md:257`; `docs/reference/erd/03-integration.md:159`.
  - At the commit of an `expected` or `other` result, the commit reads the checked request evidence, repeats the match, and answers 409 `mission.delivery.match_changed` for another unresolved match and 409 `mission.node.claim_live` for a live claim on the node. `mission-service.impl.md:258`; `mission-service.md:851`; `engine/docs/cli/mission.md:987`, `:1026`.
  - The Mission Service sets the end state of a request after the execution releases. `mission-service.md:294`.
  - The same transaction writes the end state, the landed-commit evidence, the node transition and the attempt closure. `mission-service.impl.md:259`; `docs/reference/erd/03-integration.md:154`; `mission-service.md:605–612`.
  - Admission needs no claim and operates when a project has no live worker instance. `mission-service.md:802`, `:828`.
  - A handler completes its asynchronous work before its one final `caller.commit`. `architecture.impl.md:699–704`.
  - The owning service authorizes the calling service by name; another service identity answers `service_mismatch`. `architecture.impl.md:671`; `mission-service.impl.md:574`.
  - Gap: the bound of admission processing has no value on a page (`mission-service.md:832`; `docs/brainstorm/HANDOFF.md:46`); decision D12. The span of the disposition is ERD 4 work (decision D15).
- Done when: `node --test --test-timeout=30000 src/apps/server/delivery-admit.test.ts` passes; `pnpm run verify` passes.

### 08.E E2E proof

- Files: `src/apps/server/e2e-delivery-admission.test.ts` (create)
- Do:
  1. Start `fakeGitHub(t)`, the bare repository `gated` and `gatewayFixture` with the fixture platforms of plan 03.
  2. Build objective P of plan 03 "E2E" (E03.1 to E03.4) to `External.Requested` with the pull request 1.
  3. Call `mission.delivery.admit` through `directClient(missionOperations, fixture.invocation)` with `mintServiceIdentity("intake")` and a fresh idempotency key, because the operation has no route (decision D7). Run E08.1 to E08.7 in one test in table order.
- Rules:
  - A `service` operation has no CLI command and no route; the state check is a CLI read. ERD 1 decision D13; `engine/docs/cli/mission.md:888`.
  - The event bytes are the GitHub payloads of the table, encoded in canonical base64.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-delivery-admission.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-delivery-admission.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`, `fakeGitHub`, `kanthord(args, env)`, `directClient`. `A(e, i)` names `admit({ inboundEventId: i, projectId, platform: "github", resource: "owner/gated", event: base64(e), metadata: { event: <type of e> } })` under `mintServiceIdentity("intake")`, where `i` is a fresh `inbound_event_<ulid>` that the test keeps.
- `issue` names the webhook payload `{ "action": "opened", "issue": { "number": 3 }, "repository": { "full_name": "owner/gated" } }` of the event type `issues`; a GitHub `ping` is a handshake and never reaches admission (`intake-service.impl.md:58`). `closed(n, merged)` names the webhook payload `{ "action": "closed", "number": n, "pull_request": { "merged": merged }, "repository": { "full_name": "owner/gated" } }`. `m` names the 40-character commit `eeee…e`.
- E08.3 sets `fakeGitHub.failPulls(502)`; a read answers `retryable_refusal` for a 5xx with no retry (decision D11), so one failed read ends the check.

| Id    | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit       | Expect                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E08.1 | `A(issue, i1)` with `metadata.event` `issues`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —          | `{ disposition: "refused", reason: "undecodable" }`                                                                                                              |
| E08.2 | `A(closed(9, true), i2)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —          | `refused`, `unmatched`                                                                                                                                           |
| E08.3 | `gitHub.failPulls(502)`; `A(closed(1, true), i3)`; `gitHub.failPulls(null)`; `kanthord mission node get <P>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —, —, —, 0 | a failure whose code is `repository.platform.github.retryable_refusal`; `state` `External.Requested`                                                             |
| E08.4 | `gitHub.merge(1, m)`; `A(closed(1, true), i4)`; `kanthord mission node get <P>`; `kanthord mission evidence list <P> --attempt 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —, —, 0, 0 | `{ disposition: "accepted_observation", reason: null }`; `state` `Completed`; one landed-commit evidence of `m` whose provenance holds `inbound_event_id` = `i4` |
| E08.5 | `A(closed(1, true), i5)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —          | `{ disposition: "duplicate", reason: null }`                                                                                                                     |
| E08.6 | For two more objectives R and U on the binding `gated`, created after P completes: the flow of plan 03 E03.1 with commits `r` and `u`; `mission.evidence.request` of each through `httpClient(missionOperations, …)` under its evaluation claim with the body `{ ctx(e, x), "requirementKey": "gated.pull_request", "subject": "gated.pull_request", "address": { "kind": "pull_request", "resourceIdentity": "repository:github:owner/gated", "number": 7 } }`; `kanthord scheduler execution release` of each [T] with `release(false)`; `A(closed(7, true), i6)`; `kanthord mission external-action list <R> --attempt 1` | —, 0, —, 0 | both requests complete; the admission answers `refused`, `ambiguous`; `items[0].resolution` `unresolved`                                                         |
| E08.7 | `A(closed(7, true), i7)` under `mintServiceIdentity("mission")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —          | a failure with status 403, `mission.authorization.refused`, `details.reason` `service_mismatch`                                                                  |
