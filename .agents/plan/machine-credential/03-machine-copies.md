# Plan 03: Custody, LLM and Agent — the machine copy

## Scope

This plan makes a worker machine a credential holder on the server. It implements these decisions:

- the copy holder of decision D4 and the operations of decision D6;
- the login of decision D7, the health of decision D8 and the cooldown of decision D9;
- the archive of decision D10, `sealed_current` of decision D11 and the override of decision D12;
- the handover pick of decision D13.

Out of scope:

- The `worker` application. It opens and seals no machine copy until plan 04. The tests of this plan seal each object with a machine test key.
- The refresh lease. Plan 05 adds it before this plan starts.
- The dashboard. Plan 07 adds the machine copies to it.

## Model

Opus at medium effort. The change crosses custody, the LLM component, the Agent component, the Worker Service and the composition root.

## Sources

- Root pull request of plan 01: `custody.impl.md` "The credential store record", "Rules of an instance copy", "The credential handover", "The credential hold".
- Root pull request of plan 01: `llm.impl.md` "Instance copies", "The health of an instance copy", "The login of an instance".
- Root pull request of plan 01: `agent.impl.md` "The holder rule"; `docs/reference/llm/credential.html`; `docs/reference/llm/login.html`.
- `src/custody/contract.ts:95-102`, `:845-848`, `:873-880` — the sealed item, `InstanceKeys` and the sealed copy answer.
- `src/custody/service.ts:480-515` — `credentialHolds`.
- `src/custody/service.ts:858-920` and `itemOfRow` of plan 05 — the sealed item of the handover and of the lease.
- `src/custody/service.ts:1393-1430` — the refresh report and `instanceCopyRefreshed`.
- `src/custody/service.ts:1505-1585` — `copyHeld`, `heldCopy`, `sealedCopy`, `heldCopies`, `archiveHeld` and `sealedCurrent`.
- `src/custody/service.ts:2310-2330` — the dependents of an instance copy at archive.
- `src/llm/service.ts:361-365`, `:368-371`, `:446-471`, `:922-1015` — `written`, the caller holder, `readHolder`, `instanceKey` and the instance login.
- `src/llm/contract.ts:92-98`, `:175-182` — `loginSessionEntrySchema` and `copyHealthSchema`.
- `src/llm/copy-health.ts:22-60` — `CopyHealthBook`, `raise` and `versionOf`.
- `src/llm/sessions.ts:20-34`, `:82-89` — `LoginSession` and `pendingOfHolder`.
- `src/agent/configuration.ts:150-171`, `src/agent/service.ts:760-776`, `:894-912` — the holder check, the cooldown read and `recordProviderFailure`.
- `src/worker/service.ts:359-380`, `:1514-1522` — `bindingsListingInstance`, `instanceKeyOf` and the held copies of `worker.instance.get`.
- `src/apps/server/index.ts:484-499`, `:559`, `:597-607`, `:641-642`, `:851` — the cooldown calls, `raiseCredentialVersion` and the port connections.

## Depends on

Plans 02 and 05 merged. Start from `origin/main` of `kanthorlabs/kanthord-engine` after both merges.

## Provides

- `copyHolderOf(tx, credentialName, holder)` of custody, and the copy holder in every path of decision D4.
- `InstanceKeys.keyOf` for an instance or a machine, and `InstanceKeys.machineOf`.
- The sealed handover item `{ credential_id, provider_id, name, platform, holder, sealed }`, in the handover and in the lease answer.
- The work read item `login_sessions[].holder`.
- `holder` and `health.reported_by` of each item of `credentials` in `worker.instance.get` and `worker.machine.get`.
- `llm.credential.holder_unknown` in place of `llm.credential.instance_unknown`.

## Tasks

### 03.1 Write the tests of the machine copy

