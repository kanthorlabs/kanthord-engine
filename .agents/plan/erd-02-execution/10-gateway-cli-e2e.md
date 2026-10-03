# Plan 10: Gateway composition, CLI and the journeys

## Scope

This plan closes the ERD 2 plan set. It adds no service operation, no table and no CLI leaf. It delivers:

- The final `unwired` set of decision D6: the eight ERD 3 seams alone.
- The combined assertion of the sixteen tables of ERD 1 and ERD 2, their thirteen unique indexes, the absence of `CHECK` and the owner rule of every foreign key.
- The names of a worker binding in the answer of `ProjectBindings.workerBindingOf` (debate Q1 of this plan, ruled 2026-09-30).
- The health report entries of a registration in the inventory of the Worker Service.
- The final OpenAPI inventory assertion: 106 operations with their access policies.
- The CLI dispatcher completeness over every command page of `engine/docs/cli/`, with five named exemptions and two groups of later ERDs.
- The machine-token helper of the journeys.
- Two E2E journeys: the external harness as a scripted CLI client of `claude@1`, and the internal harness with two in-process `worker` applications, the scripted fake provider and local bare repositories.

Out of scope:

- The MCP server and the MCP tool source (decision D5; ruling R1). The external-harness journey covers a node that requires no external action.
- The CLI leaf `evidence upload <node-id> <path>` (row 35 of `engine/docs/cli/mission.md:400`). The external-harness phase owns it, and task 10.6 exempts it by name.
- The extension of Claude Code and opencode and its `/work` skill (`worker-service.impl.md:147–150`).
- Every B9 item and every open HANDOFF item (decision D1). Each task that meets one states the gap in one line.
- The real-provider smoke run (`worker-service.impl.md:483`) and every real platform call (decision D16).

## Sources

- `docs/reference/erd/01-setup.md:155–167`, `docs/reference/erd/02-execution.md:166–176` — the sixteen tables and their owners.
- `docs/reference/erd/02-execution.md:192`, `:206–207`, `:232`, `:270`, `:276`, `:288`, `:293–306` — the ERD 2 indexes and the cross-group references with no FK.
- `docs/reference/erd/README.md:97` — a requested external action stays unresolved in production until ERD 3.
- `docs/brainstorm/architecture.md:119–142` — the resource healthcheck and the owners of the inventory.
- `docs/brainstorm/architecture.impl.md:95` — a service reads no table of another service.
- `docs/brainstorm/architecture.impl.md:536–545`, `:565` — the closed top-level names and the command tables.
- `docs/brainstorm/architecture.impl.md:593` — a collaboration takes the caller transaction.
- `docs/brainstorm/architecture.impl.md:828` — the route set of the registry equals the committed OpenAPI.
- `docs/brainstorm/gateway-service.impl.md:352–376` — the report body, the entry names and the owner failure.
- `docs/brainstorm/worker-service.impl.md:147–150`, `:168–170`, `:189` — the externally hosted worker, the registration check and the resource identity form.
- `docs/brainstorm/worker-service.md:42`, `:213` — the declared states and the healthcheck of an external-harness instance.
- `docs/brainstorm/custody.md:74`; `docs/brainstorm/project-service.md:88`; `docs/brainstorm/project-service.impl.md:217` — no credential reaches an external harness; `no_native_agent`.
- `docs/brainstorm/mission-service.md:489–494` — the initiative steps condition.
- `engine/docs/cli/README.md:10–37` — the command documents.
- `engine/docs/cli/credential.md:62–80`, `project.md:148–177`, `mission.md:158–584`, `scheduler.md:159–179`, `worker.md:101–147`, `gateway.md:15–34`, `:216–228`, `other.md:25–46`, `intake.md:37–64`, `tracking.md:37–60` — the command inventories.
- `engine/docs/cli/mission.md:633`, `:711–743`, `:814` — `NodeCreate`, the execution submissions, `TestedInput` and `StoredContent`.
- `engine/docs/cli/other.md:599–640` — the machine token and `jwt inspect`.
- `docs/brainstorm/HANDOFF.md:27`, `:41` — the Mission record-contract item and the Intake source ruling.
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- `.dev/erd-02/decisions-log.md` 2026-09-30 "plan 10 — the names of a registration entry of the health report".
- The code: `engine/src/apps/server/unwired-import.test.ts`, `migrations.test.ts:22–284`, `openapi-integration.test.ts:67–121`, `index.ts:62–191`, `test-support.ts:125–252`, `cli-support.ts:11–52`, `e2e-worker-app.test.ts:281–305`; `engine/src/apps/cli/index.ts:126–164`, `:227–240`, `constants.ts:2–13`; `engine/src/worker/service.ts:481–505`; `engine/src/project/service.ts:534`, `:625–651`, `store.ts:110`; `engine/src/gateway/health-report.ts:50–63`; `engine/src/kernel/health.ts:131–140`; `engine/src/kernel/operation.ts:8–13`.
- Root `AGENTS.md` "Contracts", "Database design" and "Rejected proposals".

## Depends on

- ERD 1, merged.
- Plans 01 to 09, committed. This plan consumes only the seams of their "Provides" tables and of `00-index.md` "Seams":
  - Plan 01: `unwired.ts`, the `standIns` option and `UNWIRED_SEAMS` (task 01.4); the five Mission tables (task 01.1); the attempt, record and external-action reads.
  - Plan 02: `worker_instance`; `WorkerService.registrationChecks`, `REGISTRATION_CAPABILITY`; `ProjectBindings.workerBindingOf` with `WorkerBindingRow` and the inline `WorkerBindingOf` of `src/worker/contract.ts` (tasks 02.3, 02.6); the instance reads and `worker register`, `heartbeat`, `instance deregister`.
  - Plan 03: `scheduler_execution`; the work pull, the release, `claim get`, `execution list` and `get`; the execution proof.
  - Plan 04: the execution submissions and reads; `objectSink`, `sinkStorage`, `scriptedCheck` of `src/apps/server/test-support.ts`.
  - Plan 05: `worker.handover` and the refusal `worker.authorization.refused` (task 05.4).
  - Plan 06: `worker.action.request`; `scriptedActions` of `src/apps/server/test-support.ts`.
  - Plan 07: `scriptedProvider`, `scriptedModelRuntime` of `src/worker/test-support.ts`; `RepositoryTransport`; the test-file policy of `eslint.config.js` (task 07.E).
  - Plan 08: the steps method and the evaluation method behind `runNativeExecution`.
  - Plan 09: the answer `{ runtimeIdentity, resourceIdentity, workerName }` of `worker.register` (task 09.1, ruled 2026-09-30); the host tool `evidence-upload` (task 09.2, ruled 2026-09-30); `inProcessWorker` and `toolStubs` (task 09.11); the test-file policy of `eslint.config.js` (task 09.3).
