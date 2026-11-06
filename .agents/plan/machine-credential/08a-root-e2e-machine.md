# Plan 08a: Root — one dev machine for the `worker` placement e2e

## Scope

After plan 02, `worker.instance.create` at the `worker` placement requires `machine` (decision D3, ruling O1). This plan moves the root e2e scripts of the `worker` placement to one dev machine `e2e-machine`:

- The preparation creates `e2e-machine` once and keeps its machine file in the machine home.
- Each dev instance at the `worker` placement names `e2e-machine`.
- Each instance process receives the machine configuration through `KANTHORD_MACHINE_CONFIG`.

The run keeps one sign-in for each dev instance. Plan 08b changes it to one sign-in for the machine.

The plan moves the root `engine` pointer and updates the root `AGENTS.md` e2e text that describes the machine.

Out of scope:

- The sign-in for the machine copy. Plan 08b adds it.
- The `apps` pointer. Plan 08b moves it.
- The `server` and the `container` placement e2e. They name no machine.
- The homelab container (`platforms/homelab`). It runs a server, not a `worker` instance.

## Model

Sonnet at high effort. The change stays in `scripts/e2e/` and in the root `AGENTS.md`.

## Sources

- Root `AGENTS.md` "Repository tooling": the `make e2e`, `make e2e-start`, `make e2e-scale` and `make e2e-restart` rules, and the dev instance rules of the `worker` placement.
- Root `scripts/e2e/instances.mjs:21-35`, `:55-63`, `:129-160`, `:180-214` — the dev instance names, the instance home, the instance create and the process start.
- Root `scripts/e2e/scale.mjs`, `scripts/e2e/restart-steps.mjs` — the scale and the restart of the `worker` placement.
- `docs/cli/worker.md` "Worker machines" of engine plan 02.

## Depends on

Engine plan 02 merged. Start from `origin/main` of `kanthorlabs/kanthord` right after that merge.

## Provides

- `make e2e PLACEMENT=worker` with one dev machine `e2e-machine` and one sign-in for each dev instance.
- `ensureMachine(api, cli, home)` of `scripts/e2e/instances.mjs`, for plan 08b.
- The root `engine` pointer at the merge of plan 02.
- `docs/reference/workbench/tools.md` regenerated from the engine operations.

## Tasks

### 08a.1 Write the tests of the dev machine

- Files: `scripts/e2e/instances.test.mjs` (edit)
- Do:
  1. Add a test that the preparation of the `worker` placement creates the dev machine `e2e-machine` once. It writes the machine file into `.dev/e2e/machines/e2e-machine/`.
  2. Add a test that each dev instance at the `worker` placement is created with `--machine e2e-machine`.
  3. Add a test that the start of an instance process sets `KANTHORD_MACHINE_CONFIG` to the machine configuration value.
  4. Add a test that the preparation creates `e2e-machine` again when the server holds no record of it. Add a test that a live record with no local machine file rotates the machine key with `--force`.
- Verify: `node --test scripts/e2e/instances.test.mjs` fails on the new tests only.

### 08a.2 Create the dev machine

- Files: `scripts/e2e/instances.mjs`, `scripts/e2e/scale.mjs`, `scripts/e2e/restart-steps.mjs` (edit)
- Do:
  1. Add `ensureMachine(api, cli, home)`. It creates `e2e-machine` with `kanthord worker machine create e2e-machine --output` under the machine home `.dev/e2e/machines/e2e-machine/`.
  2. In `ensureMachine`, create the machine again when the server holds no record of it. Rotate the machine key with `--force` when the record is live and the local machine file is absent or of another key.
  3. In `ensureInstance` (`:129-160`), add `--machine e2e-machine` to the create at the `worker` placement.
  4. In `startInstanceProcess` (`:180-186`), give the process the machine configuration value as `KANTHORD_MACHINE_CONFIG`.
  5. Call `ensureMachine` before the instances in the start, the scale and the restart of the `worker` placement.
  6. Keep `signInGaps` (`:327-345`) unchanged.
- Cite: D3, D5.
- Verify: `node --test scripts/e2e/*.test.mjs` passes.

### 08a.3 Update the root e2e text

- Files: `AGENTS.md` (edit)
- Do:
  1. State that the preparation of the `worker` placement creates the dev machine `e2e-machine`, and that each dev instance names it.
  2. Add the dev machine home `.dev/e2e/machines/e2e-machine/` beside the instance home `.dev/e2e/instances/<name>/`.
  3. Keep the sign-in rules of each dev instance.
- Verify: `rg -n 'e2e-machine' AGENTS.md` prints the new lines.

### 08a.4 Move the engine pointer and regenerate the tools page

- Files: `engine` (gitlink), `docs/reference/workbench/tools.md` (generated)
- Do:
  1. Move `engine` to its `origin/main` head that holds plan 02. The pre-commit hook refuses a gitlink that is not on `origin/main` (root `AGENTS.md` "Repository tooling").
  2. Run `make docs-tools`. Commit the result.
- Verify: `make docs-tools` leaves no diff after the commit.

### 08a.E Run the gate

- Do:
  1. Run the gate row 08a of `00-index.md`.
  2. Reset the dev database. Run `make e2e PLACEMENT=worker`. Sign in for each dev instance when the run asks.
  3. Run it again, and confirm that each dev instance names `e2e-machine` and claims work.
  4. Run `make e2e-stop RUN=<name> STOP=daemon`.
- Verify: every command exits 0.

## Blockers

None.
