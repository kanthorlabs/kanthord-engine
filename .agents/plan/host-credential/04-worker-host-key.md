# Plan 04: Worker application — the host key

## Scope

This plan lets the `worker` application open and seal a host copy. It reads the host key at each use, by the holder name of the item (decision D5). It uses that key for the handover item, the refresh report, the copy check and the login on a host. It also states the CLI holder rule of decision D6 for a host holder.

Out of scope:

- The server side of a host copy. Plan 03 adds it.
- The refresh lease. Plan 05 adds it. This plan keeps the lease calls of plan 05 and only changes the key of a sealed item.

## Model

Sonnet at high effort. The change stays in the `worker` application and one CLI module.

## Sources

- Root pull request of plan 01: `worker-service.impl.md` "The host configuration" and "The credential handover"; `llm.impl.md` "The health of an instance copy" and "The login of an instance".
- `src/apps/worker/instance-credential.ts:56-73` — `instanceCopyKey`.
- `src/apps/worker/host-config.ts` — `readHostConfiguration` of plan 02.
- `src/apps/worker/handover.ts:73-121`, `:137-191` — the open of a sealed item and `takeHandover`.
- `src/custody/instance-copy.ts:24-93` — `openSealedCopy` and `sealedCopyReporter`.
- `src/apps/worker/copy-checks.ts:152-229` — the check and the open of a copy.
- `src/apps/worker/instance-login.ts:107-191` — the session record and the seal at completion.
- `src/apps/worker/index.ts:193-245`, `src/apps/worker/unit.ts:90`, `:653`, `src/apps/worker/execution.ts:35` — the path of the instance key.
- `src/apps/cli/credential.ts:71-146` — the local seal of `--holder`.

## Depends on

Plans 03 and 05 merged. Start from `origin/main` of `kanthorlabs/kanthord-engine` after both merges.

## Provides

- `CopyKeys` of `src/apps/worker/copy-keys.ts`: `own`, the instance key, and `of(holder)`, the key of the instance or of its host, or null.
- A `worker` instance that runs an execution with a host copy, checks a host copy and completes a login on a host.

## Tasks

### 04.1 Write the tests of the host key

- Files: `src/apps/worker/copy-keys.test.ts` (new), `src/apps/worker/handover.test.ts`, `src/apps/worker/copy-checks.test.ts`, `src/apps/worker/instance-login.test.ts`, `src/apps/server/cli-worker.test.ts` (edit)
- Do:
  1. In `copy-keys.test.ts`, assert that `of(<instance name>)` answers the instance key, `of(<host name>)` answers the key of `KANTHORD_HOST_CONFIG` or of the host file, and `of(<other name>)` answers null. Assert that a second call reads the file again after the test replaces it.
  2. In `handover.test.ts`, add an item with `holder` the host name, sealed to a host test key. Assert that the execution store opens it. Assert that the refresh report seals to the host key with the host name in the additional authenticated data. Assert that an item of a host with no host key answers `worker.handover.sealed_unopened`.
  3. In `copy-checks.test.ts`, add a copy with `holder` the host name. Assert that the check opens it with the host key and reports it. Assert that a copy of a host with no host key sends no report and logs one record with the code `worker.host.config_absent`.
  4. In `instance-login.test.ts`, add a session entry with `holder` the host name. Assert that the completed report seals to the host key and sends the host fingerprint as `sealed_to`.
  5. In `cli-worker.test.ts`, assert that `llm credential create --holder <host>` sends the plaintext under the human token with `holders: [<host>]`, when a host file of that name exists and no instance file does.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/copy-keys.test.ts src/apps/worker/handover.test.ts src/apps/worker/copy-checks.test.ts src/apps/worker/instance-login.test.ts` fails on the new tests only.

### 04.2 Add the copy keys

- Files: `src/apps/worker/copy-keys.ts` (new), `src/apps/worker/instance-credential.ts` (edit)
- Do:
  1. Add `hostCopyKey(configuration)` beside `instanceCopyKey` (`src/apps/worker/instance-credential.ts:56-73`). Its `holder` is the host name, and its `sealed_to` is the fingerprint of the host public key.
  2. In `copy-keys.ts`, export `copyKeys(configuration, env)`. `of(holder)` answers the instance key for the instance name. For another name, it calls `readHostConfiguration(env, holder)` of plan 02 at each call and answers `hostCopyKey` of the result. A `worker.host.config_absent` answers null. Every other diagnostic of the read propagates.
- Cite: D5.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/copy-keys.test.ts` passes.

