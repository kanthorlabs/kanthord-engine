# Plan 10: Health, Gateway, CLI and the journeys

## Scope

This plan closes the ERD 3 plan set. It delivers:

- The inbound resource healthcheck: one project-scoped entry per inbound in the inventory of the Intake Service, with its check for a poll and for a webhook inbound.
- The project name of an inbound entry, which the composition root resolves through the Project read `projectNameOf` (`gateway-service.impl.md:377`; `project-service.impl.md:240`).
- The final `unwired` set: no ERD 3 seam remains (decision D6).
- The combined assertion of the twenty tables of ERD 1, ERD 2 and ERD 3, their sixteen unique indexes and their foreign keys.
- The final OpenAPI inventory with the Intake operations, and the absence of every `service` operation and every `direct: true` operation from it.
- The CLI completeness over `engine/docs/cli/intake.md`.
- The integration journey: a configured pull request through a webhook inbound and a configured merge through a poll, from the claim to `Completed`, with the outbound requests, the inbound events and the health report.

Out of scope:

- A stored check result and a background healthcheck (root `AGENTS.md` "Rejected proposals").
- Every item of decision D5.

## Sources

- `docs/reference/erd/01-setup.md:155–167`, `docs/reference/erd/02-execution.md:166–176`, `docs/reference/erd/03-integration.md:106–112` — the tables and their owners.
- `docs/reference/erd/03-integration.md:34`, `:85–91`, `:125`, `:133`, `:143`, `:165–171` — no stored check result; the references; the indexes.
- `docs/brainstorm/intake-service.md:77–83` — the resource healthcheck of an inbound.
- `docs/brainstorm/intake-service.md:33` — the Intake Service reaches a peer through an operation only.
- `docs/brainstorm/gateway-service.impl.md:376–377`; `docs/brainstorm/project-service.impl.md:240`; `docs/brainstorm/intake-service.impl.md:212` — the composition root resolves the project name of an Intake entry through `projectNameOf`.
- `docs/brainstorm/intake-service.impl.md:208–215`, `:235` — the values of the check and its test.
- `docs/brainstorm/gateway-service.impl.md:347–392` — the report: owners, names, targets, the inventory transaction, the bounds.
- `docs/brainstorm/architecture.md` "Resource healthcheck" — one check per target in one request.
- `docs/brainstorm/architecture.impl.md:537–546`, `:667–669`, `:816`, `:823–824`, `:837` — the closed top-level names; the command tables; the `service` operation and the `direct: true` operation excluded from the routes and from OpenAPI; the route set equals OpenAPI.
- `engine/docs/cli/intake.md:41–69`, `:379–418` — the command table and the routes without a command.
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
  - Plans 05 to 07: the inbound store, the inbound grant, `listEvents`, the receipt, the poll loops.
  - Plans 08 and 09: admission and the handoff.

## Provides

| Seam                           | TypeScript signature                                                                                                                                                                                                                                                              | Owner file                                                                  | Consumer plans   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------- |
| `ProjectService.projectNameOf` | `(tx, projectId): string` — a Project read called only by the Intake inventory callback of the composition root in the collection transaction; it throws for an absent project and opens no transaction                                                                           | `src/project/service.ts`                                                    | composition root |
| Inbound entries                | `IntakeService.resourceInventory(tx): IntakeInventoryEntry[]` answers one entry per inbound with its `projectId`, name, target `inbound:<inbound id>`, capability and check; the composition root maps each `projectId` to the project name into a project-scoped `ResourceEntry` | `src/intake/service.ts`, `src/intake/health.ts`, `src/apps/server/index.ts` | Gateway          |

## Tasks

### 10.1 Resolve the project names of the Intake entries in the composition root

- Files: `src/project/service.ts`, `src/project/service.test.ts`, `src/intake/contract.ts`, `src/intake/service.ts`, `src/apps/server/index.ts`, `src/apps/server/index.test.ts` (all edit)
- Do:
  1. Implement `projectNameOf(tx, projectId)` in the Project Service: one read of `project_project` by identity, answering its `name`; an absent project throws; it opens no transaction.
  2. Declare `IntakeInventoryEntry = Omit<ResourceEntry, "project" | "scope"> & { projectId: string }` in `src/intake/contract.ts`, and let `resourceInventory(tx)` answer that type; the Intake Service reads no Project table and calls no Project collaboration.
  3. In `composeServices`, wrap the Intake inventory: for each entry, read `project.projectNameOf(tx, entry.projectId)` in the collection transaction and answer `{ ...entry, scope: HealthScope.Project, project: name }`. A throw of the read reaches `collectInventories`, which reports `intake` in `missingInventories`.
  4. Add tests: the name after a rename; a throw for an unknown identity; the read opens no transaction; through the collector, an Intake entry of an unknown project makes `collectInventories` report `intake` in `missingInventories`.
