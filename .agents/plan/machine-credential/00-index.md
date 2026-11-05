# Plan 00: Index

## Scope

This plan set lets the `worker` instances of one computer share one credential copy. Today each `worker` instance needs its own copy, sealed to its own X25519 key. N instances on one computer thus need N logins, for example N Claude subscription logins of `anthropic-subscription`. Root `docs/reference/llm/credential.html` "Instance copies" and root `docs/reference/llm/login.html` "Login on a worker instance" state the rules of today.

The planner checked the goal against the code at engine `2d347a00`, apps `4840163` and root `01865e3`. The set plans these changes:

- A worker machine: a holder with its own key pair for one computer. Each `worker` instance names its machine (decisions D2, D3).
- The copy holder of an instance: its own copy when it has one, else the copy of its machine (decision D4). The own copy is the per-instance override (decision D12).
- Login, create, rotate, list, get, health, cooldown, archive, `sealed_current` and Reset key for a machine holder (decisions D6 to D11).
- A refresh lease, so that one execution at a time refreshes one OAuth revision (decision D14).
- The CLI, the OpenAPI document, `docs/cli/`, the dashboard, the root design and reference pages, and the e2e scripts (decision D15).

The term "host" keeps its meaning of `worker-service.vocabulary.md:20-29`: `kanthord` or an external harness. The new holder is therefore the "worker machine".

The Mission Service contract does not change. An agent provider names a credential, and a worker binding lists instances. The handover picks the copy of the copy holder (decision D13). A server on another computer works with the same rules. An example is a dogfood server with `kanthord serve worker` instances on the homelab computer `192.168.1.64`.

## Out of scope

- The `server` and the `container` placements keep the copy of the holder `server`. No machine applies to them.
- An instance that moves to another machine. The machine of an instance never changes. A human creates a new instance.
- The SSH keys, the storage keys and every credential of another component. They keep the holder `server`.
- A server-side LLM proxy. A worker instance still calls its provider directly.
- The refresh-token rotation behaviour of a provider outside the lease. A lease that expires during a refresh can still race (decision D14).
- A data migration. kanthord is not deployed (decision D16).

## Plans

Each plan is one pull request and ends green. The start order is:

1. Plan 01 starts first.
2. Plans 02 and 05 start at once after Ulrich approves the root pull request of plan 01.
3. Plans 06 and 08a start after plan 02 merges.
4. Plan 03 starts after plans 02 and 05 merge.
5. Plan 04 starts after plan 03 merges.
6. Plan 07 starts after plans 03 and 06 merge.
7. Plan 08b starts after plans 04 and 07 merge.

| Plan | File                             | Repository                    | Model        | Component                                    | Boundary                                                                                                                                                                                                                                       |
| ---- | -------------------------------- | ----------------------------- | ------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `01-root-design.md`              | `kanthorlabs/kanthord`        | Opus, medium | Root design and reference pages              | The design pages of custody, LLM, the Worker Service, the Agent component and the dashboard; the reference pages of credentials, login, instances, machines and the handover; ERD 1.                                                           |
| 02   | `02-worker-machine.md`           | `kanthorlabs/kanthord-engine` | Sonnet, high | Worker Service — machines                    | `worker_machine`; `worker_instance.machine`; the five `worker.machine.*` operations; `machine` of the instance create and the heartbeat; the machine keys; the machine configuration and `worker machine join`; the CLI; `docs/cli/worker.md`. |
| 03   | `03-machine-copies.md`           | `kanthorlabs/kanthord-engine` | Opus, medium | Custody, LLM, Agent — machine copies         | `copyHolderOf`; the seal to a machine key; the worker-token reads; the login on a machine; `versionOf` and `reported_by`; the cooldown; the archive dependents; `holder` of the handover item; `docs/cli/llm.md` and `agent.md`.               |
| 04   | `04-worker-machine-key.md`       | `kanthorlabs/kanthord-engine` | Sonnet, high | Worker application — machine key             | The copy keys; the open of a sealed item, the copy check and the login seal with the key of the holder; the claim gate of an absent machine configuration; the CLI holder rule of `llm credential`.                                            |
| 05   | `05-refresh-lease.md`            | `kanthorlabs/kanthord-engine` | Opus, medium | Custody, Worker Service — refresh lease      | `worker.credential.lease`; the lease registry of custody; `itemOfRow`; the lease in `modify` of the execution store at every placement; the handover key until `discard()`; `docs/cli/worker.md`.                                              |
| 06   | `06-dashboard-machines.md`       | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — machines                         | `/machines`, `/machines/new`, `/machines/:machineName` without credentials; Reset key and Archive of a machine; the `Machine` select of `Add instance`; the machine link of the instance page; `mock/`.                                        |
| 07   | `07-dashboard-machine-copies.md` | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — machine and instance credentials | The credentials of the machine page; the copies of the instance page with their holder; the copies of the instance Reset key; `Also seal to` with machines; the sign-in on a machine; the `/llm` line; `mock/`.                                |
| 08a  | `08a-root-e2e-machine.md`        | `kanthorlabs/kanthord`        | Sonnet, high | Root — e2e scripts                           | One dev machine `e2e-machine` for the `worker` placement e2e; `--machine` and `KANTHORD_MACHINE_CONFIG`; one sign-in for each dev instance; the `engine` pointer; `make docs-tools`.                                                           |
| 08b  | `08b-root-e2e-sign-in.md`        | `kanthorlabs/kanthord`        | Sonnet, high | Root — e2e scripts                           | One sign-in for the dev machine; the root `AGENTS.md` e2e text; the `engine` and `apps` pointers; `make docs-tools`.                                                                                                                           |