- No boundary change of `eslint.config.js`. Decision D23 names the two test-file allowances that the journeys use.

## Provides

| Seam                                     | TypeScript signature                                                                                                                                                         | Owner file                                          | Consumer plans |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- |
| `ProjectBindings.workerBindingOf` (ext.) | The answer of plan 02 gains `name: string` (the binding name) and `projectName: string`                                                                                      | `src/project/contract.ts`, `src/worker/contract.ts` | 10             |
| Registration entries                     | `WorkerService.resourceInventory(tx)` appends one project-scoped `ResourceEntry` per live registration, target `registration:<runtime identity>`                             | `src/worker/service.ts`                             | Gateway        |
| `generateMachineToken`                   | `(input: { env: NodeJS.ProcessEnv; masterKey: string; projectId: string; bindingName: string; name: string }) => { token: string; clientSecret: string }` — test helper only | `src/apps/server/cli-support.ts`                    | 10, later ERDs |

Two differences from `00-index.md`:

- The seam row `ProjectBindings.workerBindingOf` gains two fields (debate Q1, ruled 2026-09-30). The Scheduler type of plan 03 stays unchanged, because the wider answer satisfies it.
- The health report entries need no edit of `src/apps/server/index.ts`, because the Worker inventory already feeds `collectInventories` (`src/apps/server/index.ts:168–170`).

## Tasks

### 10.1 Assert the final `unwired` set

- Files: `src/apps/server/unwired-import.test.ts` (edit); `src/apps/server/index.ts` (edit only under step 3)
- Do:
  1. Set `UNWIRED_SEAMS` (plan 01 task 01.4 step 7) to the eight names `IntakeStorage.put`, `IntakeStorage.check`, `IntakeStorage.get`, `IntakeStorage.executionGet`, `IntakeStorage.delete`, `IntakeCheck.check`, `IntakeActions.perform` and `IntakeActions.read`.
  2. Assert that each name occurs exactly once as a literal `unwired("…")` in `src/apps/server/index.ts`.
  3. Search `src/apps/server/index.ts` for `unwired("SchedulerClaims.activityOf")`. When the literal stands, pass `activityOf: (tx, r, n) => scheduler.activityOf(tx, r, n)` to the Worker dependency of plan 02 task 02.9 in its place.
  4. Keep the assertion of plan 01 that only `index.ts` and `unwired.test.ts` import `unwired.ts`.
- Rules:
  - The final set is the eight ERD 3 seams alone. Decision D6.
  - Every ERD 2 peer seam is wired, and every production stand-in of D9 except the ERD 3 rows is gone. Decision D9; plan 03 task 03.15 "Done when".
  - Gap: plan 03 task 03.15 steps 1 and 3 name five Scheduler seams and omit `SchedulerClaims.activityOf` (D9 table row "Worker `SchedulerClaims.activityOf` | 02 | 03"); step 3 closes that gap when it stands.
- Done when: `node --test --test-timeout=30000 src/apps/server/unwired-import.test.ts` passes; `pnpm run verify` passes.

### 10.2 Assert the tables, the indexes and the references of ERD 1 and ERD 2

