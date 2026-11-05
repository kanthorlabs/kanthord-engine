# Plan 02: Worker Service — the worker host

## Scope

This plan adds the worker host of decision D2 and the host of an instance of decision D3 to the Worker Service. It adds the host configuration of decision D5 and the CLI commands of the host. No credential copy uses a host yet. Plan 03 adds the host copies.

Out of scope:

- The credential rules of a host holder. Plan 03 adds them, also the `credentials` of `worker.host.get` and the connection of the host key to the custody port `InstanceKeys`.
- The use of the host key in the `worker` application. Plan 04 adds it. This plan adds only the module that reads and writes the host configuration, for `worker host join`.
- The dashboard. Plan 06 adds the host screens.

## Model

Sonnet at high effort. The change stays in the Worker Service, its CLI and one configuration module. It copies the pattern of the instance record.

## Sources

- Root pull request of plan 01: `worker-service.impl.md` "Worker hosts", "The instance record", "The operations of an instance", "The host configuration"; `docs/reference/worker/host.html`.
- `src/worker/migrations.ts:16-28` — the table `worker_instance`.
- `src/worker/contract.ts:946-960`, `:968`, `:990-1022`, `:1289-1343` — the error codes, the reserved names, the instance schemas and `worker.instance.create`.
- `src/worker/instances.ts:437-469`, `:940-985` — the create, the revision check and the key insert of an instance.
- `src/worker/instance-rows.ts:33-107` — the row reads and `fingerprintTaken`.
- `src/worker/instance-operations.ts:171-178` — `declareInstances`.
- `src/worker/service.ts:373-380` — `instanceKeyOf`.
- `src/apps/worker/instance-config.ts:19-60` — the instance configuration source and file path.
- `src/apps/cli/worker-instance.ts` — the instance CLI with `--output` and `join`.
- `src/agent/environment.ts:15-30` — `childEnvironment`.

## Depends on

The approval of the root pull request of plan 01. Start from `origin/main` of `kanthorlabs/kanthord-engine`. Plan 05 runs at the same time in other files.

## Provides

- The table `worker_host`, the column `worker_instance.host` and the field `host` of the instance record.
- `worker.host.create`, `worker.host.list`, `worker.host.get`, `worker.host.rotate` and `worker.host.archive`. `worker.host.get` answers the host record and `instances`.
- `WorkerService.hostKeyOf(tx, name)`: the key of a live host, or null. `WorkerService.hostOf(tx, instanceName)`: the host name of a live `worker` instance, or null.
- `WorkerService.connectedInstancesOf(name)`: the live instances of a host with a current connection, newest heartbeat first.
- `src/apps/worker/host-config.ts`: `readHostConfiguration(env, name)` and `writeHostFile(env, configuration, force)`.
- The CLI commands `kanthord worker host create|list|get|rotate|archive|join` and `kanthord worker instance create --host <name>`.

## Tasks

### 02.1 Write the tests of the host

- Files: `src/worker/hosts.test.ts` (new), `src/worker/instances.test.ts` (edit), `src/apps/worker/host-config.test.ts` (new), `src/apps/server/cli-worker.test.ts` (edit)
- Do:
  1. In `hosts.test.ts`, copy the fixture pattern of `instances.test.ts`. Add one test for each operation and each refusal of the host error table of plan 01: create with `public_key`, create without `public_key` with `host_configuration` and `Cache-Control: no-store`, `name_invalid`, `name_conflict` against a host and against an instance, `key_invalid`, `key_conflict` against a host and against an instance, list with `instance_count`, get with `instances`, rotate with `revision_conflict` and `archived`, archive with `in_use` and its `details.instances`.
  2. Add a test that `hostKeyOf` answers the current key after a rotate and null after an archive. Add a test that `hostOf` answers the host of a `worker` instance and null at the `server` placement.
  3. Add a test that `connectedInstancesOf` orders by the newest heartbeat, then by name.
  4. In `instances.test.ts`, add tests for `host` of `worker.instance.create`: an absent host at the `worker` placement, an unknown host, an archived host and a host at the `server` placement each answer 400 `worker.instance.host_invalid`. A valid host gives the record `host`. A create of a name that a host holds answers 409 `worker.instance.name_conflict`.
  5. Add `host` to every `worker` create of the current tests. Create one host in the fixture for it.
  6. In `host-config.test.ts`, copy the tests of `instance-config.test.ts`: the env source, the file source, the conflict, the absence with its paths, an invalid value and a file name mismatch.
  7. In `cli-worker.test.ts`, add a test of `worker host create --output`, `worker host join` and `worker instance create --placement worker --host <name>`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/hosts.test.ts src/worker/instances.test.ts src/apps/worker/host-config.test.ts` fails on the new tests only.

### 02.2 Add the schema and the contract

- Files: `src/worker/migrations.ts`, `src/worker/contract.ts` (edit)
- Do:
  1. In `src/worker/migrations.ts:16-28`, add `host TEXT` to `CREATE TABLE worker_instance`. Add `CREATE TABLE worker_host (id, name, revision, public_key, fingerprint, created_at, ended_at)` with `public_key` and `fingerprint` `NOT NULL`, and the unique indexes `worker_host_name_revision` and `worker_host_fingerprint`. Add no migration (decision D16).
  2. In `src/worker/contract.ts`, add `host: z.string().min(1).nullable()` to `instanceRecordSchema` (`:995-1005`). Add the optional `host` to the create body (`:1329-1338`).
  3. Add `hostRecordSchema`, `hostConfigurationSchema` (`{ name, private_key }`) and `hostConfigurationValue`, after the instance schemas (`:1015-1022`).
  4. Add `hostOperations` with the five operations of decision D2. Copy the fields of `instanceOperations` (`:1317-1450`). The path parameter is `host_name`. Add `hostOperations` to the worker operations (`:1569`).
  5. Add the codes `HostNameInvalid` to `HostInUse`, `InstanceHostInvalid`, `HostConfigInvalid`, `HostConfigAbsent` and `HostConfigConflict` to `WorkerErrorCode` (`:946-960`).
- Cite: D2, D3, D5.
- Verify: `pnpm run typecheck`.

### 02.3 Implement the host

- Files: `src/worker/host-rows.ts` (new), `src/worker/hosts.ts` (new), `src/worker/host-operations.ts` (new), `src/worker/instance-rows.ts`, `src/worker/instances.ts`, `src/worker/service.ts` (edit)
- Do:
  1. In `host-rows.ts`, copy the reads and the writes of `instance-rows.ts` for `worker_host`: the latest, the live, the insert, the end and the list.
  2. Change `fingerprintTaken` (`src/worker/instance-rows.ts:96-107`) to read both tables. Add `nameTaken(tx, name)` that reads both tables.
  3. In `hosts.ts`, add `WorkerHosts` with `create`, `list`, `get`, `rotate` and `archive`. Copy the key preparation of `WorkerInstances` (`src/worker/instances.ts:437-469`, `:961-985`). A create without `public_key` generates the key pair, answers `host_configuration` once and clears the key buffer in `finally`.
  4. The archive refuses while a live instance names the host with 409 `worker.host.in_use` and `details.instances`. It calls the dependency `archiveHeld(tx, host, now)`, as the instance archive does (`src/worker/instances.ts:578`).
  5. In `host-operations.ts`, add `declareHosts(registry, dependencies)` after the pattern of `declareInstances` (`src/worker/instance-operations.ts:171-178`). Call it beside `declareInstances` in `src/worker/service.ts`.
  6. In `WorkerInstances.create` (`src/worker/instances.ts:437-469`), validate `host` by decision D3 and store it. Refuse a taken name through `nameTaken`.
  7. Add `hostKeyOf`, `hostOf` and `connectedInstancesOf` to `WorkerService`, beside `instanceKeyOf` (`src/worker/service.ts:373-380`). `connectedInstancesOf` reads the connection book of `WorkerInstances.connected` (`src/worker/instances.ts:408`). Leave `instanceKeyOf` unchanged. Plan 03 joins both in the custody port.
- Cite: D2, D3.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/hosts.test.ts src/worker/instances.test.ts` passes.

