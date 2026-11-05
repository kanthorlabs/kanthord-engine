# Plan 08: Root — one dev host for the `worker` placement e2e

## Scope

This plan moves the root e2e scripts of the `worker` placement to one dev host. Each dev instance at the `worker` placement names the dev host `e2e-host` (decision D3). The run asks for one sign-in for the host copy, in place of one sign-in for each dev instance (decision D12). The plan moves the root `engine` and `apps` pointers and updates the root `AGENTS.md` e2e text that describes these scripts.

Out of scope:

- The `server` and the `container` placement e2e. They keep the copy of the holder `server`.
- A dev instance with its own override copy. The scripts create none.
- The homelab container (`platforms/homelab`). It runs a server, not a `worker` instance.

## Model

Sonnet at high effort. The change stays in `scripts/e2e/` and in the root `AGENTS.md`.

## Sources

- Root `AGENTS.md` "Repository tooling": the `make e2e`, `make e2e-start`, `make e2e-scale` and `make e2e-restart` rules, and the dev instance and sign-in rules of the `worker` placement.
- Root `scripts/e2e/instances.mjs:21-35`, `:55-63`, `:129-160`, `:187-214`, `:327-345` — the dev instance names, the instance home, the instance create, the process start and `signInGaps`.
- Root `scripts/e2e/instances.test.mjs:57`, `:544`, `:597` — the sign-in command tests.
- Root `scripts/e2e/scale.mjs`, `scripts/e2e/restart-steps.mjs` — the scale and the restart of the `worker` placement.
- `docs/cli/worker.md` "Worker hosts" of engine plan 02 and `docs/cli/llm.md` of engine plan 03.

## Depends on

Engine plans 02 to 05 merged, and apps plans 06 and 07 merged. Start from `origin/main` of `kanthorlabs/kanthord`.

## Provides

- `make e2e PLACEMENT=worker` with one dev host `e2e-host` and one sign-in for the host copy.
- The root `engine` and `apps` pointers at the merged plans of this set.
- `docs/reference/workbench/tools.md` regenerated from the engine operations.

## Tasks

### 08.1 Write the tests of the dev host

- Files: `scripts/e2e/instances.test.mjs` (edit)
- Do:
  1. Add a test that the preparation of the `worker` placement creates the dev host `e2e-host` once, writes its host file into `.dev/e2e/hosts/e2e-host/`, and creates each dev instance with `--host e2e-host`.
  2. Add a test that the start of an instance process sets `KANTHORD_HOST_CONFIG`, or an `XDG_CONFIG_HOME` that holds the host file.
  3. Change the tests of `signInGaps` (`:544`, `:597`). The gaps hold one command for the holder `e2e-host`, and no command for a dev instance that uses the host copy.
  4. Add a test that a host copy sealed to an ended host key prints the sign-in command of the host.
- Verify: `node --test scripts/e2e/instances.test.mjs` fails on the new tests only.

### 08.2 Create the dev host and sign in once

- Files: `scripts/e2e/instances.mjs`, `scripts/e2e/scale.mjs`, `scripts/e2e/restart-steps.mjs` (edit)
- Do:
  1. Add `ensureHost(api, cli, home)`. It creates `e2e-host` with `kanthord worker host create e2e-host --output` under the host home `.dev/e2e/hosts/e2e-host/`. A missing server record creates it again. A live record of another key revision, or no local host file, rotates the host key with `--force`.
  2. In `ensureInstance` (`:129-160`), add `--host e2e-host` to the create at the `worker` placement.
  3. In `startInstanceProcess` (`:180-186`), give the process the host configuration value as `KANTHORD_HOST_CONFIG`.
  4. In `signInGaps` (`:327-345`), read `host` and `credentials` of each instance through `/api/worker/instance/<name>`. A credential with no item whose `sealed_current` is true needs a sign-in of its copy holder: the `holder` of the listed item, or the `host` of the instance when no item is listed. Print one command for each such holder, once: `(cd engine && node src/main.ts llm credential login <platform> --name <credential> --holder <holder>)`.
  5. Call `ensureHost` before the instances in the start, the scale and the restart of the `worker` placement.
- Cite: D3, D5, D7, D12.
- Verify: `node --test scripts/e2e/*.test.mjs` passes.

### 08.3 Update the root e2e text

- Files: `AGENTS.md` (edit)
- Do:
  1. Rewrite the rule "Each dev instance holds its own `anthropic-subscription` copy, signed in through OAuth." The dev host `e2e-host` holds the copy, and each dev instance at the `worker` placement uses it.
  2. Rewrite the sign-in rules. A run asks for one sign-in for `e2e-host`. A key rotation of the host prints that one command again.
  3. Add the dev host home `.dev/e2e/hosts/e2e-host/` beside the instance home `.dev/e2e/instances/<name>/`.
- Verify: `rg -n 'Each dev instance holds its own' AGENTS.md` prints nothing.

### 08.4 Move the pointers and regenerate the tools page

- Files: `engine`, `apps` (gitlinks), `docs/reference/workbench/tools.md` (generated)
- Do:
  1. Move `engine` and `apps` to their `origin/main` heads that hold the plans of this set. The pre-commit hook refuses a gitlink that is not on `origin/main` (root `AGENTS.md` "Repository tooling").
  2. Run `make docs-tools`. Commit the result.
- Verify: `make docs-tools` leaves no diff after the commit.

### 08.E Run the gate

- Do:
  1. Run `node --test scripts/e2e/*.test.mjs`.
  2. Reset the dev database. Run `make e2e PLACEMENT=worker`. Confirm that it stops once with one sign-in command for `e2e-host`. Sign in, run it again, and confirm that each dev instance claims work with the host copy.
  3. Run `make e2e-stop RUN=<name> STOP=daemon`.
- Verify: every command exits 0, and the run asks for exactly one sign-in.

## Blockers

None.