- Rules:
  - The report keys a project-scoped entry by the project name and reads the inventories in one transaction; the composition root hands the Gateway `collectInventories()`. `gateway-service.impl.md:358`, `:376`.
  - The composition root is the only file that wires cross-service types. ERD 2 `00-index.md` "Collaboration-type contract rule".
  - The Intake Service reaches a peer through an operation only and shares no atomic invariant with another service. `intake-service.md:33–35`.
  - The composition root supplies the Intake inventory callback, which resolves each `projectId` through `projectNameOf(tx, projectId)` of the Project Service; a failed resolution throws inside the callback, so the collection reports `intake` in `missingInventories`. `gateway-service.impl.md:376–377`; `project-service.impl.md:240`; `intake-service.impl.md:212`.
- Done when: `node --test --test-timeout=30000 src/project/service.test.ts src/apps/server/index.test.ts` passes; `pnpm run verify` passes.

### 10.2 Add the inbound entries and their checks

- Files: `src/intake/health.ts` (create), `src/intake/health.test.ts` (create), `src/intake/service.ts` (edit)
- Do:
  1. In `resourceInventory(tx)`, read every inbound and answer `{ projectId, name: encodeURIComponent(id), target: "inbound:" + id, capability, check }`.
  2. Removed: a webhook inbound reads no platform state; step 4 holds its check.
  3. A poll takes the capability `poll acquisition` and a check that releases a `poll` grant and calls `listEvents` with the ETag of `checkpoint`; a 200 or a 304 answers `healthy`, a result class `unhealthy`. It stores no event and writes no `checkpoint`.
  4. A webhook inbound takes the capability `webhook` and a check that answers `unknown` with no call.
  5. A refused release or a platform result class answers `unhealthy` with no further platform call; a cancellation or the deadline of the check `Context` propagates, so the report applies its own `unknown` rule. Drop every material in `finally`; a 401 or 403 is a refusal that belongs in the span of the check (decision D9).
  6. Add tests: each status of each kind; a fake facility whose release refuses answers `unhealthy` with no platform call and no material in the log; the check deadline answers `unknown` through the report; a caller cancellation answers no success; a check changes no inbound and no checkpoint; no request runs outside a health report.
- Rules:
  - The check runs only inside a health report that a human calls; it changes no inbound and stores no result. `intake-service.md:79`, `:82`; `intake-service.impl.md:211`, `:215`.
  - The values and capabilities of the two kinds: a poll reports `healthy` or `unhealthy` with `poll acquisition`, and a webhook inbound reports `unknown` with `webhook`. `intake-service.impl.md:213–214`; `intake-service.md:80–81`.
  - The report supplies the deadline, the concurrency bound and the cancellation; a check that exceeds its deadline reports `unknown`; a caller cancellation produces no success answer. `intake-service.impl.md:210`; `gateway-service.impl.md:380–389`.
  - An Intake resource name is its inbound identity, and each segment uses percent encoding. `gateway-service.impl.md:365`, `:368`.
  - Each remote call of an inbound takes one single-use grant. `intake-service.impl.md:19`.
  - A credential archive is refused while an inbound names it (`docs/reference/erd/03-integration.md:127`), and custody refuses a revoke of the newest live revision (`custody.md:35`), so the refused release comes from a fake facility.
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
  - The composition root owns each temporary stand-in for a seam that a later plan implements. `architecture.impl.md:968`.
- Done when: `node --test --test-timeout=30000 src/apps/server/unwired-import.test.ts` passes; `pnpm run verify` passes.

### 10.4 Assert the tables, the indexes and the references of ERD 1 to ERD 3

