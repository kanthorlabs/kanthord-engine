# Plan 08: CLI app

## Scope

This plan checks the completeness of the CLI dispatcher after plans 01–06 register
every command group and plan 07 assembles the running server.

Every command group lives in the plan of its service. Plan 08 adds no command group.

In scope:

- The operation ID uniqueness assertion across the six contracts.
- Verifying the help-only loop holds only `CommandName.Tracking` after plans 01–06
  remove every ERD 1 stub.
- The help tree of every command group.

Out of scope:

- Any CLI command group (each lives in the plan of its service).
- Per D12: no Tracking or Intake stub is added; no BLOCKED command is registered;
  no command outside ERD 1 is added.

## Sources

- `engine/docs/cli/credential.md` — credential command inventory (9 commands).
- `engine/docs/cli/project.md` — project command inventory (11 commands).
- `engine/docs/cli/mission.md` — mission command inventory (19 commands).
- `engine/docs/cli/worker.md` — worker agent enablement command inventory (8 commands).
- `engine/docs/cli/scheduler.md` — scheduler command inventory (2 commands).
- `engine/docs/cli/common-flags.md` — flag resolution order, pagination contract,
  single-use enforcement.
- `docs/brainstorm/architecture.impl.md:339–349` — error code form (3+ parts).
- `docs/reference/erd/01-setup.md` — ERD 1 table and constraint rules.
- `engine/AGENTS.md` — CLI imports contracts and adapter only.
- `engine/.agents/plan/erd-01-setup/00-index.md` — plan order and seam ownership.
- `engine/.agents/plan/erd-01-setup/01-custody.md` — `custodyOperations` keys (short, no prefix):
  `create`, `list`, `get`, `rotate`, `update_metadata`, `revoke`, `login`,
  `login_code`, `login_status`.
- `engine/.agents/plan/erd-01-setup/02-scheduler-job.md` — `schedulerOperations` keys (camelCase):
  `queueList`, `queuePeek`.
- `engine/.agents/plan/erd-01-setup/03-worker-agent-enablement.md` — `workerOperations` keys
  (dotted, no prefix): `agent.enablement.list`, `agent.enablement.get`,
  `agent.enablement.put`, `agent.enablement.enable`, `agent.enablement.disable`,
  `agent.enablement.remove`, `agent.enablement.provider.add`,
  `agent.enablement.provider.remove`.
- `engine/.agents/plan/erd-01-setup/05-project-service.md` — `projectOperations` keys (short,
  no prefix): `create`, `list`, `get`, `rename`, `binding.list`, `binding.get`,
  `bindingSet.get`, `bindingSet.write`, `bindingRevision.list`,
  `agentConfiguration.list`, `agentConfiguration.get`.
- `engine/.agents/plan/erd-01-setup/06-mission-service.md` — `missionOperations` keys (short,
  no prefix). `export` and `import.preview` are `mutation: false`.
- `engine/src/apps/cli/index.ts` — dispatcher and help-only loop.
- `engine/src/apps/server/cli-support.ts` — `kanthord(args, env)` subprocess helper.

## Depends on

- Plan 01 — `addCredentialCommand` registered; `custodyOperations` exported;
  `src/apps/server/cli-support.ts` created.
- Plan 02 — `addSchedulerCommand` registered; `schedulerOperations` exported.
- Plan 03 — worker agent enablement commands registered; `workerOperations` exported.
- Plan 05 — `addProjectCommand` registered; `projectOperations` exported.
- Plan 06 — `addMissionCommand` registered; `missionOperations` exported.
- Plan 07 — server assembled; `gatewayOperations` exported; every ERD 1 help-only
  stub replaced.

## Provides

None. Plan 08 is a terminal layer.

## Operation key to command mapping

