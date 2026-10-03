# Plan 10: Health, Gateway, CLI and the journeys

## Scope

This plan closes the ERD 3 plan set. It delivers:

- The inbound resource healthcheck: one project-scoped entry per inbound in the inventory of the Intake Service, with its check for a registered webhook, a poll and a passive webhook.
- The project name of an inbound entry, which the composition root resolves through the Project read `projectNameOf` (blocker B2).
- The final `unwired` set: no ERD 3 seam remains (decision D6).
- The combined assertion of the nineteen tables of ERD 1, ERD 2 and ERD 3, their fifteen unique indexes and their foreign keys.
- The final OpenAPI inventory with the Intake operations, and the absence of every `service` operation from it.
- The CLI completeness over `engine/docs/cli/intake.md`.
- The integration journey: a configured pull request through a registered webhook and a configured merge through a poll, from the claim to `Completed`, with the outbound requests, the inbound events and the health report.

Out of scope:

- A stored check result and a background healthcheck (root `AGENTS.md` "Rejected proposals").
- Every item of decision D5.

## Sources

- `docs/reference/erd/01-setup.md:155–167`, `docs/reference/erd/02-execution.md:166–176`, `docs/reference/erd/03-integration.md:107–113` — the tables and their owners.
- `docs/reference/erd/03-integration.md:34`, `:86–92`, `:126`, `:134`, `:144`, `:166–172` — no stored check result; the references; the indexes.
- `docs/brainstorm/intake-service.md:83–92` — the resource healthcheck of an inbound.
- `docs/brainstorm/intake-service.md:32` — the Intake Service reaches a peer through an operation only (blocker B2).
- `docs/brainstorm/intake-service.impl.md:205–212`, `:236` — the values of the check and its test.
- `docs/brainstorm/gateway-service.impl.md:347–391` — the report: owners, names, targets, the inventory transaction, the bounds.
- `docs/brainstorm/architecture.md` "Resource healthcheck" — one check per target in one request.
- `docs/brainstorm/architecture.impl.md:536–545`, `:812`, `:819–820`, `:833` — the closed top-level names; the command tables; the `service` operation excluded from the conformance test and from OpenAPI; the route set equals OpenAPI.
- `engine/docs/cli/intake.md:41–69`, `:387–419` — the command table and the routes without a command.
- `engine/.agents/plan/erd-02-execution/10-gateway-cli-e2e.md` tasks 10.1, 10.2, 10.5, 10.6 — the assertions that this plan extends.
- `engine/src/gateway/health-report.ts:50–108` — the collection and the deduplication by target.
- `engine/src/kernel/health.ts:117–140` — `ResourceEntry`, `HealthScope`, `ResourceStatus`.
- Decisions D5, D6, D15, D17, D20 of `decisions.md`.

## Depends on

- ERD 1 and ERD 2, committed, with ERD 2 plan 10 (`OPERATION_INVENTORY`, `PAGE_INVENTORIES`, `generateMachineToken`).
- Plans 01 to 09, committed. This plan consumes only the seams of their "Provides" tables:
  - Plan 01: `resourceInventory`, the `intake` owner, `intakeMigrations`.
  - Plan 03: the action operations, `fakeGitHub`, the repository fixtures.
  - Plan 04: the storage operations, `fakeS3`.
  - Plans 05 to 07: the inbound store, the inbound grant, `getHook`, `listEvents`, the receipt, the poll loops.
  - Plans 08 and 09: admission and the handoff.

## Provides

| Seam                           | TypeScript signature                                                                                                                                                                                                                                                              | Owner file                                                                  | Consumer plans   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------- |
| `ProjectService.projectNameOf` | `(tx, projectId): string \| null` — a Project read that the composition root calls in the collection transaction (blocker B2)                                                                                                                                                     | `src/project/service.ts`                                                    | composition root |
| Inbound entries                | `IntakeService.resourceInventory(tx): IntakeInventoryEntry[]` answers one entry per inbound with its `projectId`, name, target `inbound:<inbound id>`, capability and check; the composition root maps each `projectId` to the project name into a project-scoped `ResourceEntry` | `src/intake/service.ts`, `src/intake/health.ts`, `src/apps/server/index.ts` | Gateway          |