- Files: `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Rename the test "all ERD 1 migrations produce exactly the expected tables" (`:223`) to "all ERD 1 and ERD 2 migrations produce exactly the sixteen tables". Rename its service list (`erd1Services`, `:224`) to `allServices`. Replace the expected list that plans 01 to 03 extend with one constant `ALL_TABLES`: `credential`, `mission_assessment`, `mission_attempt`, `mission_dependency`, `mission_evidence`, `mission_evidence_asset`, `mission_mission`, `mission_node`, `mission_node_revision`, `mission_outcome`, `project_binding`, `project_project`, `scheduler_execution`, `scheduler_job`, `worker_agent_enablement`, `worker_instance`. Remove each partial constant that becomes an orphan.
  2. Declare `ALL_INDEXES`: `credential_name_revision`, `mission_assessment_sequence`, `mission_attempt_open`, `mission_evidence_request`, `mission_node_filename_active`, `mission_outcome_sequence`, `project_binding_revision`, `project_project_name`, `scheduler_execution_node_live`, `scheduler_execution_runtime_live`, `scheduler_job_node_id`, `worker_agent_enablement_agent_name_revision`, `worker_instance_live_client`. Assert that the sorted index names of `sqlite_master` without `sqlite_autoindex%` equal it.
  3. For each table, assert that every row of `pragma_index_list` holds `unique` 1.
  4. Assert that no `sql` of `sqlite_master` matches `/\bCHECK\b/i`.
  5. For each table, read `pragma_foreign_key_list`. Assert that the owner of each target table equals the owner of the source table, with the owner map of the test. Assert that the ERD 2 references are exactly `mission_attempt.node_id`, `mission_evidence.node_id`, `mission_assessment.node_id` and `mission_outcome.node_id` to `mission_node.id`, `mission_evidence_asset.evidence_id` to `mission_evidence.id` and `mission_outcome.assessment_id` to `mission_assessment.id`. Assert that `worker_instance` and `scheduler_execution` hold none.
- Rules:
  - The tables are the tables of the two ERD pages. `01-setup.md:155–167`; `02-execution.md:166–176`.
  - Every index is unique; a partial unique index is allowed. Root `AGENTS.md` "Database design"; decision D24.
  - No SQL `CHECK`. Root `AGENTS.md` "Database design".
  - A cross-owner reference holds no FK, and the `FK` labels inside the Mission group take a `REFERENCES` clause. `02-execution.md:293–306`; decision D24.
  - The migration test covers the prefix rule and the isolation rule. `engine/AGENTS.md` "Add a migration".
- Done when: `node --test --test-timeout=30000 src/apps/server/migrations.test.ts` passes; `pnpm run verify` passes.

### 10.3 Answer the names of a worker binding from `workerBindingOf`

- Files: `src/project/contract.ts`, `src/project/service.ts`, `src/project/service.test.ts`, `src/worker/contract.ts` (all edit); every Worker test file that fakes `workerBindingOf` (find them with `grep -rln workerBindingOf src/worker src/apps/server`)
- Do:
  1. Add `name: string` and `projectName: string` to `WorkerBindingRow` of `src/project/contract.ts` (plan 02 task 02.3 step 1).
  2. In `workerBindingOf` (plan 02 task 02.3 step 3), answer `name: row.name` and `projectName: requireProject(tx, projectId).name` (`src/project/store.ts:110`).
  3. Add the two fields to the inline `WorkerBindingOf` of `src/worker/contract.ts` (plan 02 task 02.6 step 1). Keep the Scheduler type of plan 03 unchanged.
  4. Add both fields to each Worker fake of `workerBindingOf`.
  5. Add tests in `src/project/service.test.ts`: the answer holds the binding name and the project name; after `project.rename` it holds the new project name; the tombstone row of a removed group holds its binding name; the call opens no transaction of its own.
- Rules:
  - The report keys a project-scoped entry by the project name and the resource name. `gateway-service.impl.md:357`, `:366`.
  - The Worker Service reads no table of another service, so the Project Service answers the names. `architecture.impl.md:95`.
  - The existing seam carries the names, and no new collaboration exists. Debate Q1 (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 10", ruled 2026-09-30).
  - A collaboration takes the caller transaction and opens none. `architecture.impl.md:593`.
  - Every field name is the name of the owning vocabulary. Root `AGENTS.md` "Contracts".
- Done when: `node --test --test-timeout=30000 src/project/service.test.ts src/worker/service.test.ts` passes; `pnpm run verify` passes.

### 10.4 Add the registration entries to the Worker inventory

- Files: `src/worker/contract.ts`, `src/worker/service.ts`, `src/worker/service.test.ts` (all edit)
- Do:
  1. Declare `REGISTRATION_TARGET_KIND = "registration"` in `src/worker/contract.ts` beside `REGISTRATION_CAPABILITY`.
  2. In `resourceInventory(tx)` (`src/worker/service.ts:481–505`), keep the agent-provider entries. Then, for each item of `this.registrationChecks(tx)`, read `binding = this.dependencies.workerBindingOf(tx, item.projectId, item.resourceIdentity)`.
  3. Assert that `binding` is not null and is no tombstone. The assertion error reaches `collectInventories` (`src/gateway/health-report.ts:56–61`), which reports the owner `worker` in `missingInventories`.
  4. Append `{ scope: HealthScope.Project, project: binding.projectName, name: encodeURIComponent(binding.name) + "/" + encodeURIComponent(item.runtimeIdentity), target: REGISTRATION_TARGET_KIND + ":" + item.runtimeIdentity, capability: item.capability, check: item.check }`.
  5. Add tests: one live registration answers one project entry with the project name, the encoded name and the capability `liveness of a registration`; the check answers `healthy` inside `worker.heartbeatWindow` and `unhealthy` outside it with the controlled clock of plan 02 task 02.7; an ended registration answers no entry; the agent-provider entries stay unchanged; a null binding answer makes `collectInventories` report `worker` missing; a check changes no registration, no heartbeat reading and no instance healthcheck.
- Rules:
  - The inventory comes from the owning service, and the Worker Service owns the entry of a registered instance. `architecture.md:128`, `:142`.
  - The resource name is `<worker binding name>/<runtime identity>`, and each segment uses percent encoding. `gateway-service.impl.md:366–367`.
  - The check reports `healthy` inside the window and `unhealthy` otherwise, with the capability `liveness of a registration`. `worker-service.impl.md:168–169`.
  - A failed check changes no instance healthcheck. `architecture.md:135`; `worker-service.impl.md:170`.
  - An owner failure adds that owner to `missingInventories`. `gateway-service.impl.md:371`, `:376`; debate Q1.
  - One request checks each target once. `architecture.md:137`. Gap: no page names the target of a registration check; the plan takes the runtime identity, and the report lists it for Ulrich.
  - A live registration never meets a removed or unavailable group, because the binding-set write ends it (plan 02 task 02.14).
- Done when: `node --test --test-timeout=30000 src/worker/service.test.ts` passes; `pnpm run verify` passes.

### 10.5 Assert the final OpenAPI inventory

- Files: `src/apps/server/openapi-integration.test.ts` (edit)
- Do:
  1. Declare `OPERATION_INVENTORY: readonly (readonly [string, AccessPolicy])[]` with the 106 rows below.
  2. Assert that the sorted ids and access policies of `apiOperations` (`:67–74`) equal the inventory.
  3. Assert that the `x-access-policy` of each resolved OpenAPI operation equals the access policy of its inventory row.
  4. Start `gatewayFixture` with `registry: new OperationRegistry()`. Assert that the sorted ids of `registry.all()` equal the ids of the inventory.
  5. The rows. Each group names its id prefix once; the id is the prefix plus the listed name.
     - `public`, prefix `gateway.`: `liveness`, `openapi`, `openapiFile`.
     - `human`, prefix `gateway.`: `healthcheck`, `verify`.
     - `human`, prefix `credential.`: `create`, `list`, `get`, `rotate`, `update_metadata`, `revoke`, `login`, `login_code`, `login_status`.
     - `human`, prefix `worker.`: `agent.enablement.list`, `agent.enablement.get`, `agent.enablement.put`, `agent.enablement.enable`, `agent.enablement.disable`, `agent.enablement.remove`, `agent.enablement.provider.add`, `agent.enablement.provider.remove`, `catalog.list`, `catalog.get`, `agent.get`, `instance.list`, `instance.get`, `instance.resume`.
     - `client`, prefix `worker.`: `register`, `heartbeat`, `handover`, `credential`, `instance.deregister`, `action.request`, `execution.setup.get`.
     - `human`, prefix `scheduler.`: `queue.list`, `queue.peek`, `execution.list`, `execution.get`.
     - `client`, prefix `scheduler.`: `work.pull`, `claim.get`, `execution.release`.
     - `human`, prefix `project.`: `create`, `list`, `get`, `rename`, `binding.list`, `binding.get`, `bindingSet.get`, `bindingSet.write`, `bindingRevision.list`, `agentConfiguration.list`, `agentConfiguration.get`.
     - `human`, prefix `mission.`: `get`, `export`, `import.preview`, `import.apply`, `edge.list`, `dependency.add`, `dependency.remove`, `node.list`, `node.get`, `node.create`, `node.update`, `node.move`, `node.revision.list`, `node.revision.get`, `node.retire.preview`, `node.retire`, `node.rebind`, `node.priority.set`, `criterion.set`, `node.pause`, `node.resume`, `node.block`, `node.unblock`, `node.ready`, `node.override`, `node.discard`, `node.check`, `attempt.list`, `attempt.get`, `evidence.list`, `evidence.get`, `evidence.asset.content.get`, `evidence.asset.delete`, `evidence.delete`, `assessment.list`, `assessment.get`, `outcome.list`, `outcome.get`, `externalAction.list`, `externalAction.get`.
     - `client`, prefix `mission.`: `evidence.submit`, `evidence.asset.complete`, `evidence.request`, `assessment.submit`, `execution.pinnedRevision.get`, `execution.revision.list`, `execution.revision.get`, `execution.evidence.list`, `execution.evidence.asset.content.get`, `execution.objective.list`, `execution.objective.outcome.list`, `execution.objective.evidence.list`, `execution.clearedOutcome.get`.
- Rules:
  - The route set of the registry equals the path set of the committed OpenAPI. `architecture.impl.md:828`.
  - The inventory holds 55 operations of ERD 1 and 51 of ERD 2: 34 Mission operations of plans 01 and 04, 5 Scheduler operations of plan 03 and 12 Worker operations of plans 02, 05, 06 and 07. Plans 01 to 09 "Provides"; `00-index.md` "Plans".
  - The access policy of each row is the access column of its CLI page (`H` is `human`, `E` is `client`). `engine/docs/cli/mission.md:143–157`; `engine/docs/cli/worker.md:111–136`; `engine/docs/cli/scheduler.md:166–174`; `engine/docs/cli/gateway.md:224–228`.
  - An oversized fragment keeps its named exception. Decision D23.
- Done when: `node --test --test-timeout=30000 src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 10.6 Assert the CLI dispatcher completeness