**Rationale for order.**
Plan 01 holds the design, so every other plan waits for its approval (decision D1). Plans 02 and 05 touch separate files and start at once. The second of the two to merge rebases on the first and regenerates `static/`. Plan 03 needs the machine keys of plan 02 and `itemOfRow` of plan 05. Plan 04 needs the `holder` of the handover item of plan 03. Plans 06 and 07 need the contracts of plans 02 and 03 in engine `main`, because the apps API types follow the OpenAPI document. Plan 08a adapts the e2e scripts to the required machine of plan 02, so the root `engine` pointer moves at once. Plan 08b needs the whole engine and dashboard change.

## Repositories, branches and worktrees

Create each worktree from `origin/main` of its repository. The worktree directory `.dev/<name>` matches the branch `<type>/<name>`. Never commit to `main`. Push the branch and open a pull request to `main`. Merge only after review (root `CLAUDE.local.md` "Commits"). When a repository rule refuses a push, stop and report it.

| Plan | Repository root | Worktree                             | Branch                           | Command                                                                                                                                                                   |
| ---- | --------------- | ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | root            | `.dev/machine-credential-design`     | `docs/machine-credential-design` | `git fetch origin && git worktree add -b docs/machine-credential-design .dev/machine-credential-design origin/main`, then `make bootstrap`                                |
| 02   | `engine/`       | `engine/.dev/worker-machine`         | `feat/worker-machine`            | `git -C engine fetch origin && git -C engine worktree add -b feat/worker-machine .dev/worker-machine origin/main`, then `pnpm install && pnpm run pi-tools:fetch`         |
| 03   | `engine/`       | `engine/.dev/machine-copies`         | `feat/machine-copies`            | `git -C engine fetch origin && git -C engine worktree add -b feat/machine-copies .dev/machine-copies origin/main`, then `pnpm install && pnpm run pi-tools:fetch`         |
| 04   | `engine/`       | `engine/.dev/worker-machine-key`     | `feat/worker-machine-key`        | `git -C engine fetch origin && git -C engine worktree add -b feat/worker-machine-key .dev/worker-machine-key origin/main`, then `pnpm install && pnpm run pi-tools:fetch` |
| 05   | `engine/`       | `engine/.dev/refresh-lease`          | `feat/refresh-lease`             | `git -C engine fetch origin && git -C engine worktree add -b feat/refresh-lease .dev/refresh-lease origin/main`, then `pnpm install && pnpm run pi-tools:fetch`           |
| 06   | `apps/`         | `apps/.dev/dashboard-machines`       | `feat/dashboard-machines`        | `git -C apps fetch origin && git -C apps worktree add -b feat/dashboard-machines .dev/dashboard-machines origin/main`, then `pnpm install`                                |
| 07   | `apps/`         | `apps/.dev/dashboard-machine-copies` | `feat/dashboard-machine-copies`  | `git -C apps fetch origin && git -C apps worktree add -b feat/dashboard-machine-copies .dev/dashboard-machine-copies origin/main`, then `pnpm install`                    |
| 08a  | root            | `.dev/e2e-machine`                   | `chore/e2e-machine`              | `git fetch origin && git worktree add -b chore/e2e-machine .dev/e2e-machine origin/main`, then `make bootstrap`                                                           |
| 08b  | root            | `.dev/e2e-machine-sign-in`           | `chore/e2e-machine-sign-in`      | `git fetch origin && git worktree add -b chore/e2e-machine-sign-in .dev/e2e-machine-sign-in origin/main`, then `make bootstrap`                                           |