- Files: `src/custody/service.test.ts`, `src/custody/handover.test.ts`, `src/custody/resource-healthcheck.test.ts`, `src/llm/service.test.ts`, `src/llm/instance-login.test.ts`, `src/llm/copy-health.test.ts`, `src/agent/service.test.ts`, `src/worker/instances.test.ts`, `src/worker/machines.test.ts`, `src/apps/server/handover-integration.test.ts` (edit)
- Do:
  1. Custody: a human create with `holders: ["server", "<machine>"]` seals the machine copy to the machine key.
  2. Custody: `copyHolderOf` answers the instance with an own live copy, the machine without it, and the instance for a stale own copy.
  3. Custody: `sealed_current` of a machine copy turns false after a machine rotate.
  4. Handover at the `worker` placement: an instance with no own copy receives the machine copy, with `holder` the machine name. An instance with an own copy receives the own copy.
  5. Handover: a stale own copy refuses with `held_elsewhere`. An execution that pinned the machine copy keeps it after an own copy appears.
  6. Lease: the lease answer of a pinned machine copy holds `holder` the machine name. In `src/apps/server/handover-integration.test.ts`, call `setup(t, adapter, oauth, { workerInstances: ["box-1", "box-2"] })` with one machine. Each instance claims one execution that pins the machine copy. A lease of the second execution answers `lease_held` until the report of the first ends it.
  7. Holds: a hold on the machine copy shows for each instance of the machine through `holdOf`. `listHolds` answers the machine name.
  8. Holds: a stop of an execution that pins the machine copy holds the machine copy, not a group of the instance.
  9. Archive: a machine copy refuses with the bindings of D10. An instance copy archives with no dependent when the machine holds a live current copy. A machine archive archives every machine copy.
  10. LLM: `holder_unknown` for a name that is no live instance and no live machine.
  11. LLM: a worker-token `list` answers the own copies and the machine copies of names with no own copy, each with `holder`. A worker-token `get`, `sealed` and `report` act on the copy of the copy holder.
  12. LLM: a worker-token create or rotate with `holder` the machine of the instance answers `instance_forbidden`.
  13. Login on a machine: the server picks the connected instance with the newest heartbeat. No connected instance answers `credential.login.instance_unavailable`.
  14. Login on a machine: the work read of the runner lists the session with `holder`. A report of another instance of the machine answers `credential.login.not_found`. A completed report writes the machine copy.
  15. Health: a human write of a machine copy changes `credential_version` of each live instance of the machine.
  16. Health: a refresh report of a machine copy changes `credential_version` of each live instance of the machine. A login completion on the machine does the same.
  17. Health: a report of a machine copy holds `reported_by`.
  18. Agent: the holder check passes for an instance with no own copy and a live current machine copy. It fails for a stale machine copy.
  19. Worker: `worker.instance.get` answers the own copies and the machine copies of names with no own copy, each with `holder`. `worker.machine.get` answers the live copies of the machine.
- Verify: each edited test file fails on the new tests only, with `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 <file>`.

### 03.2 Join the machine key and the copy holder in custody

- Files: `src/custody/contract.ts`, `src/custody/service.ts`, `src/agent/service.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. Add `machineOf(tx, instanceName): string | null` to `InstanceKeys` (`src/custody/contract.ts:845-848`).
  2. In `src/apps/server/index.ts:606-607` and `:641-642`, wire `keyOf` to `worker.instanceKeyOf(tx, name) ?? worker.machineKeyOf(tx, name)`. Wire `machineOf` to `worker.machineOf`.
  3. Add `copyHolderOf(tx, credentialName, holder)` to `CustodyComponent`, by decision D4.
  4. In `copyHeld` (`src/custody/service.ts:1505-1508`), resolve the holder through `copyHolderOf`.
  5. In `credentialHolds` (`src/custody/service.ts:480-515`), resolve the holder of `holdOf` only. `hold`, `release` and `listHolds` keep the given holder.
  6. Add `pinnedHolderOf(tx, executionId, credentialName)`: the holder of the row that the execution pins for the name.
  7. In the cooldown calls of `src/apps/server/index.ts:484-499`, pass the holder of the pinned row for each credential to `recordProviderFailure` and `recordSuccess` (`src/agent/service.ts:894-912`). Replace the claimant holder there.
  8. Add `usedCopies(tx, instanceName)`. It answers each own live copy and each live machine copy of a name with no own copy, each as a `HeldCopy` with `holder`.
  9. Add `holder` to `HeldCopy`.
- Cite: D4, D9, D11.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/service.test.ts src/agent/service.test.ts` passes the tests of task 03.1 steps 1 to 3, 7 and 8.

### 03.3 Pick the copy holder in the handover

- Files: `src/custody/contract.ts`, `src/custody/service.ts` (edit)
- Do:
  1. Add `holder: z.string().min(1)` to `sealedHandoverItemSchema` (`src/custody/contract.ts:95-101`).
  2. In `sealedItem` (`src/custody/service.ts:858-920`), read the row that the execution pins for the name first. Without a pin, take the newest live row of `copyHolderOf(tx, credential, instanceName)`.
  3. Compare `sealed_to` with the key of the row holder, not the key of the instance. Keep both refusal reasons.
  4. Set `holder` of the sealed item to the row holder in `itemOfRow` of plan 05. The handover and the lease answer both carry it.
- Cite: D13.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/handover.test.ts src/apps/server/handover-integration.test.ts` passes.

### 03.4 Write the archive dependents

- Files: `src/custody/service.ts`, `src/custody/contract.ts`, `src/worker/service.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. In the archive (`src/custody/service.ts:2310-2330`), branch on the holder kind.
  2. For a machine copy, collect `bindingsListingInstance(tx, instance, name)` for each live instance of the machine whose copy holder for the name is the machine.
  3. For an instance copy, skip the dependents when `copyHeld(tx, name, machine)` holds for the machine of the instance.
  4. Add `instancesOfMachine(tx, machine)` to `InstanceKeys`, wired to the Worker Service.
