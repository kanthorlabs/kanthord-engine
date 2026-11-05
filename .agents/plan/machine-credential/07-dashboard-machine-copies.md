# Plan 07: Dashboard — the machine and instance credentials

## Scope

This plan shows the machine copies of decisions D6 to D12 in the dashboard:

- The machine page gets its credentials.
- The instance page shows each copy that the instance uses, with its holder.
- The Reset key dialog of an instance lists only its own copies.
- `Also seal to` lists the machines.
- The sign-in on a machine runs on a connected instance of the machine.
- The `/llm` description line names the machine pages.

Out of scope:

- The machine screens without credentials. Plan 06 adds them.
- A new action on a copy. The actions of an instance copy (`Add credential`, rotate, `Sign in again`, `Edit models`) apply to a machine copy with the machine as holder.

## Model

Sonnet at high effort. The change stays in the worker and machine screens and in the credential list line.

## Sources

- Root pull request of plan 01: `architecture.impl.md` "The machine pages" and "The worker pages"; `docs/reference/worker/instance.html`; `docs/reference/llm/credential.html`.
- Apps `src/api/types.ts:146-159` — `InstanceCredentialCopy` and `WorkerInstanceDetail`.
- Apps `src/features/workers/instance/instance-screen.tsx:300-330`, `:384`, `:522-530` — the health line and the Credentials section.
- Apps `src/features/workers/instance/components/credential-add-sheet.tsx:85-95` — `Also seal to`.
- Apps `src/features/workers/instance/components/reset-key-dialog.tsx:49-53` — the credential copies of the Reset key dialog.
- Apps `src/features/workers/instance/components/holder-toggle.tsx`, `credential-rotate-sheet.tsx`, `sign-in-again-sheet.tsx`, `copy-models-sheet.tsx` and their hooks `use-instance-credential-add.ts`, `use-instance-credential-rotate.ts`, `use-instance-sign-in.ts`, `use-instance-copy-models.ts`.
- Apps `src/features/credentials/list/credentials-screen.tsx:31` — the `/llm` description line.
- Apps `src/features/overview/components/board-rotate-sheet.tsx` and `src/features/overview/use-board-rotate.ts` — the holder lines of the board rotate.

## Depends on

Engine plan 03 and apps plan 06 merged. Start from `origin/main` of `kanthorlabs/kanthord-apps` after both merges.

## Provides

- `holder` of `InstanceCredentialCopy` and `reported_by` of `CopyHealth`.
- `credentials` of `WorkerMachineDetail`.
- The credential sheets of a holder, shared by the instance page and the machine page.

## Tasks

### 07.1 Write the tests of the copies

- Files: `src/features/machines/view/machine-screen.test.tsx`, `src/features/workers/instance/instance-screen.test.tsx`, `src/features/credentials/list/credentials-screen.test.tsx`, `src/features/overview/components/board-rotate-sheet.test.tsx` (edit)
- Do:
  1. Machine page: the Credentials section lists each copy with `<name> · <platform> (v<revision>)`. Each copy has the health line "<hint> Reported by <reported_by> at <time>.". The section offers `Add credential`, rotate, `Sign in again` and `Edit models` for the machine as holder.
  2. Machine page: `Sign in again` on a machine copy that is not live opens the sign-in panel. A 409 `credential.login.instance_unavailable` shows "No instance of <machine> is connected. Start one instance of the machine, then sign in again."
  3. Instance page: the Credentials section lists the own copies with the line "Own copy" and the machine copies with the line "Shared from machine <machine>". A machine copy row links to the machine page and holds no action of its own.
  4. Instance page: the machine holds a copy of the name. Then `Add credential` states "The instance uses this copy in place of the copy of machine <machine>."
  5. `Also seal to` lists the live machines first, then the live instances at the `worker` placement, grouped by worker.
  6. `/llm`: the description line ends with "Machine and instance credentials live on the machine and worker pages."
  7. Instance page: the Reset key dialog lists only the copies whose `holder` is the instance. A machine copy of the instance shows in no Reset key dialog of the instance.
  8. Board rotate: an OAuth holder line reads "<holder> keeps its own secret. Sign in again on its machine page or its worker instance page." The holder lines end with "Open machines" and "Open workers".
- Verify: `pnpm test` fails on the new tests only.

### 07.2 Add the types and the mock

- Files: `src/api/types.ts`, `mock/machines.mjs`, `mock/instances.mjs` (edit)
- Do:
  1. Add `holder` to `InstanceCredentialCopy` (`src/api/types.ts:146-152`). Add `reported_by` to `CopyHealth`. Add `credentials` to `WorkerMachineDetail`.
  2. In the mock, answer the used copies of an instance and the copies of a machine, by the copy holder rule of decision D4. Accept a machine in `holders` of a create and in `holder` of a login.
  3. Replace `llm.credential.instance_unknown` with `llm.credential.holder_unknown` in `src` and in `mock`.
- Verify: `pnpm run typecheck`.

### 07.3 Share the credential sheets of a holder

- Files: `src/features/workers/instance/components/*.tsx`, `src/features/workers/instance/use-instance-*.ts`, `src/features/machines/view/**` (edit)
- Do:
  1. Give each credential sheet and its hook a `holder` input in place of the instance name. Keep each hook beside its screen.
  2. Render the Credentials section of the machine page with these sheets and the machine as holder.
  3. On the instance page, render the holder line of each copy from `holder`. Render the actions only for an own copy. Render a link to the machine page for a machine copy.
  4. In the health line (`src/features/workers/instance/instance-screen.tsx:300-330`), read the reporter from `reported_by`.
  5. In `Also seal to`, add the group `Machines` first.
  6. Map 409 `credential.login.instance_unavailable` of a machine sign-in to the text of task 07.1 step 2.
  7. In the Reset key dialog of the instance (`src/features/workers/instance/components/reset-key-dialog.tsx:49-53`), list only the copies whose `holder` is the instance.
- Cite: D6, D7, D8, D11, D12.
- Verify: `pnpm test` passes the tests of task 07.1 steps 1 to 5 and 7.

### 07.4 Update the credential lines

- Files: `src/features/credentials/list/credentials-screen.tsx`, `src/features/overview/components/board-rotate-sheet.tsx`, `src/features/overview/use-board-rotate.ts` (edit)
- Do:
  1. Replace "Instance credentials live on the worker pages." (`src/features/credentials/list/credentials-screen.tsx:31`) with "Machine and instance credentials live on the machine and worker pages."
  2. In the board rotate sheet, write the holder line and the two links of task 07.1 step 8. The board read holds no holder kind, so the sheet names both pages.
- Cite: D15.
- Verify: `pnpm test` passes the tests of task 07.1 steps 6 and 8.

### 07.E Run the gate

- Do:
  1. Run the gate row 07 of `00-index.md`.
  2. Run `pnpm dev:all`. Open each screen at 1280 by 800 and at 390 by 844.
  3. Open a machine page with copies, and an instance page with an own copy and a machine copy. Open `Add credential` and the sign-in panel of a machine.
- Verify: every command of the row exits 0, and each screen shows the same information at both widths.

## Blockers

None.