## Verify gate per plan

Each plan ends with its task `NN.E`. The gate holds every row of its plan. A failed row blocks the pull request.

In the table, `\|` is the Markdown escape of `|`. Type `|` in the command.

| Plan | Gate                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `scripts/docs/check.sh` exits 0 in the root worktree; `rg -n 'llm\.credential\.instance_unknown' docs/brainstorm docs/reference` prints nothing; the term check of task 01.E.                                                                                                                                                                                 |
| 02   | `pnpm run verify`; `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing after the commit of task 02.7; `pnpm exec prettier --check docs/cli/worker.md`; the tests of task 02.1 failed before task 02.3 and pass after it.                                                                               |
| 03   | `pnpm run verify`; the OpenAPI check of plan 02 after the commit of task 03.8; `pnpm exec prettier --check docs/cli/llm.md docs/cli/agent.md docs/cli/worker.md`; `rg -n 'llm\.credential\.instance_unknown\|LlmErrorCode\.InstanceUnknown' src static docs/cli` prints nothing; the tests of task 03.1 failed before tasks 03.2 to 03.6 and pass after them. |
| 04   | `pnpm run verify`; `pnpm exec prettier --check docs/cli/llm.md docs/cli/worker.md`; the tests of task 04.1 failed before tasks 04.2 to 04.4 and pass after them.                                                                                                                                                                                              |
| 05   | `pnpm run verify`; the OpenAPI check of plan 02 after the commit of task 05.5; `pnpm exec prettier --check docs/cli/worker.md`; the tests of task 05.1 failed before task 05.3 and pass after it.                                                                                                                                                             |
| 06   | `pnpm verify` in `apps/`; the tests of task 06.1 failed before task 06.3 and pass after it; the browser check of task 06.E at 1280 by 800 and at 390 by 844.                                                                                                                                                                                                  |
| 07   | `pnpm verify` in `apps/`; `rg -n 'Instance credentials live on the worker pages' src` prints nothing; the tests of task 07.1 failed before task 07.3 and pass after it; the browser check of task 07.E at 1280 by 800 and at 390 by 844.                                                                                                                      |
| 08a  | `node --test scripts/e2e/*.test.mjs`; `make docs-tools` leaves no diff after its commit; one `make e2e PLACEMENT=worker` run that creates `e2e-machine` once and starts each dev instance.                                                                                                                                                                    |
| 08b  | `node --test scripts/e2e/*.test.mjs`; `make docs-tools` leaves no diff after its commit; one `make e2e PLACEMENT=worker` run that asks for one sign-in only, for `e2e-machine`.                                                                                                                                                                               |

## Citations

- A design citation names `docs/brainstorm/<page>:<line>` or `docs/reference/<page>` of the root repository at `01865e3`. Plans 02 to 08b cite the pages of the root pull request of plan 01 by section (decision D1).
- An engine citation names a path under the engine root at `2d347a00`.
- An apps citation names a path under the apps root at `4840163`.
- When `main` moved before the plan starts, re-anchor each citation to the sentence or code block that the text means (`engine/AGENTS.md:53-55`).

## Rulings

- O1 — Must every `worker` instance name a machine? RULED 2026-11-05 by Ulrich: yes. The machine is required at the `worker` placement (decision D3).
- O2 — Does the refresh lease apply to every OAuth copy? RULED 2026-11-05 by Ulrich: yes, at every placement (decision D14).
- O3 — Can an instance take a new own copy after the archive of its override? RULED 2026-11-05 by Ulrich: no. The archive stays final (decision D12).

The decisions that this set takes are in [decisions.md](decisions.md).