| CLI group  | CLI command                        | `httpClient` key                     | Operation ID                              |
| ---------- | ---------------------------------- | ------------------------------------ | ----------------------------------------- |
| credential | `create`                           | `"create"`                           | `credential.create`                       |
| credential | `list`                             | `"list"`                             | `credential.list`                         |
| credential | `get`                              | `"get"`                              | `credential.get`                          |
| credential | `rotate`                           | `"rotate"`                           | `credential.rotate`                       |
| credential | `update-metadata`                  | `"update_metadata"`                  | `credential.update_metadata`              |
| credential | `revoke`                           | `"revoke"`                           | `credential.revoke`                       |
| credential | `login`                            | `"login"`                            | `credential.login`                        |
| credential | `login-code`                       | `"login_code"`                       | `credential.login_code`                   |
| credential | `login-status`                     | `"login_status"`                     | `credential.login_status`                 |
| project    | `create`                           | `"create"`                           | `project.create`                          |
| project    | `list`                             | `"list"`                             | `project.list`                            |
| project    | `get`                              | `"get"`                              | `project.get`                             |
| project    | `rename`                           | `"rename"`                           | `project.rename`                          |
| project    | `binding list`                     | `"binding.list"`                     | `project.binding.list`                    |
| project    | `binding get`                      | `"binding.get"`                      | `project.binding.get`                     |
| project    | `binding export`                   | `"bindingSet.get"`                   | `project.bindingSet.get`                  |
| project    | `binding apply`                    | `"bindingSet.write"`                 | `project.bindingSet.write`                |
| project    | `binding revision list`            | `"bindingRevision.list"`             | `project.bindingRevision.list`            |
| project    | `agent list`                       | `"agentConfiguration.list"`          | `project.agentConfiguration.list`         |
| project    | `agent get`                        | `"agentConfiguration.get"`           | `project.agentConfiguration.get`          |
| mission    | `get`                              | `"get"`                              | `mission.get`                             |
| mission    | `node list`                        | `"node.list"`                        | `mission.node.list`                       |
| mission    | `node get`                         | `"node.get"`                         | `mission.node.get`                        |
| mission    | `node revision list`               | `"node.revision.list"`               | `mission.node.revision.list`              |
| mission    | `node revision get`                | `"node.revision.get"`                | `mission.node.revision.get`               |
| mission    | `edge list`                        | `"edge.list"`                        | `mission.edge.list`                       |
| mission    | `node retire preview`              | `"node.retire.preview"`              | `mission.node.retire.preview`             |
| mission    | `export`                           | `"export"`                           | `mission.export`                          |
| mission    | `node create`                      | `"node.create"`                      | `mission.node.create`                     |
| mission    | `node update`                      | `"node.update"`                      | `mission.node.update`                     |
| mission    | `node move`                        | `"node.move"`                        | `mission.node.move`                       |
| mission    | `dependency add`                   | `"dependency.add"`                   | `mission.dependency.add`                  |
| mission    | `dependency remove`                | `"dependency.remove"`                | `mission.dependency.remove`               |
| mission    | `criterion set`                    | `"criterion.set"`                    | `mission.criterion.set`                   |
| mission    | `node rebind`                      | `"node.rebind"`                      | `mission.node.rebind`                     |
| mission    | `node priority set`                | `"node.priority.set"`                | `mission.node.priority.set`               |
| mission    | `node retire`                      | `"node.retire"`                      | `mission.node.retire`                     |
| mission    | `import preview`                   | `"import.preview"`                   | `mission.import.preview`                  |
| mission    | `import apply`                     | `"import.apply"`                     | `mission.import.apply`                    |
| scheduler  | `queue list`                       | `"queueList"`                        | `scheduler.queue.list`                    |
| scheduler  | `queue peek`                       | `"queuePeek"`                        | `scheduler.queue.peek`                    |
| worker     | `agent enablement list`            | `"agent.enablement.list"`            | `worker.agent.enablement.list`            |
| worker     | `agent enablement get`             | `"agent.enablement.get"`             | `worker.agent.enablement.get`             |
| worker     | `agent enablement put`             | `"agent.enablement.put"`             | `worker.agent.enablement.put`             |
| worker     | `agent enablement enable`          | `"agent.enablement.enable"`          | `worker.agent.enablement.enable`          |
| worker     | `agent enablement disable`         | `"agent.enablement.disable"`         | `worker.agent.enablement.disable`         |
| worker     | `agent enablement remove`          | `"agent.enablement.remove"`          | `worker.agent.enablement.remove`          |
| worker     | `agent enablement provider add`    | `"agent.enablement.provider.add"`    | `worker.agent.enablement.provider.add`    |
| worker     | `agent enablement provider remove` | `"agent.enablement.provider.remove"` | `worker.agent.enablement.provider.remove` |

## Tasks

### 08.14 Complete dispatcher

- Files: `src/apps/cli/index.ts` (edit)
- Do:
  1. Verify that plans 01–06 have added their operation imports in
     `src/apps/cli/index.ts`. Do not add any import.
  2. Verify the spread at `src/apps/cli/index.ts:298` includes all six operation
     sets added by plans 01–06. Do not modify it.
  3. Add an operation ID uniqueness assertion that checks across all six contracts:
     ```ts
     const allOperationIds = [
       ...Object.values(gatewayOperations).map((op) => op.id),
       ...Object.values(workerOperations).map((op) => op.id),
       ...Object.values(custodyOperations).map((op) => op.id),
       ...Object.values(projectOperations).map((op) => op.id),
       ...Object.values(missionOperations).map((op) => op.id),
       ...Object.values(schedulerOperations).map((op) => op.id),
     ];
     assert.equal(
       new Set(allOperationIds).size,
       allOperationIds.length,
       "operation ID collision",
     );
     ```
  4. Verify the help-only loop at `src/apps/cli/index.ts:164` contains only
     `CommandName.Tracking`. Plans 01–06 remove their stubs when they register
     their command groups. Do not modify the loop.
  5. Verify the count assertion
     `assert.equal(names.length, Object.keys(CommandName).length)` still passes.
     Do not modify it.
