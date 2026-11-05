# Plan 03: Custody, LLM and Agent — the host copy

## Scope

This plan makes a worker host a credential holder on the server. It implements the copy holder of decision D4, the operations of decision D6, the login of decision D7, the health of decision D8, the cooldown of decision D9, the archive of decision D10, `sealed_current` of decision D11, the override of decision D12 and the handover pick of decision D13.

Out of scope:

- The `worker` application. It opens and seals no host copy until plan 04. The tests of this plan use sealed objects that the test seals with a host test key.
- The refresh lease. Plan 05 adds it.
- The dashboard. Plan 07 adds the host copies to it.

## Model

Opus at medium effort. The change crosses custody, the LLM component, the Agent component, the Worker Service and the composition root.

## Sources

- Root pull request of plan 01: `custody.impl.md` "The credential store record", "Rules of an instance copy", "The credential handover", "The credential hold"; `llm.impl.md` "Instance copies", "The health of an instance copy", "The login of an instance"; `agent.impl.md` "The holder rule"; `docs/reference/llm/credential.html`; `docs/reference/llm/login.html`.
- `src/custody/contract.ts:95-102`, `:845-848`, `:873-880` — the sealed item, `InstanceKeys` and the sealed copy answer.
- `src/custody/service.ts:480-515` — `credentialHolds`.
- `src/custody/service.ts:858-920` — `sealedItem` of the handover.
- `src/custody/service.ts:1505-1585` — `copyHeld`, `heldCopy`, `sealedCopy`, `heldCopies`, `archiveHeld` and `sealedCurrent`.
- `src/custody/service.ts:2310-2330` — the dependents of an instance copy at archive.
- `src/llm/service.ts:361-365`, `:368-371`, `:446-471`, `:922-1015` — `written`, the caller holder, `readHolder`, `instanceKey` and the instance login.
- `src/llm/contract.ts:92-98`, `:175-182` — `loginSessionEntrySchema` and `copyHealthSchema`.
- `src/llm/copy-health.ts:22-60` — `CopyHealthBook`.
- `src/llm/sessions.ts:84-98`, `:146-153` — the session record and `pendingOfHolder`.
- `src/agent/configuration.ts:150-171`, `src/agent/service.ts:760-776` — the holder check and the cooldown read.
- `src/worker/service.ts:359-380`, `:1514-1522` — `bindingsListingInstance`, `instanceKeyOf` and the held copies of `worker.instance.get`.
- `src/apps/server/index.ts:597-607`, `:641-642`, `:851` — the port connections.

## Depends on

Plan 02 merged. Start from `origin/main` of `kanthorlabs/kanthord-engine` after that merge.

## Provides

- `copyHolderOf(tx, credentialName, holder)` of custody, and the copy holder in every path of decision D4.
- `InstanceKeys.keyOf` for an instance or a host, and `InstanceKeys.hostOf`.
- The sealed handover item `{ credential_id, provider_id, name, platform, holder, sealed }`.
- The work read item `login_sessions[].holder`.
- `holder` and `health.reported_by` of each item of `credentials` in `worker.instance.get` and `worker.host.get`.
- `llm.credential.holder_unknown` in place of `llm.credential.instance_unknown`.

## Tasks

### 03.1 Write the tests of the host copy