### 04.3 Open and seal with the key of the holder

- Files: `src/apps/worker/handover.ts`, `src/apps/worker/copy-checks.ts`, `src/apps/worker/instance-login.ts`, `src/apps/worker/index.ts`, `src/apps/worker/unit.ts`, `src/apps/worker/execution.ts` (edit)
- Do:
  1. Replace the option `instanceKey` of `takeHandover` (`src/apps/worker/handover.ts:141`) and of `HostExecutionInput` (`src/apps/worker/execution.ts:35`) with `copyKeys`. Replace `instance_key` of the unit options (`src/apps/worker/unit.ts:90`, `:653`) with `copy_keys`.
  2. In `openSealedItem` (`src/apps/worker/handover.ts:73-85`), take the key with `copyKeys.of(item.holder)`. A null key answers `sealedRefused()`. Pass the same key to `sealedCopyReporter`, also for the item of a lease answer of plan 05.
  3. In `CopyChecks.open` (`src/apps/worker/copy-checks.ts:211-229`), take the key with `copyKeys.of(copy.holder)`. For a null key, log `Worker instance credential check skipped` with `credential_name`, `holder` and `code: worker.host.config_absent`, and send no report.
  4. In `InstanceLogins.complete` (`src/apps/worker/instance-login.ts:176-191`), seal with `copyKeys.of(entry.holder)`. A null key fails the session with the report `failed` and `failure_reason: worker.host.config_absent`. Set `holder` of the session record (`:116`) to the entry holder.
  5. In `src/apps/worker/index.ts:193-245`, build `copyKeys(configuration, env)` once and pass it to `InstanceLogins`, `CopyChecks` and `WorkerUnit`.
- Cite: D5, D7, D8, D13.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/worker/handover.test.ts src/apps/worker/copy-checks.test.ts src/apps/worker/instance-login.test.ts src/apps/worker/unit.test.ts` passes.

### 04.4 Keep the CLI holder rule

- Files: `src/apps/cli/credential.ts` (edit only when the test of task 04.1 step 5 fails)
- Do:
  1. Confirm that `--holder <name>` seals locally only with the instance file `workers/<name>.yaml` (`src/apps/cli/credential.ts:90-146`). A host name has no instance file, so the CLI sends the plaintext under the human token.
  2. When the test fails, change only the file test of `readNamedInstance`. Add no host branch.
- Cite: D6.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/server/cli-worker.test.ts` passes.

### 04.5 Update the CLI pages

- Files: `docs/cli/llm.md`, `docs/cli/worker.md` (edit)
- Do:
  1. In `docs/cli/llm.md:175-178`, state that a host name of `--holder` sends the plaintext under the human token, and the server seals it.
  2. In `docs/cli/worker.md`, add the rule that `serve worker` reads the host key at each use from `KANTHORD_HOST_CONFIG` or from `hosts/<name>.yaml`. Add `worker.host.config_absent`, `worker.host.config_conflict` and `worker.host.config_invalid` to the local rows of the error table (`:885-886`).
- Verify: `pnpm exec prettier --check docs/cli/llm.md docs/cli/worker.md`.

### 04.E Run the gate

- Do: run the gate row 04 of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

No new row. Plan 08 runs the live `worker` placement e2e with one dev host.

## Blockers

None.