- Files: `src/apps/cli/completeness.test.ts` (create)
- Do:
  1. Read the pages of `docs/cli/` (resolved from `import.meta.url`). For each page of `PAGE_INVENTORIES`, take the lines from its heading to the next line that starts with `## `: `credential.md` "## Command inventory", `project.md` "## Proposed command inventory and synopsis", `mission.md` "## Proposed command inventory and synopsis", `scheduler.md` "## Command inventory and proposed operation mapping", `worker.md` "## Command inventory", `gateway.md` "## Complete command table", `other.md` "## Command inventory".
  2. In each section, skip every separator row that starts with `| -` and the header row directly before it. For each other table row, take its first code span. Remove a leading `kanthord <group> `. The leaf is the leading tokens that match `/^[a-z][a-z-]*$/`, up to the first token that does not. Skip a row with an empty leaf. For `other.md`, read the numbered lines `N. \`kanthord …\`` in the same way, with no group.
  3. The documented path is `<group> <leaf>`, where the group is the page name; for `other.md` it is the leaf alone. Collect the operation ids of each row: every code span that matches `/^(gateway|credential|worker|scheduler|project|mission)\.[A-Za-z_.]+$/`.
  4. Walk `createProgram()` (`src/apps/cli/index.ts:126`). A command is a program leaf when it holds a registered argument (`registeredArguments.length > 0`), or when it sits below a top-level command and holds no subcommand.
  5. Declare `EXEMPT_LEAVES`, each with its reason: `mission evidence upload` (row 35; the external-harness phase); `mission graph get` and `mission criterion list` (rows 2 and 13; no ERD 1 or ERD 2 plan); `project source secret get` (row 12; HANDOFF Intake source ruling); `worker provider check` (no ERD 1 or ERD 2 plan). Declare `LATER_GROUPS = { intake: "ERD 3", tracking: "ERD 4" }` for `intake.md` and `tracking.md`.
  6. Declare `API_ONLY_OPERATIONS`: `gateway.liveness`, `gateway.healthcheck`, `gateway.openapi`, `gateway.openapiFile`, `worker.credential`, `worker.action.request`, `worker.execution.setup.get`, `mission.evidence.asset.complete`, `mission.evidence.request`.
  7. Assert: the distinct documented paths number 110 (credential 9, project 12, mission 54, scheduler 7, worker 19, gateway 2, other 7); the documented paths without `EXEMPT_LEAVES` equal the program leaves (105); every exempt path is documented and is no program leaf; the program holds no `intake` command, and `tracking` holds no subcommand; the top-level names are a subset of `config`, `serve`, `jwt`, `project`, `mission`, `scheduler`, `intake`, `worker`, `tracking`, `gateway` and `credential`.
  8. Assert that the operation ids of the rows that are not exempt, joined with `API_ONLY_OPERATIONS`, equal the ids of the six contracts of `src/apps/cli/index.ts:227–234` (106), and that the two sets are disjoint.
- Rules:
  - A command table holds one row for each command of the group, and a command that names an operation which no route serves is a defect. `architecture.impl.md:544–545`.
  - The top-level names belong to three closed sets. `architecture.impl.md:536–541`. ERD 1 decision D12 registers no Intake stub, so the program holds no `intake` group.
  - Row 35 is the harness helper form, and the external-harness phase owns its leaf. `engine/docs/cli/mission.md:400`, `:549–550`; plan 09 "Blockers".
  - Gap: rows 2 and 13 keep the mark `[blocked][mission-contract]` (`engine/docs/cli/mission.md:170`, `:181`), and no plan builds them (ERD 1 decision D12; decision D26).
  - Gap: row 12 waits for the Intake source redesign (`engine/docs/cli/project.md:173`; `docs/brainstorm/HANDOFF.md:41`).
  - Gap: `worker provider check` (`engine/docs/cli/worker.md:135`, `:456–490`) has no plan; ERD 1 plan 03 deferred it (`erd-01-setup/03-worker-agent-enablement.md:14`). This is a finding under decision D26.
  - The API-only operations have no CLI leaf by their pages. `engine/docs/cli/gateway.md:224–228`; `engine/docs/cli/worker.md:139–140`; `engine/docs/cli/mission.md:503–505`, `:549–558`; plan 06 task 06.12; plan 07 task 07.16.
  - A comparison against a fixed string uses a named constant. `architecture.impl.md:15–19`.