- Files: `src/custody/service.test.ts`, `src/custody/handover.test.ts`, `src/custody/resource-healthcheck.test.ts`, `src/llm/service.test.ts`, `src/llm/instance-login.test.ts`, `src/llm/copy-health.test.ts`, `src/agent/service.test.ts`, `src/worker/instances.test.ts`, `src/worker/hosts.test.ts` (edit)
- Do:
  1. Custody: a human create with `holders: ["server", "<host>"]` seals the host copy to the host key. `copyHolderOf` answers the instance with an own live copy, the host without it, and the instance for a stale own copy. `sealed_current` of a host copy turns false after a host rotate.
  2. Handover at the `worker` placement: an instance with no own copy receives the host copy with `holder` the host name. An instance with an own copy receives the own copy. A stale own copy refuses with `held_elsewhere`. An execution that pinned the host copy keeps it after an own copy appears.
  3. Holds: a hold written on the host copy shows for each instance of the host through `holdOf`. `listHolds` answers the host name.
  4. Archive: a host copy refuses with the bindings of D10. An instance copy archives with no dependent when the host holds a live current copy. A host archive archives every host copy.
  5. LLM: `holder_unknown` for a name that is no live instance and no live host. A worker-token `list` answers the own copies and the host copies of names with no own copy, each with `holder`. A worker-token `get`, `sealed` and `report` act on the copy of the copy holder. A worker-token create with `holder` the host of the instance seals to the host key. A worker-token create with another host answers `instance_forbidden`.
  6. Login on a host: the server picks the connected instance with the newest heartbeat. No connected instance answers `credential.login.instance_unavailable`. The work read of the runner lists the session with `holder`. A report of another instance of the host answers `credential.login.not_found`. A completed report writes the host copy.
  7. Health: a host copy write raises `credential_version` of each live instance of the host. A report of a host copy holds `reported_by`.
  8. Agent: the holder check passes for an instance with no own copy and a live current host copy. It fails for a stale host copy.
  9. Worker: `worker.instance.get` answers the own copies and the host copies of names with no own copy, each with `holder`. `worker.host.get` answers the live copies of the host.
- Verify: each edited test file fails on the new tests only, with `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 <file>`.

### 03.2 Join the host key and the copy holder in custody

- Files: `src/custody/contract.ts`, `src/custody/service.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. Add `hostOf(tx, instanceName): string | null` to `InstanceKeys` (`src/custody/contract.ts:845-848`).
  2. In `src/apps/server/index.ts:606-607` and `:641-642`, wire `keyOf` to `worker.instanceKeyOf(tx, name) ?? worker.hostKeyOf(tx, name)` and `hostOf` to `worker.hostOf`.
  3. Add `copyHolderOf(tx, credentialName, holder)` to `CustodyComponent`, by decision D4.
  4. In `copyHeld` (`src/custody/service.ts:1505-1508`), resolve the holder through `copyHolderOf`.
  5. In `credentialHolds` (`src/custody/service.ts:480-515`), resolve the holder of `holdOf`, `hold` and `release`. Leave `listHolds` unchanged.
  6. Add `usedCopies(tx, instanceName)`: each own live copy and each live host copy of a name with no own copy, each as a `HeldCopy` with `holder`. Add `holder` to `HeldCopy`.
- Cite: D4, D9, D11.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/service.test.ts` passes the tests of steps 1 and 3 of task 03.1.

### 03.3 Pick the copy holder in the handover

- Files: `src/custody/contract.ts`, `src/custody/service.ts` (edit)
- Do:
  1. Add `holder: z.string().min(1)` to `sealedHandoverItemSchema` (`src/custody/contract.ts:95-101`).
  2. In `sealedItem` (`src/custody/service.ts:858-920`), read the row that the execution pins for the name first. Without a pin, take the newest live row of `copyHolderOf(tx, credential, instanceName)`.
  3. Compare `sealed_to` with the key of the row holder, not the key of the instance. Keep both refusal reasons.
  4. Set `holder` of the item to the row holder. When plan 05 merged first, set it in `itemOfRow`, so that the lease item also carries `holder`.
- Cite: D13.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/handover.test.ts` passes.

### 03.4 Write the archive dependents

- Files: `src/custody/service.ts`, `src/custody/contract.ts`, `src/worker/service.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. In the archive (`src/custody/service.ts:2310-2330`), branch on the holder kind. For a host copy, collect `bindingsListingInstance(tx, instance, name)` for each live instance of the host whose copy holder for the name is the host.
  2. For an instance copy, skip the dependents when `copyHeld(tx, name, host)` holds for the host of the instance.
  3. Add `instancesOfHost(tx, host)` to `InstanceKeys`, wired to the Worker Service.
