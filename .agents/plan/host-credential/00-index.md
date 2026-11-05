# Plan 00: Index

## Scope

This plan set lets the `worker` instances of one machine share one credential copy. Today each `worker` instance needs its own copy, sealed to its own X25519 key. N instances on one machine thus need N logins, for example N Claude subscription logins of `anthropic-subscription` (root `docs/reference/llm/credential.html` "Instance copies", root `docs/reference/llm/login.html` "Login on a worker instance").

The planner checked the goal against the code at engine `2d347a00`, apps `4840163` and root `01865e3`. The set plans these changes:

- A worker host: a holder with its own key pair for one machine. Each `worker` instance names its host (decisions D2, D3).
- The copy holder of an instance: its own copy when it has one, else the copy of its host (decision D4). The own copy is the per-instance override (decision D12).
- Login, create, rotate, list, get, health, cooldown, archive, `sealed_current` and Reset key for a host holder (decisions D6 to D11).
- A refresh lease, so that one execution at a time refreshes one OAuth revision (decision D14).
- The CLI, the OpenAPI document, `docs/cli/`, the dashboard, the root design and reference pages, and the e2e scripts (decision D15).

The Mission Service contract does not change. An agent provider names a credential, a worker binding lists instances, and the handover picks the copy of the copy holder (decision D13). A server on another machine works with the same rules, for example a dogfood server with `kanthord serve worker` instances on the homelab machine `192.168.1.64`.

## Out of scope

- The `server` and the `container` placements keep the copy of the holder `server`. No host applies to them.
- An instance that moves to another host. The host of an instance never changes. A human creates a new instance.
- The SSH keys, the storage keys and every credential of another component. They keep the holder `server`.
- A server-side LLM proxy. A worker instance still calls its provider directly.
- The refresh-token rotation behaviour of a provider outside the lease. A lease that expires during a refresh can still race (decision D14).
- A data migration. kanthord is not deployed (decision D16).

## Plans

Each plan is one pull request and ends green. Plan 01 starts first. Plans 02 and 05 start after Ulrich approves the root pull request of plan 01. Plan 03 starts after plan 02 merges. Plan 04 starts after plans 03 and 05 merge. Plan 06 starts after plan 02 merges. Plan 07 starts after plans 03 and 06 merge. Plan 08 starts after plans 04 and 07 merge.

| Plan | File                          | Repository                    | Model        | Component                                 | Boundary                                                                                                                                                                                                                                |
| ---- | ----------------------------- | ----------------------------- | ------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `01-root-design.md`           | `kanthorlabs/kanthord`        | Opus, medium | Root design and reference pages           | The design pages of custody, LLM, the Worker Service, the Agent component and the dashboard; the reference pages of credentials, login, instances, hosts and the handover; ERD 1.                                                       |
| 02   | `02-worker-host.md`           | `kanthorlabs/kanthord-engine` | Sonnet, high | Worker Service — hosts                    | `worker_host`; `worker_instance.host`; the five `worker.host.*` operations; `host` of `worker.instance.create`; `keyOf` and `hostOf` of the host keys; the host configuration and `worker host join`; the CLI and `docs/cli/worker.md`. |
| 03   | `03-host-copies.md`           | `kanthorlabs/kanthord-engine` | Opus, medium | Custody, LLM, Agent — host copies         | `copyHolderOf`; the seal to a host key; the worker-token scope; the login on a host; the copy health and `reported_by`; the cooldown; the archive dependents; the handover item `holder`; `docs/cli/llm.md` and `agent.md`.             |
| 04   | `04-worker-host-key.md`       | `kanthorlabs/kanthord-engine` | Sonnet, high | Worker application — host key             | The copy keys of the worker application; the open of a sealed item, the copy check and the login seal with the key of the holder; the CLI holder rules of `llm credential`.                                                             |
| 05   | `05-refresh-lease.md`         | `kanthorlabs/kanthord-engine` | Opus, medium | Custody, Worker Service — refresh lease   | `worker.credential.lease`; the lease registry of custody; the lease in `modify` of the execution store at every placement; `docs/cli/worker.md`.                                                                                        |
| 06   | `06-dashboard-hosts.md`       | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — hosts                         | `/hosts`, `/hosts/new`, `/hosts/:hostName` without credentials; Reset key and Archive of a host; the `Host` select of `Add instance`; the host link of the instance page; `mock/`.                                                      |
| 07   | `07-dashboard-host-copies.md` | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — host and instance credentials | The credentials of the host page; the copies of the instance page with their holder; `Also seal to` with hosts; the sign-in on a host; the `/llm` line; `mock/`.                                                                        |
| 08   | `08-root-e2e-host.md`         | `kanthorlabs/kanthord`        | Sonnet, high | Root — e2e scripts                        | One dev host for the `worker` placement e2e; one sign-in for that host; the root `AGENTS.md` e2e text; the `engine` and `apps` pointers; `make docs-tools`.                                                                             |

