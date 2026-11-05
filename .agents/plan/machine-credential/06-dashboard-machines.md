# Plan 06: Dashboard — the machines

## Scope

This plan adds the machine screens of decision D15 to the dashboard: the list `/machines`, the form `/machines/new` and the machine page `/machines/:machineName`. It adds the field `Machine` to `Add instance` at the `worker` placement, and the machine link to the instance page. The machine page shows no credential yet. Plan 07 adds the credentials.

Out of scope:

- The credentials of the machine page and of the instance page. Plan 07 adds them.
- A key generation in the browser. The server generates the machine key pair, as for an instance (root `architecture.impl.md:1283`).

## Model

Sonnet at high effort. The change stays in the worker screens of the dashboard. It copies the resource screens of `src/features/credentials` (apps `AGENTS.md` "Resource screens").

## Sources

- Root pull request of plan 01: `architecture.impl.md` "The machine pages" and "The worker pages"; `docs/reference/worker/machine.html`.
- Apps `src/components/app-nav.ts:28-39` — the sidebar groups and items.
- Apps `src/components/app-router.tsx:54-58` — the worker routes.
- Apps `src/api/resources/worker-instances.ts:1-40` — the instance resource functions.
- Apps `src/api/types.ts:112-170` — `WorkerInstance`, `WorkerInstanceDetail` and `WorkerInstanceCreateBody`.
- Apps `src/features/workers/worker/use-instance-create.ts`, `src/features/workers/components/host-fields.tsx`, `src/features/workers/components/instance-configuration.tsx` — the Add instance sheet, the host kind fields and the configuration block.
- Apps `src/features/workers/instance/instance-screen.tsx`, `use-instance-reset.ts`, `use-instance-archive.tsx` — the instance page, Reset key and Archive.
- Apps `mock/instances.mjs:50` — `registerInstances` of the mock daemon.

## Depends on

Engine plan 02 merged. Start from `origin/main` of `kanthorlabs/kanthord-apps`.

## Provides

- `src/api/resources/worker-machines.ts` with one function for each `worker.machine.*` operation.
- The types `WorkerMachine`, `WorkerMachineListItem`, `WorkerMachineDetail`, `WorkerMachineCreateBody` and `WorkerMachineWriteAnswer`, and `machine` of `WorkerInstance` and `WorkerInstanceCreateBody`.
- The screens `/machines`, `/machines/new` and `/machines/:machineName`, and the sidebar item `Machines`.

## Tasks

### 06.1 Write the tests of the machine screens

- Files: `src/api/resources/worker-machines.test.ts` (new), `src/features/machines/list/machines-screen.test.tsx` (new), `src/features/machines/form/machine-form-screen.test.tsx` (new), `src/features/machines/view/machine-screen.test.tsx` (new), `src/features/workers/worker/worker-screen.test.tsx`, `src/features/workers/instance/instance-screen.test.tsx` (edit)
- Do:
  1. Copy the request tests of `worker-instances.test.ts` for each machine function.
  2. List: each row shows `<name> (v<revision>)`, the short fingerprint and the instance count, with a link to the machine page.
  3. Form: the save sends `{ name }`. The answer shows `machine_configuration` once with `Copy`, the warning that it shows only once, and the machine copy block. The form validates the reserved names before it sends.
  4. Machine page: the header, the instances with their connection line and a link to each instance page, and the danger zone. Reset key shows the instances and states the recovery text of plan 01. Archive stays disabled while a live instance names the machine, and lists them.
  5. Add instance: at the `worker` placement, the `Machine` select lists the live machines and is required. With no live machine, it shows `Add machine`, a link to `/machines/new`. The save sends `machine`.
  6. Instance page: a `worker` instance shows `Machine <name>` with a link to the machine page.
  7. Each screen renders at 390 px with one column.
- Verify: `pnpm test` fails on the new tests only.

### 06.2 Add the resource and the types

- Files: `src/api/types.ts`, `src/api/resources/worker-machines.ts` (new), `mock/machines.mjs` (new), `mock/daemon.mjs`, `mock/instances.mjs` (edit)
- Do:
  1. Add the machine types to `src/api/types.ts`, by the OpenAPI document of engine plan 02. Add `machine` to `WorkerInstance` and `WorkerInstanceCreateBody` (`src/api/types.ts:112-170`).
  2. Add `worker-machines.ts` after the pattern of `worker-instances.ts`.
  3. Add `registerMachines` to the mock daemon, after the pattern of `registerInstances` (`mock/instances.mjs:50`). Give the mock `worker` instances a machine. Register it in `mock/daemon.mjs:14`.
- Cite: apps `AGENTS.md` "Architecture" (a new operation also updates `mock/`).
- Verify: `pnpm run typecheck`.

### 06.3 Add the machine screens

- Files: `src/features/machines/**` (new), `src/components/app-nav.ts`, `src/components/app-router.tsx` (edit)
- Do:
  1. Add the item `{ to: "/machines", label: "Machines", group: "Workforce" }` after `Workers` (`src/components/app-nav.ts:37`).
  2. Add the routes `machines`, `machines/new` and `machines/:machineName` (`src/components/app-router.tsx:54-58`).
  3. Copy the three screens of `src/features/credentials`. Put each read, each write and each error map in a hook beside its screen.
  4. Reuse `instance-configuration.tsx` for `machine_configuration`. Add the machine copy block of plan 01 as one block for every host kind.
  5. Reuse the Reset key and Archive pattern of `use-instance-reset.ts` and `use-instance-archive.tsx`.
- Cite: D15; apps `AGENTS.md` "Resource screens".
- Verify: `pnpm test` passes the tests of task 06.1 steps 1 to 4.

### 06.4 Add the machine to the instance screens

- Files: `src/features/workers/worker/use-instance-create.ts`, `src/features/workers/worker/worker-screen.tsx`, `src/features/workers/instance/instance-screen.tsx`, `src/features/workers/instance/use-instance-page.ts` (edit)
- Do:
  1. In `use-instance-create.ts`, read the live machines. At the `worker` placement, require `machine` and send it.
  2. In the Add instance sheet, add the `Machine` select after **Placement**, with `Add machine` when no live machine exists.
  3. In the instance page header, add `Machine <name>` with a link to `/machines/<name>`.
- Cite: D3, D15.
- Verify: `pnpm test` passes the tests of task 06.1 steps 5 and 6.

### 06.E Run the gate

- Do:
  1. Run the gate row 06 of `00-index.md`.
  2. Run `pnpm dev:all`. Open `/machines`, `/machines/new`, a machine page, `Add instance` and an instance page at 1280 by 800 and at 390 by 844. Check that no page scrolls horizontally.
- Verify: every command of the row exits 0, and each screen shows the same information at both widths.

## Blockers

None.