- Files: `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Rename the combined test to "all ERD 1, ERD 2 and ERD 3 migrations produce exactly the twenty tables", add `intakeMigrations` to `allServices`, and add `intake_inbound`, `intake_inbound_event` and `intake_outbound_request` to `ALL_TABLES`.
  2. Add `intake_inbound_event_inbound_event` and `intake_outbound_request_operation_key` to `ALL_INDEXES`.
  3. Assert that the ERD 3 references are exactly `intake_inbound_event.inbound_id` to `intake_inbound.id`, and that `intake_inbound` and `intake_outbound_request` hold none.
- Rules:
  - The tables are the tables of the three ERD pages. `docs/reference/erd/03-integration.md:106–112`.
  - The two unique indexes are the only ERD 3 indexes. `docs/reference/erd/03-integration.md:125`, `:133`, `:143`; decision D20.
  - The one foreign key of ERD 3 and the references with no FK. `docs/reference/erd/03-integration.md:85–91`, `:165–171`.
  - No SQL `CHECK`; every index is unique. Root `AGENTS.md` "Database design".
- Done when: `node --test --test-timeout=30000 src/apps/server/migrations.test.ts` passes; `pnpm run verify` passes.

### 10.5 Assert the final OpenAPI inventory

- Files: `src/apps/server/openapi-integration.test.ts` (edit)
- Do:
  1. Add the rows of the Intake Service to `OPERATION_INVENTORY`:
     - `human`, prefix `intake.`: `inbound.create`, `inbound.list`, `inbound.get`, `inbound.delete`, `inbound.event.list`, `inbound.event.get`, `inbound.event.retry`, `inbound.event.discard`, `inbound.event.delete`, `outbound.request.list`, `outbound.request.get`, `outbound.request.discard`, `outbound.request.delete`.
     - `delivery`, prefix `intake.`: `inbound.event.receive`.
  2. Assert 162 routed rows: 148 of ERD 1 and ERD 2 and 14 of ERD 3.
  3. Assert that the sorted ids of `registry.all()` equal the inventory plus the two `service` operations `intake.action.check` and `mission.delivery.admit` plus the seven `direct: true` operations `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get` and `intake.storage.delete` (171); that the emitted OpenAPI holds no `operationId` of the nine; and that the emitted method and path pairs equal those of the 162 routed rows.
- Rules:
  - The route set of the registry equals the path set of the committed OpenAPI. `architecture.impl.md:837`.
  - A `service` operation and a `direct: true` operation have no route and no OpenAPI entry. `architecture.impl.md:668`; `intake-service.impl.md:130`.
  - The access policy of each row is the access column of its page: every command of `engine/docs/cli/intake.md` is `human`; the receipt is `delivery`; the caller kinds of the API operations follow `intake-service.impl.md:121–128`, and they declare `direct: true`.
- Done when: `node --test --test-timeout=30000 src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 10.6 Assert the CLI completeness of the Intake group

- Files: `src/apps/cli/completeness.test.ts` (edit)
- Do:
  1. Add `intake.md` "## Command table" to `PAGE_INVENTORIES`; remove `intake` from `LATER_GROUPS`.
  2. Add to `API_ONLY_OPERATIONS`: `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete`, `intake.inbound.event.receive`.
  3. Assert: the documented paths number 157 (ERD 2 count 144 and 13 Intake rows); the program leaves number 152; the program holds the `intake` group with the leaves `inbound create`, `inbound list`, `inbound get`, `inbound delete`, `event list`, `event get`, `event retry`, `event discard`, `event delete`, `outbound list`, `outbound get`, `outbound discard`, `outbound delete`; the ids of the rows that are not exempt, joined with `API_ONLY_OPERATIONS`, equal the 163 ids of the non-service operations of the contracts.
  4. Extend the operation-id pattern of the test with `intake`.
- Rules:
  - A command table holds one row for each command of the group. `architecture.impl.md:545–546`.
  - The top-level names include `intake`. `architecture.impl.md:539`.
  - The seven API operations have no CLI leaf and no HTTP route, and the receipt has no CLI command. `engine/docs/cli/intake.md:379–418`.
- Done when: `node --test --test-timeout=30000 src/apps/cli/completeness.test.ts` passes; `pnpm run verify` passes.

### 10.E Prove the integration journey