## Tasks

### 10.1 Resolve the project names of the Intake entries in the composition root

- Files: `src/project/service.ts`, `src/project/service.test.ts`, `src/intake/contract.ts`, `src/intake/service.ts`, `src/apps/server/index.ts`, `src/apps/server/index.test.ts` (all edit)
- Do:
  1. Implement `projectNameOf(tx, projectId)` in the Project Service: one read of `project_project` by identity, answering its `name` or null; it opens no transaction.
  2. Declare `IntakeInventoryEntry = Omit<ResourceEntry, "project" | "scope"> & { projectId: string }` in `src/intake/contract.ts`, and let `resourceInventory(tx)` answer that type; the Intake Service reads no Project table and calls no Project collaboration.
  3. In `composeServices`, wrap the Intake inventory: for each entry, read `project.projectNameOf(tx, entry.projectId)` in the collection transaction, throw for a null name, and answer `{ ...entry, scope: HealthScope.Project, project: name }`. A throw reaches `collectInventories`, which reports `intake` in `missingInventories`.
  4. Add tests: the name after a rename; null for an unknown identity; the read opens no transaction; a null name makes `collectInventories` report `intake` missing.
- Rules:
  - The report keys a project-scoped entry by the project name and reads the inventories in one transaction; the composition root hands the Gateway `collectInventories()`. `gateway-service.impl.md:358`, `:376`.
  - The composition root is the only file that wires cross-service types. ERD 2 `00-index.md` "Collaboration-type contract rule".
  - The Intake Service reaches a peer through an operation only and shares no atomic invariant with another service. `intake-service.md:32–34`.
  - Blocker B2: no page names the source of the name. The task waits for its ruling; the recommendation is this composition-root resolution.
- Done when: `node --test --test-timeout=30000 src/project/service.test.ts src/apps/server/index.test.ts` passes; `pnpm run verify` passes.

### 10.2 Add the inbound entries and their checks

- Files: `src/intake/health.ts` (create), `src/intake/health.test.ts` (create), `src/intake/service.ts` (edit)
- Do:
  1. In `resourceInventory(tx)`, read every inbound and answer `{ projectId, name: encodeURIComponent(id), target: "inbound:" + id, capability, check }`.
  2. A registered webhook takes the capability `registered webhook` and a check that authorizes and releases a `webhook-read` grant in its own `store.transaction`, calls `getHook` under the check `Context`, and answers `unhealthy` for a missing hook, `active: false` or a `last_response.code` outside 2xx, `unknown` for a hook with no delivery, `healthy` otherwise.
  3. A poll takes the capability `poll acquisition` and a check that releases a `poll` grant and calls `listEvents` with the ETag of `checkpoint`; a 200 or a 304 answers `healthy`, a result class `unhealthy`. It stores no event and writes no `checkpoint`.
  4. A passive webhook takes the capability `passive webhook` and a check that answers `unknown` with no call.
  5. A refused release or a platform result class answers `unhealthy` with no further platform call; a cancellation or the deadline of the check `Context` propagates, so the report applies its own `unknown` rule. Drop every material in `finally`; a 401 or 403 reaches `reportRefusal`.
  6. Add tests: each status of each kind; a fake facility whose release refuses answers `unhealthy` with no platform call and no material in the log; the check deadline answers `unknown` through the report; a caller cancellation answers no success; a check changes no inbound and no checkpoint; no request runs outside a health report.
