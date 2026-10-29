# Plan 01: Worker Service — no holder mismatch on a server instance

## Scope

This plan fixes defect K5 of the worker-routing dogfood run of 2026-10-29. The worker page of the dashboard showed "Credential copy missing" on `coder-1`, `coder-2` and `coder-3`. These instances run at the `server` placement and use the copy of the holder `server`.

The dashboard shows the badge from `holder_mismatch` of `worker.instance.list` (apps `src/features/workers/worker/worker-screen.tsx:168`). The engine computes that value with the instance name as the holder for every placement:

- `WorkerInstances.list` sets `holder_mismatch` for every record (`src/worker/instances.ts:536-545`).
- `WorkerService.holderMismatch` passes `{ holders: [instanceName], claimant: null }` to the agent view (`src/worker/service.ts:304-325`, `:319`).
- A server instance holds no copy of its own. The agent view then reports `agent.configuration.credential_holder_mismatch`, and the item answers `true`.

The design states that the value is `false` for a server instance (`docs/brainstorm/worker-service.impl.md:544`, decision D2). The mock daemon of the apps repository already answers `false` (apps `mock/instances.mjs:158`).

Out of scope:

- The badge rule of the dashboard. The dashboard shows the badge from the engine value. After this plan, the value is `false` for a server instance.
- The holders of a binding apply (`src/project/contract.ts:280-289`). They already use `server` for a server instance.
- `worker.instance.get`. It answers no `holder_mismatch`.

## Model

Sonnet at high effort. The change is one condition in one service, with one test.

## Sources

- `docs/brainstorm/worker-service.impl.md:544` — `holder_mismatch` is `false` for a server instance.
- `docs/brainstorm/architecture.impl.md:1254` — a `worker` row shows the holder-mismatch badge.
- Root `docs/reference/project/binding.md:153` — a `server` or `container` instance uses the `server` copy.
- `docs/cli/worker.md:41-42` — the server instances are the `server` and the `container` placements.
- `docs/cli/worker.md:628` — the CLI text of `holder_mismatch`.

## Depends on

Nothing. Start from `origin/main` of `kanthorlabs/kanthord-engine`. Plan 03 also edits the engine, in other files.

## Provides

`worker.instance.list` answers `holder_mismatch: false` for each `server` and `container` instance. No seam changes. No operation shape changes.

## Tasks

### 01.1 Write the reproducing test

- Files: `src/worker/instances.test.ts` (edit)
- Do:
  1. Add one test after the test "list pages instances by name with their binding count and holder mismatch" (`src/worker/instances.test.ts:1083`). Name it "list answers no holder mismatch for a server and a container instance".
  2. In the test, create `beta` with `f.createdAt("beta", InstancePlacement.Server)` and `gamma` with `f.createdAt("gamma", InstancePlacement.Container)`.
  3. Push `bindingOf(createIdentity("project"), "coder", ["beta", "gamma"])` into `f.bindings`.
  4. Call `f.invoke("instance.list", null, {}, {})`.
  5. Assert that the items map to `[["beta", 1, false], ["gamma", 1, false]]` as `[name, binding_count, holder_mismatch]`.
  6. Assert that `f.scopes` deep-equals `[]`. The fixture agent view always reports the mismatch (`src/worker/instances.test.ts:221-224`), so an empty list proves that the service runs no agent view for a server instance.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/instances.test.ts` fails on the new test only. The failure shows `true` for `beta` and `gamma`.

### 01.2 Answer no holder mismatch for a server instance

- Files: `src/worker/instances.ts` (edit)
- Do:
  1. In `WorkerInstances.list` (`src/worker/instances.ts:536-545`), set `holder_mismatch` to `false` when `record.placement` is not `InstancePlacement.Worker`.
  2. Call `this.dependencies.holderMismatch` only for a `worker` instance. Keep the call arguments unchanged.
  3. Change no other method. `WorkerService.holderMismatch` (`src/worker/service.ts:304-325`) stays as it is.
- Cite: decision D2; `worker-service.impl.md:544`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/instances.test.ts` passes, the new test included. The test of `src/worker/instances.test.ts:1083` still answers `[["alpha", 1, true]]` and the scope `{ holders: ["alpha"], claimant: null }`.

### 01.3 Update the CLI page

- Files: `docs/cli/worker.md` (edit)
- Do: append one sentence to `docs/cli/worker.md:628`: "It is `false` for a `server` or a `container` instance, which uses the copy of the holder `server`."
- Cite: `worker-service.impl.md:544`.
- Verify: `pnpm exec prettier --check docs/cli/worker.md`.

### 01.E Run the gate

- Do: run the gate row 01 of `00-index.md`.
- Verify: every command of the row exits 0, and the `git status` check prints nothing.

## E2E

No new row. The test of task 01.1 drives the operation through the operation registry of the Worker Service.

## Blockers

None.
