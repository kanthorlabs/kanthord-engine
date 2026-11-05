# Plan 02: Worker Service — the worker machine

## Scope

This plan adds the worker machine of decision D2 and the machine of an instance of decision D3 to the Worker Service. It adds the machine configuration of decision D5 and the CLI commands of the machine. No credential copy uses a machine yet. Plan 03 adds the machine copies.

Out of scope:

- The credential rules of a machine holder. Plan 03 adds them.
- The `credentials` of `worker.machine.get` and the connection of the machine key to the custody port `InstanceKeys`. Plan 03 adds them.
- The use of the machine key in the `worker` application, and its claim gate. Plan 04 adds them. This plan adds only the module that reads and writes the machine configuration.
- The dashboard. Plan 06 adds the machine screens.

## Model

Sonnet at high effort. The change stays in the Worker Service, its CLI and one configuration module. It copies the pattern of the instance record.

## Sources

- Root pull request of plan 01: `worker-service.impl.md` "Worker machines", "The instance record", "The operations of an instance", "The instance exchange", "The machine configuration"; `docs/reference/worker/machine.html`.
- `src/worker/migrations.ts:16-28` — the table `worker_instance`.
- `src/worker/contract.ts:946-960`, `:968`, `:990-1022`, `:1289-1343`, `:1497-1521` — the error codes, the reserved names, the instance schemas, `worker.instance.create` and `worker.instance.heartbeat`.
- `src/worker/instances.ts:437-469`, `:940-985` — the create, the revision check and the key insert of an instance.
- `src/worker/instance-rows.ts:33-107` — the row reads and `fingerprintTaken`.
- `src/worker/instance-operations.ts:171-178` — `declareInstances`.
- `src/worker/service.ts:373-380` — `instanceKeyOf`.
- `src/apps/worker/instance-config.ts:19-60` — the instance configuration source and file path.
- `src/apps/cli/worker-instance.ts` — the instance CLI with `--output` and `join`.
- `src/agent/environment.ts:15-30` — `childEnvironment`.

## Depends on

The approval of the root pull request of plan 01. Start from `origin/main` of `kanthorlabs/kanthord-engine`. Plan 05 runs at the same time in other files. When plan 05 merges first, rebase on it and regenerate `static/` in task 02.7.

## Provides

- The table `worker_machine`, the column `worker_instance.machine` and the field `machine` of the instance record and of the heartbeat answer.
- `worker.machine.create`, `worker.machine.list`, `worker.machine.get`, `worker.machine.rotate` and `worker.machine.archive`. `worker.machine.get` answers the machine record and `instances`.
- `WorkerService.machineKeyOf(tx, name)`: the key of a live machine, or null.
- `WorkerService.machineOf(tx, instanceName)`: the machine name of a live `worker` instance, or null.
- `WorkerService.connectedInstancesOf(name)`: the live instances of a machine with a current connection, newest heartbeat first.
- `src/apps/worker/machine-config.ts`: `readMachineConfiguration(env, name)` and `writeMachineFile(env, configuration, force)`.
- The CLI commands `kanthord worker machine create|list|get|rotate|archive|join` and `kanthord worker instance create --machine <name>`.

## Tasks

### 02.1 Write the tests of the machine