- Rules:
  - The check runs only inside a health report that a human calls; it changes no inbound and stores no result. `intake-service.md:85`, `:91`; `intake-service.impl.md:208`, `:212`.
  - The values and capabilities of the three kinds. `intake-service.impl.md:209–211`; `intake-service.md:86–90`.
  - The report supplies the deadline, the concurrency bound and the cancellation; a check that exceeds its deadline reports `unknown`; a caller cancellation produces no success answer. `intake-service.impl.md:207`; `gateway-service.impl.md:379–388`.
  - An Intake resource name is its inbound identity, and each segment uses percent encoding. `gateway-service.impl.md:365`, `:368`.
  - Each remote call of an inbound takes one single-use grant. `intake-service.impl.md:19`.
  - A credential removal is refused while an inbound names it (`docs/reference/erd/03-integration.md:128`), and custody refuses a revoke of the newest live revision (`custody.md:35`), so the refused release comes from a fake facility.
  - Gap: no page names the target of an inbound check; the plan takes the inbound identity, as ERD 2 plan 10 task 10.4 took the runtime identity.
- Done when: `node --test --test-timeout=30000 src/intake/health.test.ts` passes; `pnpm run verify` passes.

### 10.3 Assert the final `unwired` set

- Files: `src/apps/server/unwired-import.test.ts` (edit); `src/apps/server/index.ts`, `src/apps/server/test-support.ts` (edit only under step 2)
- Do:
  1. Assert `UNWIRED_SEAMS` = `[]` and that `src/apps/server/index.ts` holds no `unwired(` literal and no import of `unwired.ts`.
  2. Search `composeServices` and `gatewayFixture` for a `standIns` option; when it remains, delete it with its last member.
  3. Keep `unwired.ts`, `unwired.test.ts` and the assertion that only `unwired.test.ts` imports the module.
- Rules:
  - The ERD 3 plan set deletes the stand-in and the `unwired` entry of each seam. ERD 2 decision D6; decision D6.
  - The composition root owns each temporary stand-in for a seam that a later plan implements. `architecture.impl.md:959`.
- Done when: `node --test --test-timeout=30000 src/apps/server/unwired-import.test.ts` passes; `pnpm run verify` passes.

### 10.4 Assert the tables, the indexes and the references of ERD 1 to ERD 3

- Files: `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Rename the combined test to "all ERD 1, ERD 2 and ERD 3 migrations produce exactly the nineteen tables", add `intakeMigrations` to `allServices`, and add `intake_inbound`, `intake_inbound_event` and `intake_outbound_request` to `ALL_TABLES`.
  2. Add `intake_inbound_event_inbound_event` and `intake_outbound_request_operation_key` to `ALL_INDEXES`.
  3. Assert that the ERD 3 references are exactly `intake_inbound_event.inbound_id` to `intake_inbound.id`, and that `intake_inbound` and `intake_outbound_request` hold none.
- Rules:
  - The tables are the tables of the three ERD pages. `docs/reference/erd/03-integration.md:107–113`.
  - The two unique indexes are the only ERD 3 indexes. `docs/reference/erd/03-integration.md:126`, `:134`, `:144`; decision D20.
  - The one foreign key of ERD 3 and the references with no FK. `docs/reference/erd/03-integration.md:86–92`, `:166–172`.
  - No SQL `CHECK`; every index is unique. Root `AGENTS.md` "Database design".
- Done when: `node --test --test-timeout=30000 src/apps/server/migrations.test.ts` passes; `pnpm run verify` passes.

### 10.5 Assert the final OpenAPI inventory

- Files: `src/apps/server/openapi-integration.test.ts` (edit)
- Do:
  1. Add the rows of the Intake Service to `OPERATION_INVENTORY`:
     - `human`, prefix `intake.`: `inbound.create`, `inbound.list`, `inbound.get`, `inbound.delete`, `inbound.event.list`, `inbound.event.get`, `inbound.event.retry`, `inbound.event.discard`, `inbound.event.delete`, `outbound.request.list`, `outbound.request.get`, `outbound.request.discard`, `outbound.request.delete`, `storage.get`, `storage.delete`.
     - `client`, prefix `intake.`: `action.perform`, `action.read`, `storage.put`, `storage.check`, `execution.storage.get`.
     - `delivery`, prefix `intake.`: `inbound.event.receive`.
  2. Assert 127 rows: 106 of ERD 1 and ERD 2 and 21 of ERD 3.
  3. Assert that the sorted ids of `registry.all()` equal the inventory plus the two `service` operations `intake.action.check` and `mission.delivery.admit` (129); that the emitted OpenAPI holds no `operationId` of either; and that the emitted method and path pairs equal those of the 127 rows.
- Rules:
  - The route set of the registry equals the path set of the committed OpenAPI. `architecture.impl.md:833`.
  - A `service` operation has no route and no OpenAPI entry. `architecture.impl.md:666`.
  - The access policy of each row is the access column of its page: every command of `engine/docs/cli/intake.md` is `human`; the receipt is `delivery`; the caller kinds of the API operations follow `intake-service.impl.md:120–127`.
  - The routes and the receipt identity wait for the ruling of B5, and the policies of the API operations for B6.
- Done when: `node --test --test-timeout=30000 src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 10.6 Assert the CLI completeness of the Intake group