- Files: `src/apps/server/e2e-integration-journey.test.ts` (create)
- Do:
  1. Start `fakeGitHub(t)`, `fakeS3(t)`, the bare repositories `gated` and `merge`, and `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }`, `github`, `repositoryTransport`, `intake: { pollIntervalMs: 50 }` and `inventoryOverrides: { repository: () => [] }`.
  2. Build fixture J of `## E2E` through the CLI and run EJ10.1 to EJ10.9 in one test in table order, with the test option `{ timeout: 120000 }`. Assert the `nodeId` and the node state of every claim. Poll a CLI read every 50 ms for at most 10 s where a row waits for the dispatcher or the poll.
  3. Read the health report with `fixture.request(gatewayOperations.healthcheck.path, …)` and the human token. Call `worker.action.request` and the object operations through `httpClient` from the test process.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read, except the receipt, the health report and the API operations without a CLI command. ERD 1 decision D13.
  - The scripted client of an external harness drives both claim kinds. `worker-service.md:42`; ERD 2 plan 10 task 10.8.
  - The fixture connector answers the Project repository checks, and no real platform call runs. Decision D17; ERD 2 plan 10 task 10.8.
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
4. `kanthord intake inbound create --file` of a webhook inbound `W` of `owner/gated` (`hook.json` of plan 06 with `"resource": "owner/gated"`) → `S` = the `secret` of `inbound get`; of a poll `L` of `owner/merge` (`poll.json` of plan 07 with `"resource": "owner/merge"`); of a second webhook inbound `V` of `owner/gated` (`webhook.json` of plan 05 with `"resource": "owner/gated"`).
5. `generateMachineToken` → `T`; `kanthord worker register` [T] → `rid`.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Exit                                | Expect                                                                                                                                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EJ10.1 | `GET /api/healthcheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 200                                 | `services.intake.projects.journey` holds `W` `{ "status": "unknown", "capability": "webhook" }`, `L` `{ "status": "healthy", "capability": "poll acquisition" }`, `V` `{ "status": "unknown", "capability": "webhook" }`; `services.project.projects.journey.gated.status` `healthy` through the fixture connector |
| EJ10.2 | `objective(P, gatedBindingId, p, true)`; `kanthord mission node get <P>`; `kanthord intake outbound list --operation github.pull_request`                                                                                                                                                                                                                                                                                                                                                                       | the CLI steps 0, the HTTP steps 200 | `state` `External.Requested`; one `succeeded` request                                                                                                                                                                                                                                                              |
| EJ10.3 | `gitHub.merge(1, m)`; `deliver(W, S, "pull_request", "d-1", closed(1))`; wait; the event of `d-1` → `E1`; `kanthord mission node get <P>`; `kanthord mission evidence list <P> --attempt 1`                                                                                                                                                                                                                                                                                                                     | 202, 0, 0, 0                        | `E1` `succeeded`; `state` `Completed`; the landed-commit evidence of P holds `inbound_event_id` = `E1`                                                                                                                                                                                                             |
| EJ10.4 | `kanthord mission node create` of an objective `Q` with `"bindings": ["merge"]` under `I`; push `q` to `refs/heads/kanthord/<Q>` of the merge bare repository; `objective(Q, mergeBindingId, q, false)`; `kanthord intake outbound list --operation git.merge_push`                                                                                                                                                                                                                                             | the CLI steps 0, the HTTP steps 200 | the request `succeeded` with the stored result `{ "kind": "branch_push", "branch": "main", "commit": c, "resource_identity": "repository:github:owner/merge" }` → `c`                                                                                                                                              |
| EJ10.5 | `gitHub.events("owner", "merge", [{ "id": "500", "type": "PushEvent", "repo": { "name": "owner/merge" }, "payload": { "ref": "refs/heads/main", "head": c } }])`; wait; `kanthord intake event list --inbound <L>`; `kanthord mission node get <Q>`                                                                                                                                                                                                                                                             | —, 0, 0                             | one `succeeded` event; `state` `Completed`                                                                                                                                                                                                                                                                         |
| EJ10.6 | `kanthord scheduler work pull --file pull.json` [T] → `x`, `e` with `x.nodeId` = I; `kanthord mission evidence submit <I> --file report.json` [T] → `rep`; `kanthord scheduler execution release <e> --file release(false)` [T]; `kanthord scheduler work pull --file pull.json` [T] → `x'`, `e'` with `x'.nodeId` = I; `kanthord mission evidence submit <I> --file initiative-run.json` [T] → `ir`; `kanthord mission assessment submit <I> --file initiative-pass.json` [T]; `kanthord mission node get <I>` | 0 each                              | the assessment answers `node.state` `Completed` and `outcome.result` `success`; `state` `Completed`                                                                                                                                                                                                                |
| EJ10.7 | `GET /api/healthcheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 200                                 | `W` `unknown`, `L` `healthy`, `V` `unknown`                                                                                                                                                                                                                                                                        |
| EJ10.8 | `kanthord mission get <projectId>` → M; `kanthord mission evidence delete <the evidence of o> --force --reason "journey" --expected-mission-version <M>`; `kanthord intake outbound list --operation s3.delete_object`                                                                                                                                                                                                                                                                                          | 0, 0, 0                             | one `succeeded` request whose `requestKey` is the asset identity of `o`; `fakeS3` holds no version of that asset                                                                                                                                                                                                   |
| EJ10.9 | `kanthord intake inbound delete <W>`; `kanthord intake inbound delete <L>`; `kanthord intake inbound delete <V>`; `GET /api/healthcheck`                                                                                                                                                                                                                                                                                                                                                                        | 0, 0, 0, 200                        | `services.intake.projects` `{}`; no platform call of an inbound delete                                                                                                                                                                                                                                             |
