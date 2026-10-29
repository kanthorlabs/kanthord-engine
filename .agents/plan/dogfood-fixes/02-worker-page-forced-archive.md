# Plan 02: Dashboard — forced Archive on the worker page

## Scope

Repository: `kanthorlabs/kanthord-apps`.

This plan fixes defect K7 of the worker-routing dogfood run of 2026-10-29. The worker page disabled Archive on `coder-4`, an unlisted server instance with a live execution. The instance page of the same instance offered Archive, and its dialog stopped the execution with `force: true`.

Root cause:

- `archiveBlockKindOf` blocks Archive with the kind `executing` when the subject holds a live execution (`src/features/workers/instance/use-instance-archive.tsx:91-97`, `:95`). The notice reads "Wait until the execution ends." (`:108-109`).
- The worker page row passes `liveExecutions` into the subject (`src/features/workers/worker/components/instance-row-actions.tsx:27-37`, from `src/features/workers/worker/worker-screen.tsx:357`). The row then shows a disabled Archive.
- The fresh read before the dialog repeats the block for a guarded subject (`use-instance-archive.tsx:113-122`, `:149`, `:170`).
- The instance page passes only `name` and `revision` (`src/features/workers/instance/instance-screen.tsx:467-472`). Its subject holds no execution, so it opens the dialog. The dialog holds the checkbox `Stop the live execution` and sends `force: true` (`use-instance-archive.tsx:150`, `:196-199`).

The design gives one rule for both pages (decision D3):

- A listing binding keeps Archive disabled (`docs/brainstorm/architecture.impl.md:1282`).
- With no listing binding and a live execution, the dialog holds the checkbox `Stop the live execution` (`architecture.impl.md:1283`).
- The worker page row of an unlisted server instance reads "Runs with no binding. Archive it to stop it." (`architecture.impl.md:1254`). Ruling N2 of 2026-10-25 gives Archive the force option that stops the live execution (root `docs/brainstorm/HANDOFF.md:89`).

Out of scope:

- The instance page. It already follows the rule.
- `mock/`. The mock daemon already answers a forced archive (`mock/instances.mjs:373-393`).
- The project of the worker page. Plan 05 owns it.

## Model

Sonnet at high effort. The change removes one block kind from one hook and the props that fed it.

## Sources

- `docs/brainstorm/architecture.impl.md:1254` — the worker page row and the unlisted notice.
- `docs/brainstorm/architecture.impl.md:1281-1283` — the Archive dialog, the listing block and the checkbox `Stop the live execution`.
- `docs/brainstorm/worker-service.impl.md:516` — the unlisted notice on the worker page and on the instance page.
- `apps/AGENTS.md:47-49` — both widths and the browser check against `pnpm dev:all`.
- Root `AGENTS.md:177-179` — the web app port, the `ego-browser` skill and the phone width.

## Depends on

Nothing. Start from `origin/main` of `kanthorlabs/kanthord-apps`. Plans 01, 03 and 04 run in parallel. Plan 05 starts after this plan merges, because both plans edit `src/features/workers/worker/use-worker-page.ts`.

## Provides

The worker page row offers Archive on an unlisted instance with a live execution. The dialog asks for `Stop the live execution` and sends `force: true`. No API type changes.

## Tasks

### 02.1 Write the reproducing tests