**Rationale for order.**
Plan 01 holds the design, so every other plan waits for its approval (decision D1). Plans 02 and 05 touch separate files and start at once. Plan 03 needs the host keys of plan 02. Plan 04 needs the `holder` of the handover item of plan 03 and the lease calls of plan 05, because both edit `src/apps/worker/handover.ts`. Plans 06 and 07 need the contracts of plans 02 and 03 in engine `main`, because the apps API types follow the OpenAPI document. Plan 08 needs the whole engine and dashboard change.

## Repositories, branches and worktrees

Create each worktree from `origin/main` of its repository. The worktree directory `.dev/<name>` matches the branch `<type>/<name>`. Never commit to `main`. Push the branch and open a pull request to `main`. Merge only after review (root `CLAUDE.local.md` "Commits"). When a repository rule refuses a push, stop and report it.

| Plan | Repository root | Worktree                          | Branch                        | Command                                                                                                                                                             |
| ---- | --------------- | --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | root            | `.dev/host-credential-design`     | `docs/host-credential-design` | `git fetch origin && git worktree add -b docs/host-credential-design .dev/host-credential-design origin/main`, then `make bootstrap`                                |
| 02   | `engine/`       | `engine/.dev/worker-host`         | `feat/worker-host`            | `git -C engine fetch origin && git -C engine worktree add -b feat/worker-host .dev/worker-host origin/main`, then `pnpm install && pnpm run pi-tools:fetch`         |
| 03   | `engine/`       | `engine/.dev/host-copies`         | `feat/host-copies`            | `git -C engine fetch origin && git -C engine worktree add -b feat/host-copies .dev/host-copies origin/main`, then `pnpm install && pnpm run pi-tools:fetch`         |
| 04   | `engine/`       | `engine/.dev/worker-host-key`     | `feat/worker-host-key`        | `git -C engine fetch origin && git -C engine worktree add -b feat/worker-host-key .dev/worker-host-key origin/main`, then `pnpm install && pnpm run pi-tools:fetch` |
| 05   | `engine/`       | `engine/.dev/refresh-lease`       | `feat/refresh-lease`          | `git -C engine fetch origin && git -C engine worktree add -b feat/refresh-lease .dev/refresh-lease origin/main`, then `pnpm install && pnpm run pi-tools:fetch`     |
| 06   | `apps/`         | `apps/.dev/dashboard-hosts`       | `feat/dashboard-hosts`        | `git -C apps fetch origin && git -C apps worktree add -b feat/dashboard-hosts .dev/dashboard-hosts origin/main`, then `pnpm install`                                |
| 07   | `apps/`         | `apps/.dev/dashboard-host-copies` | `feat/dashboard-host-copies`  | `git -C apps fetch origin && git -C apps worktree add -b feat/dashboard-host-copies .dev/dashboard-host-copies origin/main`, then `pnpm install`                    |
| 08   | root            | `.dev/e2e-host`                   | `chore/e2e-host`              | `git fetch origin && git worktree add -b chore/e2e-host .dev/e2e-host origin/main`, then `make bootstrap`                                                           |

