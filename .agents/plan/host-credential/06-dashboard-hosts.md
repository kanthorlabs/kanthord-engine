# Plan 06: Dashboard — the hosts

## Scope

This plan adds the host screens of decision D15 to the dashboard: the list `/hosts`, the form `/hosts/new` and the host page `/hosts/:hostName`. It adds the field `Host` to `Add instance` at the `worker` placement, and the host link to the instance page. The host page shows no credential yet. Plan 07 adds the credentials.

Out of scope:

- The credentials of the host page and of the instance page. Plan 07 adds them.
- A key generation in the browser. The server generates the host key pair, as for an instance (root `architecture.impl.md:1283`).

## Model

Sonnet at high effort. The change stays in the worker screens of the dashboard. It copies the resource screens of `src/features/credentials` (apps `AGENTS.md` "Resource screens").

## Sources

- Root pull request of plan 01: `architecture.impl.md` "The host pages" and "The worker pages"; `docs/reference/worker/host.html`.
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

- `src/api/resources/worker-hosts.ts` with one function for each `worker.host.*` operation.
- The types `WorkerHost`, `WorkerHostListItem`, `WorkerHostDetail`, `WorkerHostCreateBody` and `WorkerHostWriteAnswer`, and `host` of `WorkerInstance` and `WorkerInstanceCreateBody`.
- The screens `/hosts`, `/hosts/new` and `/hosts/:hostName`, and the sidebar item `Hosts`.

## Tasks

### 06.1 Write the tests of the host screens

- Files: `src/api/resources/worker-hosts.test.ts` (new), `src/features/hosts/list/hosts-screen.test.tsx` (new), `src/features/hosts/form/host-form-screen.test.tsx` (new), `src/features/hosts/view/host-screen.test.tsx` (new), `src/features/workers/worker/worker-screen.test.tsx`, `src/features/workers/instance/instance-screen.test.tsx` (edit)
- Do:
  1. Copy the request tests of `worker-instances.test.ts` for each host function.
  2. List: each row shows `<name> (v<revision>)`, the short fingerprint and the instance count, with a link to the host page.
  3. Form: the save sends `{ name }`. The answer shows `host_configuration` once with `Copy`, the warning that it shows only once, and the host copy block. The form validates the reserved names before it sends.
  4. Host page: the header, the instances with their connection line and a link to each instance page, and the danger zone. Reset key shows the instances and states the recovery text of plan 01. Archive stays disabled while a live instance names the host, and lists them.
  5. Add instance: at the `worker` placement, the `Host` select lists the live hosts and is required. With no live host, it shows `Add host`, a link to `/hosts/new`. The save sends `host`.
  6. Instance page: a `worker` instance shows `Host <name>` with a link to the host page.
  7. Each screen renders at 390 px with one column.
- Verify: `pnpm test` fails on the new tests only.

### 06.2 Add the resource and the types

- Files: `src/api/types.ts`, `src/api/resources/worker-hosts.ts` (new), `mock/hosts.mjs` (new), `mock/daemon.mjs`, `mock/instances.mjs` (edit)
- Do:
  1. Add the host types to `src/api/types.ts`, by the OpenAPI document of engine plan 02. Add `host` to `WorkerInstance` and `WorkerInstanceCreateBody` (`src/api/types.ts:112-170`).
  2. Add `worker-hosts.ts` after the pattern of `worker-instances.ts`.
  3. Add `registerHosts` to the mock daemon, after the pattern of `registerInstances` (`mock/instances.mjs:50`). Give the mock `worker` instances a host. Register it in `mock/daemon.mjs:14`.
- Cite: apps `AGENTS.md` "Architecture" (a new operation also updates `mock/`).
- Verify: `pnpm run typecheck`.

### 06.3 Add the host screens

- Files: `src/features/hosts/**` (new), `src/components/app-nav.ts`, `src/components/app-router.tsx` (edit)
- Do:
  1. Add the item `{ to: "/hosts", label: "Hosts", group: "Workforce" }` after `Workers` (`src/components/app-nav.ts:37`).
  2. Add the routes `hosts`, `hosts/new` and `hosts/:hostName` (`src/components/app-router.tsx:54-58`).
  3. Copy the three screens of `src/features/credentials`. Put each read, each write and each error map in a hook beside its screen.
  4. Reuse `instance-configuration.tsx` for `host_configuration`. Add the host copy block of plan 01 as one block for every host kind.
  5. Reuse the Reset key and Archive pattern of `use-instance-reset.ts` and `use-instance-archive.tsx`.
- Cite: D15; apps `AGENTS.md` "Resource screens".
- Verify: `pnpm test` passes the tests of task 06.1 steps 1 to 4.

### 06.4 Add the host to the instance screens

- Files: `src/features/workers/worker/use-instance-create.ts`, `src/features/workers/worker/worker-screen.tsx`, `src/features/workers/instance/instance-screen.tsx`, `src/features/workers/instance/use-instance-page.ts` (edit)
- Do:
  1. In `use-instance-create.ts`, read the live hosts. At the `worker` placement, require `host` and send it.
  2. In the Add instance sheet, add the `Host` select after **Placement**, with `Add host` when no live host exists.
  3. In the instance page header, add `Host <name>` with a link to `/hosts/<name>`.
- Cite: D3, D15.
- Verify: `pnpm test` passes the tests of task 06.1 steps 5 and 6.

### 06.E Run the gate

- Do:
  1. Run the gate row 06 of `00-index.md`.
  2. Run `pnpm dev:all`. Open `/hosts`, `/hosts/new`, a host page, `Add instance` and an instance page at 1280 by 800 and at 390 by 844. Check that no page scrolls horizontally.
- Verify: every command of the row exits 0, and each screen shows the same information at both widths.

## Blockers

None. Ruling O1 alternative A makes the `Host` select optional in task 06.4.