- Files: `src/apps/cli/completeness.test.ts` (edit)
- Do:
  1. Add `intake.md` "## Command table" to `PAGE_INVENTORIES`; remove `intake` from `LATER_GROUPS`.
  2. Add to `API_ONLY_OPERATIONS`: `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete`, `intake.inbound.event.receive`.
  3. Assert: the documented paths number 123 (ERD 2 count 110 and 13 Intake rows); the program leaves number 118; the program holds the `intake` group with the leaves `inbound create`, `inbound list`, `inbound get`, `inbound delete`, `event list`, `event get`, `event retry`, `event discard`, `event delete`, `outbound list`, `outbound get`, `outbound discard`, `outbound delete`; the ids of the rows that are not exempt, joined with `API_ONLY_OPERATIONS`, equal the 127 ids of the non-service operations of the contracts.
  4. Extend the operation-id pattern of the test with `intake`.
- Rules:
  - A command table holds one row for each command of the group. `architecture.impl.md:544–545`.
  - The top-level names include `intake`. `architecture.impl.md:538`.
  - The API operations have no CLI leaf. `engine/docs/cli/intake.md:387–419`. Blocker B5: the page lists two of the eight; the task waits for the ruling of B5.
- Done when: `node --test --test-timeout=30000 src/apps/cli/completeness.test.ts` passes; `pnpm run verify` passes.

### 10.E Prove the integration journey

- Files: `src/apps/server/e2e-integration-journey.test.ts` (create)
- Do:
  1. Start `fakeGitHub(t)`, `fakeS3(t)`, the bare repositories `gated` and `merge`, and `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }`, `github`, `repositoryTransport`, `intake: { pollIntervalMs: 50 }`, the configuration `intake.ingressUrl` = `"https://hooks.example.test"` and `inventoryOverrides: { custody: () => [] }`.
  2. Build fixture J of `## E2E` through the CLI and run EJ10.1 to EJ10.9 in one test in table order, with the test option `{ timeout: 120000 }`. Assert the `nodeId` and the node state of every claim. Poll a CLI read every 50 ms for at most 10 s where a row waits for the dispatcher or the poll.
  3. Read the health report with `fixture.request(gatewayOperations.healthcheck.path, …)` and the human token. Call `worker.action.request` and the object operations through `httpClient` from the test process.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read, except the receipt, the health report and the API operations without a CLI command. ERD 1 decision D13.
  - The scripted client of an external harness drives both claim kinds. `worker-service.md:42`; ERD 2 plan 10 task 10.8.
  - The fixture connector answers the Project repository checks, and no real platform call runs. Decision D17; ERD 2 plan 10 task 10.8.
  - The journey waits for every ruling that its rows meet: B1, B3, B5, B6, B8, B9 and B11.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-integration-journey.test.ts` passes every row; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-integration-journey.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` with the fixture platforms of decision D17; `kanthord(args, env)`; `generateMachineToken`; `deliver`. `H` names the human token; `[T]` the machine token of the binding `harness` of `claude@1`.