- Files: `src/worker/machines.test.ts` (new), `src/worker/instances.test.ts` (edit), `src/apps/worker/machine-config.test.ts` (new), `src/apps/server/cli-worker.test.ts` (edit)
- Do:
  1. In `machines.test.ts`, copy the fixture pattern of `instances.test.ts`. Add one test for each operation and each refusal of the machine error table of plan 01.
  2. Cover a create with `public_key`, and a create without it that answers `machine_configuration` with `Cache-Control: no-store`.
  3. Cover `name_invalid`, `key_invalid`, and `name_conflict` and `key_conflict` against a machine and against an instance.
  4. Cover the list with `instance_count`, the get with `instances`, and the rotate with `revision_conflict` and `archived`.
  5. Cover the archive with `in_use` and its `details.instances`.
  6. Add a test that `machineKeyOf` answers the current key after a rotate and null after an archive.
  7. Add a test that `machineOf` answers the machine of a `worker` instance and null at the `server` placement.
  8. Add a test that `connectedInstancesOf` orders by the newest heartbeat, then by name.
  9. In `instances.test.ts`, add tests for `machine` of `worker.instance.create`. Each case answers 400 `worker.instance.machine_invalid`: an absent machine at the `worker` placement, an unknown machine, an archived machine, and a machine at the `server` placement.
  10. A valid machine gives the record `machine`. A create of a name that a machine holds answers 409 `worker.instance.name_conflict`.
  11. Add a test that the heartbeat answer of a `worker` instance holds `machine`.
  12. Add `machine` to every `worker` create of the current tests. Create one machine in the fixture for it.
  13. In `machine-config.test.ts`, copy the tests of `instance-config.test.ts`. Cover the env source, the file source, the conflict, the absence with its paths, an invalid value and a file name mismatch.
  14. In `cli-worker.test.ts`, add a test of `worker machine create --output`, `worker machine join` and `worker instance create --placement worker --machine <name>`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/machines.test.ts src/worker/instances.test.ts src/apps/worker/machine-config.test.ts` fails on the new tests only.

### 02.2 Add the schema and the contract

- Files: `src/worker/migrations.ts`, `src/worker/contract.ts` (edit)
- Do:
  1. In `src/worker/migrations.ts:16-28`, add `machine TEXT` to `CREATE TABLE worker_instance`.
  2. Add `CREATE TABLE worker_machine (id, name, revision, public_key, fingerprint, created_at, ended_at)`. `public_key` and `fingerprint` are `NOT NULL`.
  3. Add the unique indexes `worker_machine_name_revision` and `worker_machine_fingerprint`. Add no migration (decision D16).
  4. In `src/worker/contract.ts`, add `machine: z.string().min(1).nullable()` to `instanceRecordSchema` (`:995-1005`). Add the optional `machine` to the create body (`:1329-1338`).
  5. Add `machine: z.string().min(1).nullable()` to the answer of `worker.instance.heartbeat` (`:1497-1521`).
  6. Add `machineRecordSchema`, `machineConfigurationSchema` (`{ name, private_key }`) and `machineConfigurationValue` after the instance schemas (`:1015-1022`).
  7. Add `machineOperations` with the five operations of decision D2. Copy the fields of `instanceOperations` (`:1317-1450`). The path parameter is `machine_name`.
  8. Add `machineOperations` to the worker operations (`:1569`).
  9. Add these codes to `WorkerErrorCode` (`:946-960`): `MachineNameInvalid` to `MachineInUse`, `InstanceMachineInvalid`, `MachineConfigInvalid`, `MachineConfigAbsent` and `MachineConfigConflict`.
- Cite: D2, D3, D5.
- Verify: `pnpm run typecheck`.

### 02.3 Implement the machine

- Files: `src/worker/machine-rows.ts` (new), `src/worker/machines.ts` (new), `src/worker/machine-operations.ts` (new), `src/worker/instance-rows.ts`, `src/worker/instances.ts`, `src/worker/service.ts` (edit)
- Do:
  1. In `machine-rows.ts`, copy the reads and the writes of `instance-rows.ts` for `worker_machine`: the latest, the live, the insert, the end and the list.
  2. Change `fingerprintTaken` (`src/worker/instance-rows.ts:96-107`) to read both tables. Add `nameTaken(tx, name)` that reads both tables.
  3. In `machines.ts`, add `WorkerMachines` with `create`, `list`, `get`, `rotate` and `archive`. Copy the key preparation of `WorkerInstances` (`src/worker/instances.ts:437-469`, `:961-985`).
  4. A create without `public_key` generates the key pair and answers `machine_configuration` once. It clears the key buffer in `finally`.
  5. The archive refuses with 409 `worker.machine.in_use` and `details.instances` while a live instance names the machine.
  6. The archive calls the dependency `archiveHeld(tx, machine, now)`, as the instance archive does (`src/worker/instances.ts:578`).
  7. In `machine-operations.ts`, add `declareMachines(registry, dependencies)` after the pattern of `declareInstances` (`src/worker/instance-operations.ts:171-178`). Call it beside `declareInstances` in `src/worker/service.ts`.
  8. In `WorkerInstances.create` (`src/worker/instances.ts:437-469`), validate `machine` by decision D3 and store it. Refuse a taken name through `nameTaken`.
  9. Answer `machine` in the heartbeat of a `worker` instance.
  10. Add `machineKeyOf`, `machineOf` and `connectedInstancesOf` to `WorkerService`, beside `instanceKeyOf` (`src/worker/service.ts:373-380`).
  11. `connectedInstancesOf` reads the connection book of `WorkerInstances.connected` (`src/worker/instances.ts:408`). Leave `instanceKeyOf` unchanged. Plan 03 joins both keys in the custody port.
- Cite: D2, D3.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/machines.test.ts src/worker/instances.test.ts` passes.