- Rules:
  - No `generate:openapi` step (D13; plan 07 owns it).
  - No Tracking or Intake stub is added (D12).
  - The ID uniqueness assertion checks globally unique operation IDs, not client
    keys. Client keys are per-service scoped; IDs are globally unique.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - `kanthord --help` output includes `credential`, `project`, `mission`, `scheduler`.
  - `kanthord credential --help` exits 0 and shows 9 leaves.
  - `kanthord project --help` exits 0 and shows `create`, `list`, `get`, `rename`,
    `binding`, `agent`.
  - `kanthord scheduler queue --help` exits 0 and shows `list` and `peek`.
  - Operation ID uniqueness assertion passes at startup.

### 08.E E2E proof

- Files: `src/apps/server/e2e-cli.test.ts` (new)
- Do: Create the test file with the scenarios in `## E2E`.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-cli.test.ts`
  passes and `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-cli.test.ts` (runs in `pnpm run verify`).
- Harness: `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI
  as a subprocess with disposable XDG state. No running server is needed; all rows
  test help output. The operation ID uniqueness assertion (08.14 step 3) runs at
  every CLI invocation, so exit 0 proves it passed.
- Rules: each row invokes `kanthord(args, {})` without endpoint or token; the exit
  code must be 0; stdout must contain the listed substrings.

| Id     | Commands                                           | Exit | Expect                                                                                                                       |
| ------ | -------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| E08.1  | `kanthord --help`                                  | 0    | stdout contains `credential`, `project`, `mission`, `scheduler`, `worker`                                                    |
| E08.2  | `kanthord credential --help`                       | 0    | stdout lists 9 leaves: `create`, `list`, `get`, `rotate`, `update-metadata`, `revoke`, `login`, `login-code`, `login-status` |
| E08.3  | `kanthord worker --help`                           | 0    | stdout contains `agent`                                                                                                      |
| E08.4  | `kanthord worker agent --help`                     | 0    | stdout contains `enablement`                                                                                                 |
| E08.5  | `kanthord worker agent enablement --help`          | 0    | stdout contains `list`, `get`, `put`, `enable`, `disable`, `remove`, `provider`                                              |
| E08.6  | `kanthord project --help`                          | 0    | stdout contains `create`, `list`, `get`, `rename`, `binding`, `agent`                                                        |
| E08.7  | `kanthord project binding --help`                  | 0    | stdout contains `list`, `get`, `export`, `apply`, `revision`                                                                 |
| E08.8  | `kanthord project agent --help`                    | 0    | stdout contains `list`, `get`                                                                                                |
| E08.9  | `kanthord mission --help`                          | 0    | stdout contains `get`, `node`, `edge`, `dependency`, `criterion`, `export`, `import`                                         |
| E08.10 | `kanthord scheduler --help`                        | 0    | stdout contains `queue`                                                                                                      |
| E08.11 | `kanthord scheduler queue --help`                  | 0    | stdout contains `list`, `peek`                                                                                               |
| E08.12 | `kanthord worker agent enablement provider --help` | 0    | stdout contains `add`, `remove`                                                                                              |
| E08.13 | `kanthord mission node --help`                     | 0    | stdout contains `list`, `get`, `create`, `update`, `move`, `revision`, `retire`, `rebind`, `priority`                        |
| E08.14 | `kanthord mission import --help`                   | 0    | stdout contains `preview`, `apply`                                                                                           |

## Blockers

- **B1** - status:FIXED - action:YES - BindingSet export/apply schema compatibility - `project.bindingSet.get` answers exactly the `bindingSetWriteInputSchema` shape (Plan 05), so `binding export` output applies unchanged. - fix: none left. - why: `engine/docs/cli/project.md:232–236` rules the export shape.

- **B2** - status:FIXED - action:YES - OAuth login response fields - `credential.login` answers `address` always and `code` in device mode, because the handler awaits the address before it answers (Plan 01). The CLI never polls: `login-status` "does not poll until completion" (`engine/docs/cli/credential.md:239`). - fix: `login` prints `sessionId`, `address`, `code`, `expiresAt` and the key, one per line; a `null` code prints an empty line, so each value keeps its line position. - why: `engine/docs/cli/credential.md:210–212` rules the line output.

- **B3** - status:FIXED - action:YES - Commander `node retire` sub-tree conflict -
  `node retire preview <node-id>` and `node retire <node-id>` share the `node retire`
  prefix. Commander routes to a subcommand when the first argument matches a registered
  subcommand name. Because `preview` is a valid first argument to `node retire`, users
  who type `node retire preview ...` reach the preview command, not the retire-with-arg
  form. Users who type `node retire <node-id>` reach the leaf command. No valid node ID
  starts with the string `"preview"`: every node identity has the form `node_<ulid>`
  where `<ulid>` is a 26-character Crockford base-32 string; none can equal `"preview"`.
  Plan 06 implements both leaves as siblings; the visual asymmetry in help output is
  acknowledged and acceptable. - fix: No code change required; sibling-leaf layout in
  plan 06 is the resolved design. - why: Runtime routing is unambiguous; no ULID
  matches the string `"preview"`.
