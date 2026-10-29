# Plan 05: Dashboard — the project of the worker pages

## Scope

Repository: `kanthorlabs/kanthord-apps`.

This plan fixes defect K6 of the worker-routing dogfood run of 2026-10-29. The worker page of `coder@1` listed one `coder` binding with "Instances none", the binding of the scratch project. The binding `coder` of the dogfood project, with `coder-1`, `coder-2` and `coder-3`, did not show.

Root cause:

- The dashboard has no project selector. `ProjectProvider` takes the first project of the project list when no project is selected (`src/features/projects/project-context.tsx:23`). `project.list` orders the projects by identity, newest first (engine `src/project/store.ts:176`). The newest project, the scratch project of the gate check, was therefore the current project.
- The readiness link `Open workers` opens `/workers?project=<project>` (`src/features/projects/view/use-project-readiness.ts:219`, root `docs/brainstorm/architecture.impl.md:1657`).
- `useWorkers` (`src/features/workers/catalogue/use-workers.ts:29`) and `useWorkerPage` (`src/features/workers/worker/use-worker-page.ts:31`) read `useProjectId()` and ignore `?project=`. Only the Overview and the scheduler board read the query, through `useScopedProject` (`src/features/overview/use-overview.ts:78`, `src/features/scheduler/board/use-scheduler-board.ts:181`).

The fix follows decision D9: `/workers` and the worker page read `?project=` and fall back to the current project of `ProjectProvider`.

Out of scope:

- A project selector on the worker pages. No design page asks for one.
- The bindings of the instance page. They come from `worker.instance.get` over every project (`architecture.impl.md:1261`). Task 05.3 changes only its links.

## Model

Sonnet at high effort. The change adds one hook and moves two readers to it.

## Sources

- `docs/brainstorm/architecture.impl.md:1255-1256` — the Bindings and the Live registrations sections of the worker page show the current project.
- `docs/brainstorm/architecture.impl.md:1657` — `Open workers` opens `/workers?project=<project>`.
- `apps/AGENTS.md` "Architecture" — a hook that more than one screen shares lives in `src/hooks`; derivation lives in a hook beside the screen.

## Depends on

- Plan 02 merged to `main` of the apps repository, because both plans edit `src/features/workers/worker/use-worker-page.ts`.
- Plan 04 runs in parallel. No file overlaps.

## Provides

`/workers?project=<id>` and `/workers/<worker>?project=<id>` show the worker bindings and the live registrations of that project. No API type changes.

## Tasks

### 05.1 Write the reproducing tests

- Files: `src/features/workers/worker/worker-screen.test.tsx`, `src/features/workers/catalogue/workers-screen.test.tsx` (edit)
- Do:
  1. Change the mock of `@/features/projects/project-context` in both files (`worker-screen.test.tsx:24-26`, `workers-screen.test.tsx:15-17`). It keeps `useProjectId: () => "prj-test"` and adds `useProject` that answers `projects` with `prj-test` and `prj-b` and `project` `prj-test`.
  2. In `worker-screen.test.tsx`, add the test "reads the bindings of the project of the query". Mount the screen at `/workers/coder%401?project=prj-b` with a variant of `mount` (`:108-117`). Assert that `listWorkerBindings` is called with `"prj-b"`.
  3. Add the test "falls back to the current project for an unknown query project". Mount at `/workers/coder%401?project=prj-unknown`. Assert that `listWorkerBindings` is called with `"prj-test"`.
  4. In `workers-screen.test.tsx`, add the test "reads the project of the query". Render at `/workers?project=prj-b` with `MemoryRouter initialEntries` (`:87-89`). Assert that `listWorkerBindings` and `listWorkerRegistrations` are called with `"prj-b"`, and that the link `Open coder@1` points to `/workers/coder%401?project=prj-b`.
- Verify: `pnpm exec vitest run src/features/workers` fails on the new tests only.

### 05.2 Read the project of the query

- Files: `src/features/workers/use-workers-project-id.ts` (new), `src/features/workers/catalogue/use-workers.ts`, `src/features/workers/worker/use-worker-page.ts` (edit)
- Do:
  1. Add `useWorkersProjectId(): string` in `src/features/workers/use-workers-project-id.ts`. It reads `projectId` of `useScopedProject()` and `projects` and `project` of `useProject()`. It answers the query value when `projects` holds that identity, else `project?.id ?? ""`.
  2. `useWorkers` (`use-workers.ts:29`) and `useWorkerPage` (`use-worker-page.ts:31`) call `useWorkersProjectId()` in place of `useProjectId()`. Remove each import of `useProjectId` that becomes unused.
- Cite: decision D9.
- Verify: the tests of steps 2 and 3 of task 05.1 pass.

### 05.3 Keep the project on the links between the worker pages

- Files: `src/lib/worker-paths.ts`, `src/lib/worker-paths.test.ts`, `src/features/workers/catalogue/workers-screen.tsx`, `src/features/workers/catalogue/components/binding-instance-item.tsx`, `src/features/workers/worker/worker-screen.tsx`, `src/features/workers/instance/instance-screen.tsx`, `src/features/projects/view/components/instances-field.tsx`, `src/features/projects/view/components/instance-add-sheet.tsx` and their tests (edit)
- Do:
  1. `workerPagePath(workerName, projectId?)` and `instancePagePath(workerName, instanceName, projectId?)` (`src/lib/worker-paths.ts:1-7`) append `?project=<encoded project id>` when `projectId` is a nonempty string. A test of `worker-paths.ts` asserts both forms of both functions.
  2. The `Open` link of a worker card (`workers-screen.tsx:55`) and the link "Open the worker page" (`binding-instance-item.tsx:24`) pass the project of `useWorkersProjectId()`. Read the value in the screen hook, not in the component body, under `apps/AGENTS.md` "A component body holds no business logic".
  3. The worker page opens an instance page with the project of `useWorkersProjectId()` (`worker-screen.tsx:353`).
  4. The instance page keeps the query on its links back to the worker page: the header link (`instance-screen.tsx:94`), the navigation after an archive (`:469`) and the button of the read failure (`:600`). They pass the project of `useWorkersProjectId()`.
  5. The links of the project page to a worker page pass the project of that page: "worker page" of `instances-field.tsx:71` and `:115`, and "Add a worker instance on the worker page" of `instance-add-sheet.tsx:75`. Pass the project identity into these components from the binding sheet that renders them, as a prop.
- Verify: `pnpm exec vitest run src/lib src/features/workers src/features/projects` passes, the tests of task 05.1 included.

### 05.E Run the gate

- Do:
  1. Run the gate row 05 of `00-index.md`.
  2. Start `pnpm dev:all`. With the `ego-browser` skill, open the project page of the second mock project at 1280 by 800 and at 390 by 844 (root `AGENTS.md:177-179`).
  3. Click `Open workers` of the readiness list. Check that `/workers?project=<that project>` shows its worker bindings. Click `Open` on a worker card. Check that the worker page keeps `?project=` and shows the bindings of that project.
- Verify: every command of the row exits 0, and each check of step 3 holds at both widths with no horizontal page scroll.

## E2E

The apps repository holds no engine E2E. The browser check of task 05.E is the end-to-end proof against the mock daemon.

## Blockers

None.
