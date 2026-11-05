# Plan 04: Worker application — the machine key

## Scope

This plan lets the `worker` application open and seal a machine copy. It implements these parts of decision D5:

- The application reads the machine key at each use, by the holder name of the item.
- It uses that key for the handover item, the refresh report, the copy check and the login on a machine.
- It reads the machine configuration when the heartbeat answer names the machine, and claims no work while the configuration is absent.

It also states the CLI holder rule of decision D6 for a machine holder.

Out of scope:

- The server side of a machine copy. Plan 03 adds it.
- The refresh lease. Plan 05 adds it. This plan keeps the lease calls of plan 05 and only changes the key of a sealed item.

## Model

Sonnet at high effort. The change stays in the `worker` application and one CLI module.

## Sources

- Root pull request of plan 01: `worker-service.impl.md` "The machine configuration" and "The credential handover".
- Root pull request of plan 01: `llm.impl.md` "The health of an instance copy" and "The login of an instance".
- `src/apps/worker/instance-credential.ts:56-73` — `instanceCopyKey`.
- `src/apps/worker/machine-config.ts` — `readMachineConfiguration` of plan 02.
- `src/apps/worker/handover.ts:73-121`, `:137-191` — the open of a sealed item and `takeHandover`.
- `src/custody/instance-copy.ts:24-93` — `openSealedCopy` and `sealedCopyReporter`.
- `src/apps/worker/copy-checks.ts:152-229` — the check and the open of a copy.
- `src/apps/worker/instance-login.ts:107-191` — the session record and the seal at completion.
- `src/apps/worker/index.ts:193-245`, `src/apps/worker/unit.ts:90`, `:653`, `src/apps/worker/execution.ts:35` — the path of the instance key.
- `src/apps/cli/credential.ts:71-146` — the local seal of `--holder`.

## Depends on

Plan 03 merged. Plan 05 merges before plan 03. Start from `origin/main` of `kanthorlabs/kanthord-engine` after the merge of plan 03.

## Provides

- `CopyKeys` of `src/apps/worker/copy-keys.ts`. `own` is the instance key. `of(holder)` is the key of the instance or of its machine, or null.
- The machine claim gate: `serve worker` claims no work while the machine configuration of its heartbeat machine is absent.
- A `worker` instance that runs an execution with a machine copy, checks a machine copy and completes a login on a machine.

## Tasks

### 04.1 Write the tests of the machine key

- Files: `src/apps/worker/copy-keys.test.ts` (new), `src/apps/worker/handover.test.ts`, `src/apps/worker/copy-checks.test.ts`, `src/apps/worker/instance-login.test.ts`, `src/apps/worker/unit.test.ts`, `src/apps/server/cli-worker.test.ts` (edit)
- Do:
  1. In `copy-keys.test.ts`, assert that `of(<instance name>)` answers the instance key. Assert that `of(<machine name>)` answers the key of `KANTHORD_MACHINE_CONFIG` or of the machine file. Assert that `of(<other name>)` answers null.
  2. In `copy-keys.test.ts`, assert that a second call reads the file again after the test replaces it.
  3. In `handover.test.ts`, add an item with `holder` the machine name, sealed to a machine test key. Assert that the execution store opens it.
  4. In `handover.test.ts`, assert that the refresh report seals to the machine key, with the machine name in the additional authenticated data. Assert that an item of a machine with no machine key answers `worker.handover.sealed_unopened`.
  5. In `copy-checks.test.ts`, add a copy with `holder` the machine name. Assert that the check opens it with the machine key and reports it.
  6. In `copy-checks.test.ts`, assert that a copy of a machine with no machine key sends no report. Assert that the check logs one record with the code `worker.machine.config_absent`.
  7. In `instance-login.test.ts`, add a session entry with `holder` the machine name. Assert that the completed report seals to the machine key and sends the machine fingerprint as `sealed_to`.
  8. In `unit.test.ts`, give a heartbeat answer that names a machine with no machine configuration. Assert that the unit sends no claim and logs `worker.machine.config_absent` once over two heartbeats.
  9. In `unit.test.ts`, add the machine configuration before the next heartbeat. Assert that the unit claims work again.
  10. In `cli-worker.test.ts`, assert that `llm credential create --holder <machine>` sends the plaintext under the human token with `holders: [<machine>]`. The test has a machine file of that name and no instance file.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/copy-keys.test.ts src/apps/worker/handover.test.ts src/apps/worker/copy-checks.test.ts src/apps/worker/instance-login.test.ts src/apps/worker/unit.test.ts` fails on the new tests only.

### 04.2 Add the copy keys

- Files: `src/apps/worker/copy-keys.ts` (new), `src/apps/worker/instance-credential.ts` (edit)
- Do:
  1. Add `machineCopyKey(configuration)` beside `instanceCopyKey` (`src/apps/worker/instance-credential.ts:56-73`). Its `holder` is the machine name. Its `sealed_to` is the fingerprint of the machine public key.
  2. In `copy-keys.ts`, export `copyKeys(configuration, env)`. `of(holder)` answers the instance key for the instance name.
  3. For another name, `of(holder)` calls `readMachineConfiguration(env, holder)` of plan 02 at each call. It answers `machineCopyKey` of the result.
  4. A `worker.machine.config_absent` answers null. Every other diagnostic of the read propagates.
- Cite: D5.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/copy-keys.test.ts` passes.