- Done when: `node --test --test-timeout=30000 src/apps/cli/completeness.test.ts` passes; `pnpm run verify` passes.

### 10.7 Add the machine-token helper of the journeys

- Files: `src/apps/server/cli-support.ts` (edit), `src/apps/server/cli-support.test.ts` (create)
- Do:
  1. Export `generateMachineToken({ env, masterKey, projectId, bindingName, name })`. Write `configuration({ masterKey }).getProperties()` as private YAML into `issuance.yaml` of `env.XDG_CONFIG_HOME`, as `src/apps/server/e2e-worker-app.test.ts:281–287` does.
  2. Run `kanthord jwt generate --project <projectId> --binding <bindingName> --name <name> --config <path>` with the TTY shim of `e2e-worker-app.test.ts:291–305`. Assert exit 0 and an empty stderr. Parse the YAML fragment and answer `{ token, clientSecret }`.
  3. Add a test: `kanthord jwt inspect <token>` prints `kind: client`, `project_id: <projectId>`, `resource_identity: worker:kanthord:<bindingName>` and `name: <name>`, and no `binding` line; `clientSecret` decodes to 32 bytes; two calls answer two different client secrets.
  4. Keep the inline shims of the earlier tests unchanged.
- Rules:
  - `jwt generate --project --binding` needs a terminal on stdout and prints the `token` and `clientSecret` fragment. `gateway-service.impl.md:156–160`; `engine/docs/cli/other.md:599–633`.
  - The journeys issue machine tokens in the form of plan 02 task 02.4: `--project <projectId> --binding <binding name>`, and the token holds `project_id` and `resource_identity`. `gateway-service.impl.md:156–157`; plan 03 "E2E".
  - No output of the helper reaches a log. Plan 05 "E2E" rule.
- Done when: `node --test --test-timeout=30000 src/apps/server/cli-support.test.ts` passes; `pnpm run verify` passes.

### 10.8 Prove the external-harness journey

- Files: `src/apps/server/e2e-external-harness.test.ts` (create)
- Do:
  1. Start `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }` and `inventoryOverrides: { custody: () => [] }`.
  2. Build fixture X of "E2E" through the CLI. Issue `T` and `S` with `generateMachineToken` of task 10.7.
  3. Implement the rows EX10.1 to EX10.11 in one test and in table order, because each row reads the state of the rows before it.
  4. Read the health report with `fixture.request(gatewayOperations.healthcheck.path, …)` and the human token, and parse it with `gatewayOperations.healthcheck.output`.
- Rules:
  - A worker that an external harness hosts declares `Available`, `Waiting` and `External.Requested`, so one instance takes both claim kinds. `worker-service.md:42`.
  - The scripted client registers, pulls, submits and releases through the CLI as the extension would. `worker-service.impl.md:149`.
  - No credential reaches an external harness, so the handover answers 403 `worker.authorization.refused` with `no_native_agent`. See `worker-service.impl.md` "The credential store of an execution"; plan 05 task 05.4.
  - The journey requires no external action, because the MCP server is out of scope. Decision D5.
  - The custody override keeps the report free of real platform calls; the Project check runs against the fixture connector. Decision D16.
  - Setup goes through the CLI; the state check is a CLI read, except the health report, which has no CLI command. `engine/docs/cli/gateway.md:225`.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-external-harness.test.ts` passes every row; `pnpm run verify` passes.

### 10.9 Add the local repositories of the internal-harness journey

- Files: `src/apps/server/e2e-internal-harness.test.ts` (create)
- Do:
  1. Add `bareRepository(t, name)`: `git init --bare --initial-branch=main` in a temporary directory; a temporary clone commits `README.md` and pushes `main`. Answer the path and the head of `main`.
  2. Add `mappedTransport(addresses: Record<string, string>): RepositoryTransport` over `new RepositoryComponent()`. `clone` and `cloneSnapshot` replace a known address with its bare path. `fetchAndCheckout` and `pushNodeBranch` pass through. An unknown address fails the test.
  3. Add `remoteHead(bare, ref)`: the commit of `git ls-remote <bare> <ref>`, or null.
  4. Add a test: `clone` of `git@github.com:owner/repo.git` through the mapped transport checks out the head of `main` of the bare repository; a push of a node branch is visible through `remoteHead`.
- Rules:
  - The repository binding keeps its SSH address, and the injected transport targets a local bare repository. Decision D15.
  - The connector spawns `git` and uses no credential. `00-index.md` "Seams", row `RepositoryTransport`.
  - No real platform call. Decision D16.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-internal-harness.test.ts` passes; `pnpm run verify` passes.

### 10.E Prove the internal-harness journey

- Files: `src/apps/server/e2e-internal-harness.test.ts` (edit)
- Do:
  1. Start `objectSink(t)` and `actions = scriptedActions()`. Start `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }` and `standIns: { intakeStorage: sinkStorage(sink), intakeCheck: scriptedCheck({ endState: "expected", landedCommits: [C40(c)] }), intakeActions: actions.seam }`.
  2. Build fixture I of "E2E" through the CLI. Push `pr42` to `actions.performAnswers` after the binding write.
  3. Create the bare repositories of `repo` and `gated` with task 10.9.
  4. Start two `inProcessWorker` helpers (plan 09 task 09.11): `general` with `G`, its client secret, `scriptedModelRuntime(scriptedProvider(GENERAL_SCRIPT, { providerId: "anthropic", modelIdentifier: "claude-sonnet-4-5" }))` and the mapped transport; `review` with `R`, its client secret and `REVIEW_SCRIPT`.
  5. Implement the rows EI10.1 to EI10.7 in one test and in table order. Declare the test option `{ timeout: JOURNEY_TIMEOUT_MS }` with `JOURNEY_TIMEOUT_MS = 120000`, because six hosted executions exceed the default of `package.json:23`. Poll a node state every 250 ms for at most 60 s.