- Cite: D10.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/service.test.ts` passes the tests of task 03.1 step 9.

### 03.5 Accept a machine holder in the LLM component

- Files: `src/llm/service.ts`, `src/llm/contract.ts`, `src/llm/copy-health.ts`, `src/llm/sessions.ts`, `src/llm/instance-login.ts` (edit)
- Do:
  1. Rename `LlmErrorCode.InstanceUnknown` to `HolderUnknown` with the value `llm.credential.holder_unknown`. Change the message of `instanceKey` (`src/llm/service.ts:463-472`) to name an instance or a machine.
  2. Change `readHolder` (`:452-461`). In a read, a worker caller names its instance or its machine.
  3. Without a name, a worker-token `get` answers the copy of the copy holder, and `list` answers `usedCopies`.
  4. Keep the holder check of `create` (`:475`) and `rotate` (`:572`) under a worker token. `holder` equals the instance of the token (decision D6).
  5. Change the `sealed` read (`:334`) and `report` (`:373-419`). The copy is the copy of `copyHolderOf` for the caller instance.
  6. Add `holder` to `sealedCopyAnswerSchema` (`src/custody/contract.ts:873-880`). The instance opens the answer with the key of that holder.
  7. Keep `written` (`:361-365`) and the refresh report path (`src/custody/service.ts:1427-1429`). Each raises the counter of the holder of the copy, also of a machine.
  8. Change `CopyHealthBook.versionOf(instance)` (`src/llm/copy-health.ts:31-37`). It answers the counter of the instance plus the counter of its machine, through `machineOf`.
  9. Add `reported_by` to the report of `CopyHealthBook` (`src/llm/copy-health.ts:39-60`) and to `copyHealthSchema` (`src/llm/contract.ts:175-182`). Key a report by `(holder, name)`.
  10. Add `runner` to `LoginSession` (`src/llm/sessions.ts:20-34`). Replace `pendingOfHolder` (`:82-89`) with `pendingOfRunner`.
  11. In `loginInstance` (`src/llm/service.ts:922-961`), pick the runner. It is the holder itself for an instance, or the first item of `connectedInstancesOf(machine)` for a machine. Raise the work version of the runner.
  12. In `loginSessionsOf` (`:963-970`) and `loginReport` (`:980-1015`), match the runner, not the holder.
  13. Add `holder` to `loginSessionEntrySchema` (`src/llm/contract.ts:92-98`) and to the entry of `InstanceLogin` (`src/llm/instance-login.ts`).
- Cite: D6, D7, D8.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/llm/service.test.ts src/llm/instance-login.test.ts src/llm/copy-health.test.ts` passes.

### 03.6 Answer the used copies on the instance and on the machine

- Files: `src/worker/service.ts`, `src/worker/contract.ts`, `src/worker/machines.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. In `heldCopies` of `declareInstances` (`src/worker/service.ts:1514-1522`), call `usedCopies(tx, name)`. Read the health by the holder of each copy.
  2. Add `holder` to the credential item of `worker.instance.get` in `src/worker/contract.ts`.
  3. Add `credentials` to the answer of `worker.machine.get`, from `heldCopies(tx, machine)` with health.
  4. Wire `connectedInstancesOf` and `machineOf` into the LLM dependencies in `src/apps/server/index.ts`.
- Cite: D8.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/instances.test.ts src/worker/machines.test.ts` passes.

### 03.7 Update the CLI pages

- Files: `docs/cli/llm.md`, `docs/cli/agent.md`, `docs/cli/worker.md` (edit)
- Do:
  1. In `docs/cli/llm.md:104-105` and `:172-181`, name the machine holder, the copy holder and the worker-token reads. State that a worker-token create and rotate act only on the own instance.
  2. In `docs/cli/llm.md:374-386`, add the login on a machine and its runner.
  3. Replace `llm.credential.instance_unknown` in the error table (`docs/cli/llm.md:515`) with `llm.credential.holder_unknown`. Extend `credential.login.instance_unavailable` (`:481`) to a machine with no connected instance.
  4. In `docs/cli/agent.md:381` and `:395-401`, name the machine as a holder of a cooldown.
  5. In `docs/cli/worker.md`, add `holder` and `health.reported_by` to the credentials of `instance get` (`:652`) and of `machine get`. Add `holder` to the work read item.
- Verify: `pnpm exec prettier --check docs/cli/llm.md docs/cli/agent.md docs/cli/worker.md`.

### 03.8 Regenerate the OpenAPI document

- Files: `static/` (generated)
- Do: run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit the result.
- Verify: `git status --porcelain static/` prints nothing after the commit.

### 03.E Run the gate

- Do: run the gate row 03 of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

No new row. Plan 08b runs the live `worker` placement e2e with one machine copy.

## Blockers

None.