## Verify gate per plan

Each plan ends with its task `NN.E`. The gate holds every row of its plan. A failed row blocks the pull request.

| Plan | Gate                                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01   | `scripts/docs/check.sh` exits 0 in the root worktree; `rg -n 'instance_unknown' docs/brainstorm docs/reference` prints nothing; the term check of task 01.E.                                                                                                                                                                   |
| 02   | `pnpm run verify`; `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing after the commit of task 02.7; `pnpm exec prettier --check docs/cli/worker.md`; the tests of task 02.1 failed before task 02.3 and pass after it.                                                |
| 03   | `pnpm run verify`; the OpenAPI check of plan 02 after the commit of task 03.8; `pnpm exec prettier --check docs/cli/llm.md docs/cli/agent.md docs/cli/worker.md`; `rg -n 'instance_unknown\|InstanceUnknown' src static docs/cli` prints nothing; the tests of task 03.1 failed before tasks 03.2 to 03.6 and pass after them. |
| 04   | `pnpm run verify`; `pnpm exec prettier --check docs/cli/llm.md docs/cli/worker.md`; the tests of task 04.1 failed before task 04.3 and pass after it.                                                                                                                                                                          |
| 05   | `pnpm run verify`; the OpenAPI check of plan 02 after the commit of task 05.5; `pnpm exec prettier --check docs/cli/worker.md`; the tests of task 05.1 failed before task 05.3 and pass after it.                                                                                                                              |
| 06   | `pnpm verify` in `apps/`; the tests of task 06.1 failed before task 06.3 and pass after it; the browser check of task 06.E at 1280 by 800 and at 390 by 844.                                                                                                                                                                   |
| 07   | `pnpm verify` in `apps/`; `rg -n 'Instance credentials live on the worker pages' src` prints nothing; the tests of task 07.1 failed before task 07.3 and pass after it; the browser check of task 07.E at 1280 by 800 and at 390 by 844.                                                                                       |
| 08   | `node --test scripts/e2e/*.test.mjs`; `make docs-tools` leaves no diff after its commit; one `make e2e PLACEMENT=worker` run that asks for one sign-in only, for the dev host.                                                                                                                                                 |

## Citations

- A design citation names `docs/brainstorm/<page>:<line>` or `docs/reference/<page>` of the root repository at `01865e3`. Plans 02 to 08 cite the pages of the root pull request of plan 01 by section (decision D1).
- An engine citation names a path under the engine root at `2d347a00`.
- An apps citation names a path under the apps root at `4840163`.
- When `main` moved before the plan starts, re-anchor each citation to the sentence or code block that the text means (`engine/AGENTS.md:53-55`).

## Open rulings

Aelita brings each ruling to Ulrich as one item. The plans use the recommendation until Ulrich rules.

- O1 — Must every `worker` instance name a host?
  - Recommendation: yes, the host is required at the `worker` placement (decision D3). One rule then holds for every `worker` instance, and the shared copy is the default by construction.
  - Alternative A: the host is optional. An instance with no host keeps the own-copy rule of today. It changes fewer copy blocks and e2e steps, but three instances of one machine share nothing unless the human names a host for each.
- O2 — Does the refresh lease apply to every OAuth copy?
  - Recommendation: yes, at every placement (decision D14). The server copy that several `server` and `container` instances use has the same race today (`custody.impl.md:219-220`). One rule fixes both.
  - Alternative A: the lease applies only to a host copy. The change is smaller, and the race of the server copy stays a provider constraint.
- O3 — Can an instance take a new own copy after the archive of its override?
  - Recommendation: no, the archive stays final (decision D12). The `(name, instance)` group stays taken, and the instance uses the host copy of that name for good.
  - Alternative A: an archive of an instance copy whose instance has a host frees the group. A later own copy continues at the next revision. It keeps the override reversible, but it breaks the rule "An archive is final" (`custody.md:50`) for one case.

The decisions that this set takes are in [decisions.md](decisions.md).