### 02.4 Add the machine configuration module

- Files: `src/apps/worker/machine-config.ts` (new), `src/agent/environment.ts` (edit)
- Do:
  1. Copy the source rules of `src/apps/worker/instance-config.ts` for the machine configuration. Use the variable `KANTHORD_MACHINE_CONFIG` and the file `machines/<name>.yaml`.
  2. The file has mode `0600` in a directory with mode `0700`.
  3. Export `readMachineConfiguration(env, name)`. It answers `worker.machine.config_absent`, `worker.machine.config_conflict` or `worker.machine.config_invalid` by decision D5.
  4. Check `name` with `instanceNameSchema` before the function builds a path. A name that breaks it answers `worker.machine.config_invalid`.
  5. Export `writeMachineFile(env, configuration, force)`.
  6. Add `KANTHORD_MACHINE_CONFIG` to the removed names of `childEnvironment` (`src/agent/environment.ts:15-30`). Add one assertion to its test.
- Cite: D5.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/machine-config.test.ts src/agent/environment.test.ts` passes.

### 02.5 Add the CLI commands

- Files: `src/apps/cli/worker-machine.ts` (new), `src/apps/cli/worker.ts`, `src/apps/cli/worker-instance.ts`, `src/apps/cli/completeness.test.ts` (edit)
- Do:
  1. Copy the commands of `worker-instance.ts` for `worker machine create <name> [--output] [--force]`, `list` and `get <name>`.
  2. Add `rotate <name> --expected-revision <n> [--output] [--force]`, `archive <name> --expected-revision <n>` and `join [--force]`.
  3. `create` and `rotate` generate the key pair on the computer that runs the CLI. They send only `public_key`.
  4. With `--output`, they write the machine file through `writeMachineFile`. Without it, they print the answer JSON with `machine_configuration`.
  5. Like `instance create`, they refuse a standard output that is no terminal (`src/apps/cli/worker-instance.ts:143`). `join` reads one configuration value from standard input.
  6. Register the group in `src/apps/cli/worker.ts:452`, beside `addWorkerInstanceCommands`.
  7. Add `--machine <name>` to `worker instance create` and send it as `machine`.
  8. In `src/apps/cli/completeness.test.ts:118-148`, raise `PAGE_COUNTS.worker`, `DOCUMENTED_COUNT`, `IMPLEMENTED_COUNT` and `OPERATION_COUNT` by the added commands and operations.
- Cite: D2, D5, D15.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/server/cli-worker.test.ts src/apps/cli/completeness.test.ts` passes.

### 02.6 Update the CLI page

- Files: `docs/cli/worker.md`, `docs/cli/other.md` (edit)
- Do:
  1. Add the six machine commands to `## Command inventory` (`docs/cli/worker.md:105`).
  2. Add the section "Worker machines" after "Worker instances" (`docs/cli/worker.md:563`). Add one subsection for each machine command, after the pattern of `instance create` to `join` (`:590-742`).
  3. Add `--machine <name>` to `instance create` (`:590`). Add `machine` to the instance record and to the heartbeat answer.
  4. Add each new code to the error table (`:877`) with its HTTP status and condition. Extend the rows `worker.instance.name_conflict` and `worker.instance.key_conflict` (`:938-939`) to name a machine.
  5. In `docs/cli/other.md`, section `serve worker` (`:717-760`), add the machine configuration to the source table (`:744-747`). Add `KANTHORD_MACHINE_CONFIG` to the child environment sentence (`:752-753`).
- Cite: root `AGENTS.md` "Contracts" (every error code on the CLI page).
- Verify: `pnpm exec prettier --check docs/cli/worker.md docs/cli/other.md`.

### 02.7 Regenerate the OpenAPI document

- Files: `static/` (generated)
- Do: run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit the result.
- Verify: `git status --porcelain static/` prints nothing after the commit.

### 02.E Run the gate

- Do: run the gate row 02 of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

No new row. Plan 08a moves the live `worker` placement e2e to a dev machine and moves the root `engine` pointer right after this plan merges.

## Blockers

None.