- Rules:
  - The internal-harness journey constructs the `Worker` in-process with the injected `ModelRuntimeFactory` and `RepositoryTransport`. Decision D15.
  - Every fixture uses the scripted fake provider, `claude-sonnet-4-5` and a complete entry form. Decision D16.
  - An initiative holds a steps job only while every current objective is terminal. `mission-service.md:489–494`.
  - The object transfer, the Intake check and the action dispatch run against the stand-ins of `gatewayFixture`. Decisions D6, D17.
  - Gap: in production the request of objective C stays unresolved until ERD 3 (`docs/reference/erd/README.md:97`); the row reaches its end state through `scriptedCheck`.
  - No row prints a secret; the client secrets stay in local variables. Plan 05 "E2E" rule.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-internal-harness.test.ts` passes every row; `pnpm run verify` passes.

## E2E

- Test files: `src/apps/server/e2e-external-harness.test.ts` (task 10.8) and `src/apps/server/e2e-internal-harness.test.ts` (tasks 10.9 and 10.E). Both run in `pnpm run verify`.
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state and `KANTHORD_ENDPOINT = fixture.endpoint`. `H` names `KANTHORD_TOKEN = fixture.token`. A machine token comes from `generateMachineToken` of task 10.7.
- Rules: setup goes through the CLI only; the state check is a CLI read, except the health report and the calls of the fakes; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON; no output holds a token, a client secret, a credential key or a `putUrl`.
- `C40(x)` names 40 characters `x`. `ctx(e, x)` names `"executionId": e, "attempt": 1, "nodeRevision": x.pinnedRevision`, where `x` is the `execution` record of the claim answer. Each `mission node create` names the `version` of `kanthord mission get <projectId>` read just before it, and an objective or a task names the `visibleRevision` of `kanthord mission node get <parent>` read just before it as `expectedParentRevision`.

Fixture X, in order (each command exits 0, token H):

1. `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
2. `kanthord project create --name harness` → `projectId`; `kanthord mission get <projectId>` → `missionId`.
3. `kanthord project binding apply <projectId> --file bindings.json` with `{ "version": 1, "bindings": { "repo": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }, "harness": { "kind": "worker", "config": { "worker": "claude@1", "instanceCount": 1 } } } }` → `repoBindingId` = `bindings.repo.id`, `harnessResource` = `bindings.harness.resourceIdentity`.
4. `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Greetings", "requirement": "Say hello", "criterion": "hello.txt exists", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": <version> }` → `I` = `revisions[0].nodeId`.
5. `kanthord mission node create <missionId> --file objective.json` with `{ "filename": "objective-a.md", "kind": "objective", "parentId": I, "expectedParentRevision": <revision>, "content": { "name": "Say hello", "requirement": "Write hello.txt", "criterion": "hello.txt exists", "verifications": ["test -f hello.txt"], "bindings": ["repo"] }, "reason": "plan", "expectedMissionVersion": <version> }` → `A`.
6. `generateMachineToken` with `projectId`, the binding name `harness` and the name `harness-a` → `T`; with the name `harness-b` → `S`.

`pull.json` names `{ "resourceIdentity": <harnessResource>, "runtimeIdentity": <rid> }`. `release.json` names `{ "furtherWork": false }`. `repoAt(x)` names `{ "kind": "repository", "bindingId": <repoBindingId>, "commit": C40(x) }`. A command with `[T]` or `[S]` uses that machine token; every other command uses H.