- Rules: no output holds a token, a client secret, the credential key `test-secret`, a webhook secret outside `inbound get`, or a presigned URL outside its answer.
- The files `pull.json`, `work`, `run`, `pass`, `release`, `check.json` and `ctx` are those of plan 03 "E2E"; `submit(x)` and `complete` are those of plan 04 "E2E". `closed(n)` names the payload of plan 09 "E2E" for `owner/gated`; `m` names the commit `eeee…e`.
- `objective(n, b, c, object)` names the recipe, each step with exit 0 or status 200: `kanthord scheduler work pull --file pull.json` [T] → `x`, `e` with `x.nodeId` = n; when `object`, `mission.evidence.submit` of n with `submit(x)` [T], the PUT of `hello` to its `putUrl`, and `mission.evidence.asset.complete` [T] → `o`; `kanthord mission evidence submit <n> --file work(n, b, c)` [T] → `w`; `kanthord scheduler execution release <e> --file release(false)` [T]; `kanthord scheduler work pull --file pull.json` [T] → `x'`, `e'` with `x'.nodeId` = n and the node `Evaluating`; `kanthord mission evidence submit <n> --file run(b, c)` [T] → `r`; `kanthord mission assessment submit <n> --file pass(b, c, [r, w])` [T]; `POST /api/worker/execution/<e'>/action/request` with T; `kanthord scheduler execution release <e'> --file release(false)` [T].

- The initiative files of EJ10.6, with `ctx` of the claim of I and `g` = `remoteHead(gatedBare, "refs/heads/main")`, `c` of EJ10.4, and `oP`, `oQ` = the outcome identities of `kanthord mission outcome list <P>` and `<Q>`:
  - `report.json`: `{ ctx, "subject": "report", "assets": [{ "kind": "produced", "content": { "mediaType": "text/markdown", "encoding": "base64", "data": <base64 of "P and Q are complete."> } }] }`.
  - `initiative-run.json`: `{ ctx, "subject": "verification run", "assets": [{ "kind": "produced", "content": { "mediaType": "text/plain", "encoding": "base64", "data": "b2s=" } }], "verification": { "testedInput": [{ "kind": "repository", "bindingId": gatedBindingId, "commit": g }, { "kind": "repository", "bindingId": mergeBindingId, "commit": c }], "results": [{ "command": "true", "exitCode": 0, "signal": null, "timedOut": false }] } }`.
  - `initiative-pass.json`: `{ ctx, "evidenceIds": [ir, rep], "childOutcomeIds": [oP, oQ], "result": "success", "rationale": "P and Q are complete.", "testedInput": <the testedInput of initiative-run.json> }`.

Fixture J, in order (each command exits 0, token H unless marked):