### 02.4 Add the host configuration module

- Files: `src/apps/worker/host-config.ts` (new), `src/agent/environment.ts` (edit)
- Do:
  1. Copy the source rules of `src/apps/worker/instance-config.ts` for the host configuration: the variable `KANTHORD_HOST_CONFIG`, the directory `hosts`, the file `hosts/<name>.yaml` with mode `0600` in a directory with mode `0700`.
  2. Export `readHostConfiguration(env, name)`, which answers `worker.host.config_absent`, `worker.host.config_conflict` or `worker.host.config_invalid` by decision D5. Export `writeHostFile(env, configuration, force)`.
  3. Add `KANTHORD_HOST_CONFIG` to the removed names of `childEnvironment` (`src/agent/environment.ts:15-30`). Add one assertion to its test.
- Cite: D5.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/host-config.test.ts src/agent/environment.test.ts` passes.

### 02.5 Add the CLI commands

- Files: `src/apps/cli/worker-host.ts` (new), `src/apps/cli/worker.ts`, `src/apps/cli/worker-instance.ts` (edit)
- Do:
  1. Copy the commands of `worker-instance.ts` for `worker host create <name> [--output] [--force]`, `list`, `get <name>`, `rotate <name> --expected-revision <n> [--output] [--force]`, `archive <name> --expected-revision <n>` and `join [--force]`.
  2. `create` and `rotate` generate the key pair on the host of the CLI and send only `public_key`. With `--output`, they write the host file through `writeHostFile`. Without it, they print `host_configuration`.
  3. Register the group in `src/apps/cli/worker.ts:452`, beside `addWorkerInstanceCommands`.
  4. Add `--host <name>` to `worker instance create` and send it as `host`.
- Cite: D2, D5, D15.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/server/cli-worker.test.ts src/apps/cli/completeness.test.ts` passes.

### 02.6 Update the CLI page

- Files: `docs/cli/worker.md` (edit)
- Do:
  1. Add the section "Worker hosts" after "Worker instances" (`docs/cli/worker.md:563`), with one subsection for each host command, after the pattern of `instance create` to `join` (`:590-742`).
  2. Add `--host <name>` to `instance create` (`:590`). Add `host` to the instance record.
  3. Add each new code to the error table (`:877`) with its HTTP status and condition.
- Cite: root `AGENTS.md` "Contracts" (every error code on the CLI page).
- Verify: `pnpm exec prettier --check docs/cli/worker.md`.

### 02.7 Regenerate the OpenAPI document

- Files: `static/` (generated)
- Do: run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit the result.
- Verify: `git status --porcelain static/` prints nothing after the commit.

### 02.E Run the gate

- Do: run the gate row 02 of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

No new row. The live `worker` placement e2e moves to a dev host in plan 08. Until then, the root `engine` pointer stays at a commit without this plan.

## Blockers

None. Ruling O1 alternative A makes `host` optional in task 02.3 step 6 and in task 02.1 step 4.