- Cite: D10.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/service.test.ts` passes the tests of step 4 of task 03.1.

### 03.5 Accept a host holder in the LLM component

- Files: `src/llm/service.ts`, `src/llm/contract.ts`, `src/llm/copy-health.ts`, `src/llm/sessions.ts`, `src/llm/instance-login.ts` (edit)
- Do:
  1. Rename `LlmErrorCode.InstanceUnknown` to `HolderUnknown` with the value `llm.credential.holder_unknown`. Change the message of `instanceKey` (`src/llm/service.ts:463-472`) to name an instance or a host.
  2. Change `readHolder` (`:452-461`). A worker caller may name its instance or its host. Without a name, `get` answers the copy of the copy holder, and `list` answers `usedCopies`.
  3. Change the holder check of `create` (`:475`) and `rotate` (`:572`) under a worker token. `holder` equals the instance or its host.
  4. Change the `sealed` read (`:334`) and `report` (`:373-419`). The copy is the copy of `copyHolderOf` for the caller instance. Add `holder` to `sealedCopyAnswerSchema` (`src/custody/contract.ts:873-880`), so that the instance opens the answer with the key of that holder.
  5. Change `written` (`:361-365`). A host holder raises the version of each live instance of the host.
  6. Add `reported_by` to the report of `CopyHealthBook` (`src/llm/copy-health.ts:39-60`) and to `copyHealthSchema` (`src/llm/contract.ts:175-182`). Key a report by `(holder, name)`.
  7. Add `runner` to `LoginSession` (`src/llm/sessions.ts:84-98`). Replace `pendingOfHolder` with `pendingOfRunner`.
  8. In `loginInstance` (`src/llm/service.ts:922-961`), pick the runner: the holder itself for an instance, or the first item of `connectedInstancesOf(host)` for a host. Raise the work version of the runner.
  9. In `loginSessionsOf` (`:963-970`) and `loginReport` (`:980-1015`), match the runner, not the holder. Add `holder` to `loginSessionEntrySchema` (`src/llm/contract.ts:92-98`) and to the entry of `InstanceLogin` (`src/llm/instance-login.ts`).
- Cite: D6, D7, D8.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/llm/service.test.ts src/llm/instance-login.test.ts src/llm/copy-health.test.ts` passes.

### 03.6 Answer the used copies on the instance and on the host

- Files: `src/worker/service.ts`, `src/worker/contract.ts`, `src/worker/hosts.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. In `heldCopies` of `declareInstances` (`src/worker/service.ts:1514-1522`), call `usedCopies(tx, name)`. Read the health by the holder of each copy.
  2. Add `holder` to the credential item of `worker.instance.get` in `src/worker/contract.ts`.
  3. Add `credentials` to the answer of `worker.host.get`, from `heldCopies(tx, host)` with health.
  4. Wire `connectedInstancesOf` and `hostOf` into the LLM dependencies in `src/apps/server/index.ts`.
- Cite: D8.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/instances.test.ts src/worker/hosts.test.ts` passes.

### 03.7 Update the CLI pages

- Files: `docs/cli/llm.md`, `docs/cli/agent.md`, `docs/cli/worker.md` (edit)
- Do:
  1. In `docs/cli/llm.md:104-105` and `:172-181`, name the host holder, the copy holder and the worker-token scope. In `:374-386`, add the login on a host and its runner. Replace `llm.credential.instance_unknown` in the error table (`:515`) with `llm.credential.holder_unknown`. Extend `credential.login.instance_unavailable` (`:481`) to a host with no connected instance.
  2. In `docs/cli/agent.md:381` and `:395-401`, name the host as a holder of a cooldown.
  3. In `docs/cli/worker.md`, add `holder` and `health.reported_by` to the credentials of `instance get` (`:652`) and to `host get`. Add `holder` to the work read item.
- Verify: `pnpm exec prettier --check docs/cli/llm.md docs/cli/agent.md docs/cli/worker.md`.

### 03.8 Regenerate the OpenAPI document

- Files: `static/` (generated)
- Do: run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit the result.
- Verify: `git status --porcelain static/` prints nothing after the commit.

### 03.E Run the gate

- Do: run the gate row 03 of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

No new row. Plan 08 runs the live `worker` placement e2e with one host copy.

## Blockers

None.