| Id      | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exit         | Expect                                                                                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EX10.1  | `kanthord worker register` [T]; `kanthord worker register` [S]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0, 1         | first `runtimeIdentity` matches `^worker_instance_`, `resourceIdentity` = `harnessResource`, `workerName` `claude@1`, `idempotencyKey` a ULID → `rid`; second stderr starts with `worker.instance.slot_unavailable:`                                          |
| EX10.2  | `kanthord worker heartbeat` [T]; `GET /api/healthcheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 0, 200       | first stdout `null`; `services.worker.projects.harness` = `{ "harness/<rid>": { "status": "healthy", "capability": "liveness of a registration" } }`; `services.worker.global` `{}`; `services.project.projects.harness.repo.status` `healthy`                |
| EX10.3  | `kanthord scheduler work pull --file pull.json` [T]; `kanthord worker instance get <rid>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 0, 0         | first `kind` `claimed`, `execution.nodeId` = A, `execution.attempt` 1, `execution.claimant.runtimeIdentity` = `rid` → `x1` = `execution`, `e1` = `x1.executionId`; second `activity` `executing`, `executionId` = `e1`                                        |
| EX10.4  | `kanthord worker handover <e1>` [T]; `kanthord scheduler execution get <e1>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1, 0         | first stderr starts with `worker.authorization.refused:`; second `credentials` `[]`                                                                                                                                                                           |
| EX10.5  | `kanthord mission execution pinned-revision get <e1>` [T]; `kanthord mission evidence submit <A> --file work.json` [T] with `{ ctx(e1, x1), "subject": "head commit", "assets": [{ "kind": "repository", "address": repoAt(a) }] }`; `kanthord scheduler execution release <e1> --file release.json` [T]; `kanthord mission node get <A>`                                                                                                                                                                                                                                                                                                                                                                | 0, 0, 0, 0   | first `content.verifications` `["test -f hello.txt"]`, `tasks` `[]`; second `evidence.provenance.executionId` = `e1` → `work`; third `endedAt` a number; fourth `state` `Waiting`                                                                             |
| EX10.6  | `kanthord scheduler work pull --file pull.json` [T]; `kanthord scheduler claim get <e2>` [T]; `kanthord mission node get <A>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 0, 0, 0      | first `execution.nodeId` = A, `execution.attempt` 1 → `x2` = `execution`, `e2` = `x2.executionId`; second `claimState` `running`; third `state` `Evaluating`                                                                                                  |
| EX10.7  | `kanthord mission evidence submit <A> --file run.json` [T] with `{ ctx(e2, x2), "subject": "verification run", "assets": [{ "kind": "produced", "content": { "mediaType": "text/plain", "encoding": "base64", "data": "b2s=" } }], "verification": { "testedInput": repoAt(a), "results": [{ "command": "test -f hello.txt", "exitCode": 0, "signal": null, "timedOut": false }] } }`; `kanthord mission assessment submit <A> --file pass.json` [T] with `{ ctx(e2, x2), "evidenceIds": [<run>, <work>], "childOutcomeIds": [], "result": "success", "rationale": "hello.txt exists", "testedInput": repoAt(a) }`; `kanthord scheduler claim get <e2>` [T]                                              | 0, 0, 0      | first → `run`; second `assessment.actor.kind` `execution`, `assessment.workerVersion` `claude@1`, `node.state` `Completed`, `outcome.result` `success`, `outcome.closingEvent` `assessment-passed` → `outcomeA` = `outcome.id`; third `claimState` `finished` |
| EX10.8  | `kanthord scheduler work pull --file pull.json` [T]; `kanthord mission execution objective list <e3>` [T]; `kanthord mission execution objective outcome list <e3>` [T]; `kanthord mission evidence submit <I> --file report.json` [T] with `{ ctx(e3, x3), "subject": "report", "assets": [{ "kind": "produced", "content": { "mediaType": "text/markdown", "encoding": "base64", "data": <base64 of "A is complete."> } }] }`; `kanthord scheduler execution release <e3> --file release.json` [T]; `kanthord mission node get <I>`                                                                                                                                                                    | 0 each       | first `execution.nodeId` = I → `x3` = `execution`, `e3` = `x3.executionId`; second `items[].id` `[A]`, `items[0].state` `Completed`; third `items[].id` `[outcomeA]`; fourth → `report`; sixth `state` `Waiting`                                              |
| EX10.9  | `kanthord scheduler work pull --file pull.json` [T]; `kanthord mission evidence submit <I> --file initiative-run.json` [T] with `{ ctx(e4, x4), "subject": "verification run", "assets": [{ "kind": "produced", "content": { "mediaType": "text/plain", "encoding": "base64", "data": "b2s=" } }], "verification": { "testedInput": [repoAt(m)], "results": [{ "command": "true", "exitCode": 0, "signal": null, "timedOut": false }] } }`; `kanthord mission assessment submit <I> --file initiative-pass.json` [T] with `{ ctx(e4, x4), "evidenceIds": [<initiativeRun>, <report>], "childOutcomeIds": [<outcomeA>], "result": "success", "rationale": "A is complete.", "testedInput": [repoAt(m)] }` | 0, 0, 0      | first `execution.nodeId` = I → `x4` = `execution`, `e4` = `x4.executionId`; second → `initiativeRun`; third `node.state` `Completed`, `assessment.childNodeIds` `[A]`, `outcome.result` `success`                                                             |
| EX10.10 | `kanthord mission node get <A>`; `kanthord mission node get <I>`; `kanthord scheduler queue list <projectId>`; `kanthord scheduler execution list <projectId>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0 each       | `state` `Completed` twice; `items` `[]`; four items, each `claimState` `finished` and `claimant.runtimeIdentity` = `rid`                                                                                                                                      |
| EX10.11 | `kanthord worker instance deregister <rid>` [T]; `kanthord worker instance list --project <projectId>`; `GET /api/healthcheck`; `kanthord scheduler work pull --file pull.json` [T]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 0, 0, 200, 1 | first `registered` false; second `items` `[]`; third `services.worker.projects` `{}`; fourth stderr starts with `gateway.registration.required:`                                                                                                              |

Fixture I, in order (each command exits 0, token H):

1. `kanthord credential create --file anthropic.json` with `{ "name": "anthro-1", "platform": "anthropic", "metadata": null, "secret": { "key": "e2e-journey-secret" } }`; `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`; `kanthord credential create --file store.json` with `{ "name": "store", "platform": "s3", "metadata": { "endpoint": "https://s3.example.com", "bucket": "evidence", "region": "eu-central-1" }, "secret": { "accessKeyId": "AKIAEXAMPLE", "secretAccessKey": "example-secret" } }`.
2. `kanthord worker agent enablement put swe@1 --file enablement.json` with `{ "agentProviders": [{ "name": "default", "provider": "anthropic", "credential": "anthro-1" }], "defaultConfiguration": { "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" } }`; the same for `re@1`.
3. `kanthord project create --name journey` → `projectId`; `kanthord mission get <projectId>` → `missionId`.
4. `kanthord project binding apply <projectId> --file bindings.json` with `{ "version": 1, "bindings": { "repo": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }, "gated": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/gated.git", "strategy": { "baseBranch": "main", "action": { "name": "pull_request", "follows": { "type": "assessment_passed" } } }, "credential": "github" } }, "store": { "kind": "storage", "config": { "available": true, "endpoint": "https://s3.example.com", "bucket": "evidence", "region": "eu-central-1", "prefix": "kanthord", "credential": "store" } }, "general": { "kind": "worker", "config": { "worker": "general@1", "instanceCount": 1, "entries": [SWE] } }, "review": { "kind": "worker", "config": { "worker": "reviewer@1", "instanceCount": 1, "entries": [RE] } } } }`, where `SWE` is `{ "agent": "swe@1", "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" }` and `RE` is the same entry with `"agent": "re@1"` → `repoBindingId`, `gatedBindingId`, `gatedResource`.
5. `kanthord mission node create <missionId>` with the initiative of fixture X step 4 → `I`; the objective of fixture X step 5 with `"bindings": ["repo", "store"]` → `A`; the task `{ "filename": "task-a.md", "kind": "task", "parentId": A, "expectedParentRevision": <revision>, "content": { "name": "Write hello", "requirement": "Write hello.txt", "criterion": "hello.txt holds hello", "verifications": ["grep -q hello hello.txt"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": <version> }` → `TA`; the objective with `"filename": "objective-c.md"` and `"bindings": ["gated"]` → `C`; the task with `"filename": "task-c.md"` under C → `TC`.
6. `kanthord mission node priority set <A> --file priority.json` with `{ "value": 5, "expectedMissionVersion": <version> }`; the same for C with the value 4.
7. `generateMachineToken` with `projectId`, the binding name `general` and the name `general-a` → `G` and its client secret; with `projectId`, the binding name `review` and the name `review-a` → `R` and its client secret.

`pr42` names `{ "kind": "pull_request", "resourceIdentity": <gatedResource>, "number": 42 }`. `JUDGED` names the text `kanthord-judgement: {"criterionMet": true, "rationale": "hello.txt holds hello"}`. `PASSED` names the text `kanthord-judgement: {"result": "success", "rationale": "hello.txt exists and holds hello; task met."}`. `GENERAL_SCRIPT` names eight turns: a `bash` call `printf hello > hello.txt`, an `evidence-upload` call `{ "path": "hello.txt" }`, the text `done`, `JUDGED` (objective A); a `bash` call `printf hello > hello.txt`, the text `done`, `JUDGED` (objective C); the text `A and C are complete.` (the report of I). `REVIEW_SCRIPT` names three turns `PASSED` (A, C and I).

| Id     | Commands                                                                                                                                                                                                                                                                                             | Exit       | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EI10.1 | Start `general` and `review`; wait for both ready records; `kanthord worker instance list --project <projectId>`                                                                                                                                                                                     | —, 0       | `general` records `resourceIdentity` `worker:kanthord:general`, `workerName` `general@1` → `ridG`; `review` records `worker:kanthord:review`, `reviewer@1` → `ridR`; the list holds `ridG` and `ridR`, each `registered` true                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| EI10.2 | Poll `kanthord mission node get <A>` until `Completed`; `kanthord scheduler execution list <projectId> --node <A>`; `kanthord mission evidence list <A> --attempt 1`; `kanthord mission assessment list <A>`; `kanthord mission outcome list <A>`; `remoteHead(repoBare, "refs/heads/kanthord/<A>")` | 0 each, —  | two items, each `finished`, with `items[].claimant.runtimeIdentity` `[ridR, ridG]`; three evidences: one `object` asset with `subject` `hello.txt`, `size` 5, `mediaType` `application/octet-stream` and `publishedAt` a number, one `repository` asset of `repoBindingId` at the remote head of `kanthord/<A>`, and one `verification` whose `results` hold `test -f hello.txt` and `grep -q hello hello.txt` with `exitCode` 0 and whose `testedInput.commit` is that head; one `success` with `workerVersion` `reviewer@1` and `evidenceIds` of the verification and the head evidence; one outcome `success` with `closingEvent` `assessment-passed` → `outcomeA`; the head of `main` is unchanged |
| EI10.3 | Poll `kanthord mission node get <C>` until `External.Requested`; `kanthord mission evidence list <C> --attempt 1`; `kanthord mission external-action list <C> --attempt 1`; `actions.performCalls`                                                                                                   | 0 each, —  | the evidences hold one `repository` asset of `gatedBindingId` at the remote head of `kanthord/<C>`, one `verification` and one request evidence with `requirementKey` `gated.pull_request` and the address `pr42`; `items[0].resolution` `unresolved`; one call with `operands` = `{ "nodeBranch": "kanthord/" + C, "baseBranch": "main", "commit": <remote head of kanthord/C>, "reusedAddress": null }`                                                                                                                                                                                                                                                                                              |
| EI10.4 | `kanthord mission get <projectId>` → M; `kanthord mission node check <C> --file check.json` with `{ "expectedMissionVersion": M }`; `kanthord mission outcome list <C>`                                                                                                                              | 0, 0, 0    | `results[0].resolution` `expected-end`; `items[0].closingEvent` `external-success` → `outcomeC`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| EI10.5 | Poll `kanthord mission node get <I>` until `Completed`; `kanthord scheduler execution list <projectId> --node <I>`; `kanthord mission evidence list <I> --attempt 1`; `kanthord mission evidence asset content get <asset of the report>`; `kanthord mission assessment list <I>`                    | 0 each     | two items, each `finished`, with `items[].claimant.runtimeIdentity` `[ridR, ridG]`; two evidences: a `produced` report of `text/markdown` and a `verification` whose `results` hold `true` with `exitCode` 0 and whose `testedInput` holds the heads of `main` of both bare repositories as a set; the content `data` decodes to `A and C are complete.`; one `success` whose `childOutcomeIds` equal `[outcomeA, outcomeC]` as a set                                                                                                                                                                                                                                                                  |
| EI10.6 | The calls of both fakes; the collected logs of both workers                                                                                                                                                                                                                                          | —          | `general` records eight calls and `review` three; each call holds the key `e2e-journey-secret`; the tool result of `evidence-upload` holds `evidenceId`, `assetId` and `uri` alone, with `uri` starting with `s3://evidence/kanthord/`; no call message holds `putUrl`, the sink endpoint or `X-Amz`; no log line holds `G`, `R`, a client secret or `e2e-journey-secret`                                                                                                                                                                                                                                                                                                                              |
| EI10.7 | `general.worker.stop()`; `review.worker.stop()`; `kanthord worker instance list --project <projectId>`; `kanthord scheduler queue list <projectId>`                                                                                                                                                  | —, —, 0, 0 | both stops answer null; `items` `[]` twice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

No row asserts a code of the mark `code: proposed`. EX10.2 and EX10.11 need task 10.4; EX10.1 and EI10.1 need task 09.1 (ruled 2026-09-30).

## Blockers

None open. The debate engine settled one gap (`.dev/erd-02/decisions-log.md` 2026-09-30 "plan 10", ruled 2026-09-30):

- DEBATE: the source of the project name and the worker binding name of a registration entry of the health report - rounds:1 - verdict: CHANGE to (b), extend the answer of the existing seam `ProjectBindings.workerBindingOf` with `name` and `projectName`, and let the Worker Service build the entry in its own `resourceInventory`; a new Project read `projectNameOf` is a new collaboration against the plan-set constraint; a missing binding answer takes the owner-failure path into `missingInventories`, and tests cover the name against the identity, the encoded name, both sides of the window and the unchanged provider entries.

Four alignments are plan work:

- The brief of the orchestrator names an envelope open in the external-harness journey. No credential reaches an external harness (`custody.md:74`), so EX10.4 asserts the refusal of plan 05 task 05.4, and the journey opens no envelope. The in-process journey opens its envelopes inside the `worker` application (plan 09 task 09.8).
- Plan 03 task 03.15 omits `SchedulerClaims.activityOf` from its replacement steps. Task 10.1 step 3 wires it when the literal stands.
- The health report of the internal-harness journey would run the real model-list probe of `anthro-1` (`src/custody/service.ts:162–181`), so the report rows run in the external-harness journey alone, with the custody inventory overridden.
- The CLI pages hold five rows that no ERD 1 or ERD 2 plan builds. Task 10.6 exempts each by name, and a later plan that builds one removes its exemption.