1. The credentials `github` of plan 03 and `store` of plan 04 with the endpoint of `fakeS3`; `kanthord project create --name journey` → `projectId`.
2. `kanthord project binding apply` with the bindings `gated` and `merge` of plan 03 "E2E" step 3, the storage binding `store` of plan 04 "E2E" step 2 and the worker binding `harness` of `claude@1`.
3. `kanthord mission node create` of an initiative `I` and an objective `P` with `"bindings": ["gated", "store"]` under `I`; push a commit `p` to `refs/heads/kanthord/<P>` of the gated bare repository.
4. `kanthord intake inbound create --file` of a registered webhook `W` of `owner/gated` (`hook.json` of plan 06 with `"resource": "owner/gated"`) → `S` = the `secret` of `inbound get`; of a poll `L` of `owner/merge` (`poll.json` of plan 07 with `"resource": "owner/merge"`); of a passive webhook `V` of `owner/gated` (`passive.json` of plan 05 with `"resource": "owner/gated"`).
5. `generateMachineToken` → `T`; `kanthord worker register` [T] → `rid`.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Exit                                | Expect                                                                                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EJ10.1 | `GET /api/healthcheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 200                                 | `services.intake.projects.journey` holds `W` `{ "status": "unknown", "capability": "registered webhook" }`, `L` `{ "status": "healthy", "capability": "poll acquisition" }`, `V` `{ "status": "unknown", "capability": "passive webhook" }`; `services.project.projects.journey.gated.status` `healthy` through the fixture connector |
| EJ10.2 | `objective(P, gatedBindingId, p, true)`; `kanthord mission node get <P>`; `kanthord intake outbound list --operation github.pull_request`                                                                                                                                                                                                                                                                                                                                                                       | the CLI steps 0, the HTTP steps 200 | `state` `External.Requested`; one `succeeded` request                                                                                                                                                                                                                                                                                 |
| EJ10.3 | `gitHub.merge(1, m)`; `gitHub.lastResponse(<hook of W>, 200)`; `deliver(W, S, "pull_request", "d-1", closed(1))`; wait; the event of `d-1` → `E1`; `kanthord mission node get <P>`; `kanthord mission evidence list <P> --attempt 1`                                                                                                                                                                                                                                                                            | 202, 0, 0, 0                        | `E1` `succeeded`; `state` `Completed`; the landed-commit evidence of P holds `inbound_event_id` = `E1`                                                                                                                                                                                                                                |
| EJ10.4 | `kanthord mission node create` of an objective `Q` with `"bindings": ["merge"]` under `I`; push `q` to `refs/heads/kanthord/<Q>` of the merge bare repository; `objective(Q, mergeBindingId, q, false)`; `kanthord intake outbound list --operation git.merge_push`                                                                                                                                                                                                                                             | the CLI steps 0, the HTTP steps 200 | the request `succeeded` with the stored result `{ "kind": "branch_push", "branch": "main", "commit": c, "resource_identity": "repository:github:owner/merge" }` → `c`                                                                                                                                                                 |
| EJ10.5 | `gitHub.events("owner", "merge", [{ "id": "500", "type": "PushEvent", "repo": { "name": "owner/merge" }, "payload": { "ref": "refs/heads/main", "head": c } }])`; wait; `kanthord intake event list --inbound <L>`; `kanthord mission node get <Q>`                                                                                                                                                                                                                                                             | —, 0, 0                             | one `succeeded` event; `state` `Completed`                                                                                                                                                                                                                                                                                            |
| EJ10.6 | `kanthord scheduler work pull --file pull.json` [T] → `x`, `e` with `x.nodeId` = I; `kanthord mission evidence submit <I> --file report.json` [T] → `rep`; `kanthord scheduler execution release <e> --file release(false)` [T]; `kanthord scheduler work pull --file pull.json` [T] → `x'`, `e'` with `x'.nodeId` = I; `kanthord mission evidence submit <I> --file initiative-run.json` [T] → `ir`; `kanthord mission assessment submit <I> --file initiative-pass.json` [T]; `kanthord mission node get <I>` | 0 each                              | the assessment answers `node.state` `Completed` and `outcome.result` `success`; `state` `Completed`                                                                                                                                                                                                                                   |
| EJ10.7 | `GET /api/healthcheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 200                                 | `W` `healthy`, `L` `healthy`, `V` `unknown`                                                                                                                                                                                                                                                                                           |
| EJ10.8 | `kanthord mission get <projectId>` → M; `kanthord mission evidence delete <the evidence of o> --force --reason "journey" --expected-mission-version <M>`; `kanthord intake outbound list --operation s3.delete_object`                                                                                                                                                                                                                                                                                          | 0, 0, 0                             | one `succeeded` request whose `requestKey` is the asset identity of `o`; `fakeS3` holds no version of that asset                                                                                                                                                                                                                      |
| EJ10.9 | `kanthord intake inbound delete <W>`; `kanthord intake inbound delete <L>`; `kanthord intake inbound delete <V>`; `GET /api/healthcheck`                                                                                                                                                                                                                                                                                                                                                                        | 0, 0, 0, 200                        | `gitHub.hooks` holds no hook; `services.intake.projects` `{}`                                                                                                                                                                                                                                                                         |

No row asserts a `code: proposed` code.

## Blockers

- B2 of `00-index.md`: the project name of an inbound entry has no page source. Tasks 10.1 and 10.2 wait for its ruling.
- B5 and B6 of `00-index.md`: the routes, the receipt identity and the policies of the API operations. Tasks 10.5 and 10.6 wait for their rulings.
- The journey of task 10.E waits for every ruling that its rows meet.
