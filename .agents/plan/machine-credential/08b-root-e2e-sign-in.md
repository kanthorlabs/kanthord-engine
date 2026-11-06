# Plan 08b: Root — one sign-in for the dev machine

## Scope

This plan makes the root e2e run of the `worker` placement ask for one sign-in for the dev machine `e2e-machine`. Today the run asks for one sign-in for each dev instance (decision D12). Plan 08a created the dev machine.

The plan moves the root `engine` and `apps` pointers and updates the root `AGENTS.md` sign-in text.

Out of scope:

- The dev machine and the `--machine` option of each dev instance. Plan 08a adds them.
- The `server` and the `container` placement e2e. They keep the copy of the holder `server`.
- A dev instance with its own override copy. The scripts create none.

## Model

Sonnet at high effort. The change stays in `scripts/e2e/` and in the root `AGENTS.md`.

## Sources

- Root `AGENTS.md` "Repository tooling": the sign-in rules of the `worker` placement.
- Root `scripts/e2e/instances.mjs:327-345` — `signInGaps`.
- Root `scripts/e2e/instances.test.mjs:57`, `:544`, `:597` — the sign-in command tests.
- `docs/cli/llm.md` of engine plan 03.

## Depends on

Plan 08a, engine plan 04 and apps plan 07 merged. Engine plan 04 merges after engine plans 03 and 05. Start from `origin/main` of `kanthorlabs/kanthord`.

## Provides

- `make e2e PLACEMENT=worker` with one sign-in for the machine copy of `e2e-machine`.
- The root `engine` and `apps` pointers at the merged plans of this set.
- `docs/reference/workbench/tools.md` regenerated from the engine operations.

## Tasks

### 08b.1 Write the tests of the sign-in

- Files: `scripts/e2e/instances.test.mjs` (edit)
- Do:
  1. Change the tests of `signInGaps` (`:544`, `:597`). The gaps hold one command for the holder `e2e-machine`. They hold no command for a dev instance that uses the machine copy.
  2. Add a test that a machine copy sealed to an ended machine key prints the sign-in command of the machine.
- Verify: `node --test scripts/e2e/instances.test.mjs` fails on the new tests only.

### 08b.2 Sign in once for the machine

- Files: `scripts/e2e/instances.mjs` (edit)
- Do:
  1. In `signInGaps` (`:327-345`), read `machine` and `credentials` of each instance through `/api/worker/instance/<name>`.
  2. A credential with no item whose `sealed_current` is true needs a sign-in of its copy holder. The copy holder is the `holder` of the listed item, or the `machine` of the instance when no item is listed.
  3. Print one command for each such holder, once: `(cd engine && node src/main.ts llm credential login <platform> --name <credential> --holder <holder>)`.
- Cite: D7, D12.
- Verify: `node --test scripts/e2e/*.test.mjs` passes.

### 08b.3 Update the root sign-in text

- Files: `AGENTS.md` (edit)
- Do:
  1. Rewrite the rule "Each dev instance holds its own `anthropic-subscription` copy, signed in through OAuth." The dev machine `e2e-machine` holds the copy, and each dev instance at the `worker` placement uses it.
  2. Rewrite the sign-in rules. A run asks for one sign-in for `e2e-machine`. A key rotation of the machine prints that one command again.
- Verify: `rg -n 'Each dev instance holds its own' AGENTS.md` prints nothing.

### 08b.4 Move the pointers and regenerate the tools page

- Files: `engine`, `apps` (gitlinks), `docs/reference/workbench/tools.md` (generated)
- Do:
  1. Move `engine` and `apps` to their `origin/main` heads that hold the plans of this set. The pre-commit hook refuses a gitlink that is not on `origin/main` (root `AGENTS.md` "Repository tooling").
  2. Run `make docs-tools`. Commit the result.
- Verify: `make docs-tools` leaves no diff after the commit.

### 08b.E Run the gate

- Do:
  1. Run the gate row 08b of `00-index.md`.
  2. Reset the dev database. Run `make e2e PLACEMENT=worker`. Confirm that it stops once with one sign-in command for `e2e-machine`.
  3. Sign in, run it again, and confirm that each dev instance claims work with the machine copy.
  4. Run `make e2e-stop RUN=<name> STOP=daemon`.
- Verify: every command exits 0, and the run asks for exactly one sign-in.

## Blockers

None.