### 04.3 Open and seal with the key of the holder

- Files: `src/apps/worker/handover.ts`, `src/apps/worker/copy-checks.ts`, `src/apps/worker/instance-login.ts`, `src/apps/worker/index.ts`, `src/apps/worker/unit.ts`, `src/apps/worker/execution.ts` (edit)
- Do:
  1. Replace the option `instanceKey` of `takeHandover` (`src/apps/worker/handover.ts:141`) and of `HostExecutionInput` (`src/apps/worker/execution.ts:35`) with `copyKeys`.
  2. Replace `instance_key` of the unit options (`src/apps/worker/unit.ts:90`, `:653`) with `copy_keys`.
  3. In `openSealedItem` (`src/apps/worker/handover.ts:73-85`), take the key with `copyKeys.of(item.holder)`. A null key answers `sealedRefused()`.
  4. Pass the same key to `sealedCopyReporter`, also for the item of a lease answer of plan 05.
  5. In `CopyChecks.open` (`src/apps/worker/copy-checks.ts:211-229`), take the key with `copyKeys.of(copy.holder)`.
  6. For a null key, log `Worker instance credential check skipped` with `credential_name`, `holder` and `code: worker.machine.config_absent`. Send no report.
  7. In `InstanceLogins.complete` (`src/apps/worker/instance-login.ts:176-191`), seal with `copyKeys.of(entry.holder)`.
  8. For a null key, fail the session with the report `failed` and `failure_reason: worker.machine.config_absent`. Set `holder` of the session record (`:116`) to the entry holder.
  9. In `src/apps/worker/index.ts:193-245`, build `copyKeys(configuration, env)` once. Pass it to `InstanceLogins`, `CopyChecks` and `WorkerUnit`.
- Cite: D5, D7, D8, D13.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/handover.test.ts src/apps/worker/copy-checks.test.ts src/apps/worker/instance-login.test.ts` passes.

### 04.4 Add the machine claim gate

- Files: `src/apps/worker/unit.ts` (edit)
- Do:
  1. When the heartbeat answer holds `machine`, call `copyKeys.of(machine)` before each claim.
  2. When the answer is null, send no claim. Log `worker.machine.config_absent` with the machine name once, until the configuration is present again.
  3. Keep the read at each use. Cache no machine key.
- Cite: D5.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/unit.test.ts` passes.

### 04.5 Keep the CLI holder rule

- Files: `src/apps/cli/credential.ts` (edit only when the test of task 04.1 step 10 fails)
- Do:
  1. Confirm that `--holder <name>` seals locally only with the instance file `workers/<name>.yaml` (`src/apps/cli/credential.ts:90-146`).
  2. A machine name has no instance file. The CLI then sends the plaintext under the human token.
  3. When the test fails, change only the file test of `readNamedInstance`. Add no machine branch.
- Cite: D6.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/server/cli-worker.test.ts` passes.

### 04.6 Update the CLI pages

- Files: `docs/cli/llm.md`, `docs/cli/worker.md` (edit)
- Do:
  1. In `docs/cli/llm.md:175-178`, state that a machine name of `--holder` sends the plaintext under the human token. The server seals it.
  2. In `docs/cli/worker.md`, add the rule that `serve worker` reads the machine key at each use from `KANTHORD_MACHINE_CONFIG` or from `machines/<name>.yaml`.
  3. In `docs/cli/worker.md`, add the machine claim gate of task 04.4.
  4. Add `worker.machine.config_absent`, `worker.machine.config_conflict` and `worker.machine.config_invalid` to the local rows of the error table (`:885-886`).
- Verify: `pnpm exec prettier --check docs/cli/llm.md docs/cli/worker.md`.

### 04.E Run the gate

- Do: run the gate row 04 of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

No new row. Plan 08b runs the live `worker` placement e2e with one sign-in for the dev machine.

## Blockers

None.