- Files: `src/features/workers/worker/worker-screen.test.tsx`, `src/features/workers/instance/use-instance-archive.test.tsx` (edit)
- Do:
  1. In `worker-screen.test.tsx`, add the test "offers Archive with Stop the live execution on an unlisted instance with a live execution". Mock `listWorkerInstances` with `[{ ...CODER_ONE, binding_count: 0 }]`. Mock `listAllWorkerRegistrations` with one registration of `coder@1` with `instance: "coder-1"`, `activity: "executing"`, `draining: true` and `execution_id: "execution_a"`. Mock `readWorkerInstance` with a detail of `coder-1` with `bindings: []` and the same registration.
  2. In that test, assert that the button "Archive coder-1" has no `aria-disabled="true"`. Click it. Find the alert dialog with `screen.findByRole("alertdialog")`. Assert that it shows the checkbox "Stop the live execution". Query the confirm with `within(dialog).getByRole("button", { name: "Archive coder-1" })`, as `use-instance-archive.test.tsx:195` does, and assert that it is disabled. Check the box, click the confirm, and assert that `archiveWorkerInstance` is called with `("coder-1", <revision of the detail>, { force: true })`.
  3. In `use-instance-archive.test.tsx`, add the test "opens the dialog for a guarded subject whose fresh read shows a live execution" to `describe("useInstanceArchive")`. Mock `readWorkerInstance` with `EXECUTING` (`:136-153`). Render the hook with the guarded subject `FREE` (`:23-28`), call `request`, and assert that `open` becomes `true` and `executions` deep-equals `["execution_a"]`. Today the fresh read finds the `executing` block (`use-instance-archive.tsx:120`, `:170`) and keeps the dialog closed.
  4. Copy the shapes of the existing fixtures: `CODER_ONE` (`worker-screen.test.tsx:55-66`), `EXECUTING` (`use-instance-archive.test.tsx:136-153`) and the mocks of `worker-screen.test.tsx:120-128`.
- Verify: `pnpm exec vitest run src/features/workers` fails on the two new tests only.

### 02.2 Remove the execution block of Archive

- Files: `src/features/workers/instance/use-instance-archive.tsx`, `src/features/workers/worker/components/instance-row-actions.tsx`, `src/features/workers/worker/use-worker-page.ts`, `src/features/workers/worker/worker-screen.tsx`, `src/features/workers/instance/use-instance-archive.test.tsx` (edit)
- Do:
  1. `archiveBlockKindOf` (`use-instance-archive.tsx:91-97`) answers `"listed"` for a subject with a listing binding, else `null`. `ArchiveBlock` holds `"listed"` alone. `blockNoticeOf` loses the `executing` case (`:108-109`).
  2. Remove `liveExecutions` from `ArchiveSubject` (`:23`) and from `archiveSubjectOf` (`:87`). `guarded` reads `subject.bindingCount !== undefined` alone (`:149`). Keep the exported `liveExecutionsOf` (`:76-80`), because `readingOf` (`:127`) still reads the executions for the dialog.
  3. Remove the prop `liveExecutions` of `InstanceRowActions` (`instance-row-actions.tsx:13`, `:21`, `:32`) and its value in `worker-screen.tsx:357`.
  4. Remove `liveExecutionsOf` from `WorkerPage` and `useWorkerPage` (`use-worker-page.ts:25`, `:62-67`, `:78`). Its only reader is `worker-screen.tsx:357`, which step 3 removes.
  5. Delete the test "waits for a live execution" (`use-instance-archive.test.tsx:67-73`). The test "answers null for a free instance" (`:75-77`) already covers a subject with no listing binding.
  6. Update each test fixture that sets `liveExecutions` on an `ArchiveSubject`, for example `FREE` (`use-instance-archive.test.tsx:23-28`).
- Cite: decisions D3, D4; `architecture.impl.md:1281-1283`.
- Verify: `pnpm exec vitest run src/features/workers` passes. `rg -n 'executing' src/features/workers/instance/use-instance-archive.tsx` prints nothing. `rg -n 'liveExecutionsOf' src/features/workers/worker` prints nothing. The test "offers Detach and a disabled Archive on an instance that a binding lists" (`worker-screen.test.tsx:158`) still passes.

### 02.E Run the gate

- Do:
  1. Run the gate row 02 of `00-index.md`.
  2. Start `pnpm dev:all`. With the `ego-browser` skill, open `/workers/coder@1` at 1280 by 800 and at 390 by 844 (root `AGENTS.md:177-179`).
  3. The mock registration of `coder-1` holds a live execution (`mock/fixtures.mjs:71-83`). Click Detach on the `coder-1` row and detach it from each listing binding.
  4. Check that the `coder-1` row shows "Runs with no binding. Archive it to stop it." and an enabled Archive. Click Archive. Check that the dialog lists the execution and holds the checkbox `Stop the live execution`. Check the box and confirm. Check that the row leaves the list.
- Verify: every command of the row exits 0, and each step of step 4 holds at both widths with no horizontal page scroll.

## E2E

The apps repository holds no engine E2E. The browser check of task 02.E is the end-to-end proof against the mock daemon.

## Blockers

None.
