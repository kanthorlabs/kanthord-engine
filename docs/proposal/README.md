# KanthorD MVP Technical Proposal

Source: `../brainstorm.md`. This proposal states how KanthorD works, then splits the work into three phases. The MVP is all three phases. Each phase removes one named blocker and delivers an outcome a human observes.

Every statement in these files is a decision. Nothing here is a suggestion or an option under consideration. Where something stays undecided, it appears in [open-items.md](open-items.md) and nowhere else.

## Scope

KanthorD is a daemon. A human authors a graph of work. The daemon executes the graph with coding agents, isolates each unit of work in its own git clone, and asks the human to confirm every integration to the source of truth.

## Non-goals for the MVP

- Multi-tenancy. The daemon serves one user. It reaches that user across a private network, with one bearer token and no user model.
- `pr@1`. The MVP integrates locally with `mr@1`, then publishes to remote origin. Hosted pull requests come later.
- Token accounting and spend dashboards. Attempt limits, timeouts and cancellation exist. Cost reporting does not.
- Automatic revert. Only a human authors an undo node.
- Agent-driven unblocking. Only a human clears a blocked node.
- Atomic work across two repositories in one node.

## Phases

| Phase                                                      | Goal                                                                                              | Blocker removed                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [phase-1](phase-1/README.md) — Bootstrap                   | Every entity, service interface, command and query exists and is drivable. No agent is connected. | There is no skeleton to hang work on, and no bare home to work against.                                 |
| [phase-2](phase-2/README.md) — Real work on the happy path | `pi-coding-agent` produces real reviewed commits that reach remote origin.                        | No real agent is connected, so the capacity of KanthorD is unproven.                                    |
| [phase-3](phase-3/README.md) — Resilience                  | The daemon survives every path that is not the happy path.                                        | A crash, a race or a discarded dependency costs a corrupted repository or a graph a human cannot clear. |

Daily use starts at the end of phase 2, on a good day. It becomes trustworthy at the end of phase 3.

Work deferred past the MVP is listed in [after-the-mvp.md](after-the-mvp.md).

## Two kinds of proof

`npm run verify` is typecheck, `node --test`, eslint and `db status`. It holds the exhaustive permutations, and most of them run below the process boundary. It is the regression suite.

An end-to-end scenario is a complete journey across the deployed product. It exists to catch what a unit suite cannot see: executable packaging, configuration discovery, daemon lifecycle, CLI and HTTP schema skew, process boundaries, credential loading, and real git behaviour. Scenarios are few and cross-boundary. A scenario that restates a `node:test` assertion through the CLI is deleted, because it is a second specification that drifts.

## How a scenario works

Every scenario is executable by a coding agent and by a human, with no separate procedure for either. There is no actor field. A scenario that only a human can judge is not a scenario; it is product acceptance, and it is recorded separately.

Each scenario declares:

| Field           | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `Mode`          | `deterministic`, `live` or `deployment`                               |
| `Why it exists` | the one sentence naming what breaks if this fails                     |
| `Automation`    | the exact command                                                     |
| `Human action`  | `none`, or the confirmation the procedure asks for                    |
| `Oracle`        | machine-checkable conditions, each one a query and an expected result |
| `Evidence`      | the artifact the run produces                                         |

A shared Node runner implements setup, invocation, assertion, cleanup and evidence:

```
scripts/e2e/run.mjs P1-E1
scripts/e2e/run.mjs P2-E4 --live
scripts/e2e/run.mjs P3-E1 --failpoint after-ref-update
```

Fixture data lives under `test/e2e/fixtures/`. The runner prints every underlying command, so a human reproduces any step by hand. One runner rather than one script per scenario, because two representations of the same procedure disagree eventually.

### The runner has two axes

A scenario that spans two hosts needs a place to run each step, and a set of inputs to run it against. These are separate choices, and the runner keeps them separate.

| Axis                 | Meaning                                                                                                                                                          | Values                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Execution driver** | command execution per host, binary and configuration delivery, token delivery, daemon start and stop, log collection, and the merge of two hosts into one bundle | `local`, `podman`, `ssh` |
| **Scenario profile** | the origin, the credential, the expected default branch, and the evidence the bundle must carry                                                                  | fixture, real            |

The journey code and the public-surface assertions are shared across both axes. A driver swap alone never changes what a scenario claims: a fixture-profile run asserts fixture object ids and a fixture default branch, and a real-profile run asserts neither.

A scenario declares one driver and one profile. Two scenarios that differ on either axis carry two ids and two evidence bundles, because one id with two meanings makes evidence ambiguous.

### The three modes

- **`deterministic`** — scripted agent and scripted reviewer, a bare repository that the harness serves over git smart HTTP on a loopback port playing remote origin, a temporary daemon home. No outbound network, no provider account, no model. The git credential is a fixture token the loopback server accepts, because `isomorphic-git` has no transport that reads a local path as a remote. These are phase gates, and they must pass unattended.

The fixture remote is part of the harness, so it needs its own acceptance list, and each item belongs to the phase whose scenarios use it. A fixture that fails an item makes the scenario prove less than it claims, so each phase proves its own subset before its scenarios run.

| Capability                                                                      | Needed by | Because                                                                        |
| ------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `HEAD` symref discovery and `fetch`, over HTTP                                  | phase 1   | `repository register` and every clone base                                     |
| A `git-receive-pack` advertisement that refuses a wrong token and a missing one | phase 1   | the registration preflight, which is a write advertisement rather than a fetch |
| Accept a non-force push, and reject a non-fast-forward                          | phase 2   | publish and its rejection classification                                       |

The second row is a write route in phase 1, although no phase 1 scenario pushes. The preflight has to be a write advertisement, because a read proves nothing about a credential on a public repository.

Two things are not HTTP requirements at all, which is why they are not in the table. The harness moves the fixture remote by writing to that bare repository directly with `isomorphic-git`, so "upstream advances" in `P2-E3` needs no push route. The harness also owns the server process, so holding still between steps is a property of driving it, not a feature of it.

Phase 1 therefore needs the read side and the authentication challenge. Phase 2 adds the write side. Nothing here is a product deliverable: the daemon sees an ordinary HTTP remote in every case.

The fixture is `node:http` in front of `git http-backend`, which is about ninety lines and satisfies every row above. The `git` binary is therefore a test-time prerequisite. The suite is then hermetic only if that binary is provisioned and its version pinned by the same environment that runs the suite, and the evidence bundle records the version. The product itself still ships no dependency on a `git` binary.

Podman is a test-time prerequisite on the same rule, for a scenario that takes the `podman` driver. The environment provisions it and pins its version, the runner records the version, the architecture and the rootless or rootful mode, and an absent or unreachable Podman fails the run loudly. The runner never starts a Podman machine: a phase gate does not reconfigure a global virtual machine. The product ships no dependency on Podman.

A `podman` run is hermetic only under five rules. The network is internal with no outbound route. Images are provisioned before the run and consumed with `--pull=never`, so a deterministic gate never reaches a registry. Every resource carries a run id label, and cleanup works by label on the failure path as well as the success path, so two runs never collide and a killed run is reclaimed by the next one. Readiness is polled against the health route to a bounded deadline, never slept. A token reaches a container as a mounted file, never an environment variable and never an argument, because container inspection and a printed command each disclose the other two.

- **`live`** — a real provider on a disposable repository. Opt-in through `KANTHORD_E2E_LIVE=1`, with a fixed maximum of attempts and calls, a per-call token cap, a wall-clock timeout, and no automatic rerun. A live failure is evidence about that run, not automatically a regression.
- **`deployment`** — a real daemon host and a real client host across the VPN, with real credentials. It proves the environment, not the logic. A coding agent runs it when it has access to both hosts; that is a prerequisite, not a reason to call the scenario human-only.

A container pair proves the two-host logic, so it is `deterministic` and it is a phase gate. It never proves the environment, so it never substitutes for a `deployment` run. `Human action: none` on a `deployment` scenario means none once the prerequisites exist: the runner never enrolls a host in the VPN, never mints or rotates a real credential, and never edits host security configuration. A missing prerequisite makes the run fail as unavailable. It never skips and writes a passing bundle.

### Scenarios use public surfaces only

A scenario drives the CLI, or HTTP directly where the protocol itself is under test — a forged `Origin`, a missing token, a compare-and-swap carrying an exact object id. It never opens SQLite, never imports a service, and never calls an internal function.

Test-only failpoints are the exception, and they are legitimate. A named durable boundary is not a product capability, and no human can reliably kill a process between a ref update and a journal write. A failpoint pauses execution and announces arrival. The harness then kills the real process from outside, so startup reconciliation runs for real.

### Evidence

A run writes an evidence bundle, not a `PASS` marker in the repository. The bundle records the scenario id and schema version, the commit under test, the timestamp and host identity, the daemon and CLI versions, the fixture hashes, the provider and model and limits for a live run, the object ids involved, every assertion result, sanitized logs, and the human confirmation where the procedure asked for one.

A phase exits by pointing at a specific evidence bundle, tied to a proposal revision and an implementation commit.

## Files

Read a phase directory in the order its README lists.

| File                                                                         | Subject                                                       | Suggested reviewer                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| [phase-1/domain.md](phase-1/domain.md)                                       | entities, service layering, storage tables, dependencies      | architect or tech lead                  |
| [database/README.md](database/README.md)                                     | every table at column level, one file per table               | architect and whoever owns the database |
| [phase-1/transport.md](phase-1/transport.md)                                 | bind address, bearer token, browser defences, CLI parity      | architect and whoever owns the network  |
| [api/README.md](api/README.md)                                               | every route, one file per domain, and the API conventions     | architect and every domain owner        |
| [phase-1/plan-format.md](phase-1/plan-format.md)                             | the markdown a human authors, import, export, re-import       | developer experience                    |
| [phase-1/git-foundation.md](phase-1/git-foundation.md)                       | three repositories, ref roles, seeding, branch fields, clones | git or release engineer                 |
| [phase-1/state-machine.md](phase-1/state-machine.md)                         | states, aggregation table, task order, rules                  | runtime or backend engineer             |
| [phase-2/providers-and-credentials.md](phase-2/providers-and-credentials.md) | registrations, encryption at rest, selection                  | platform and security                   |
| [phase-2/instructions-and-profiles.md](phase-2/instructions-and-profiles.md) | prompt compilation, repository profiles, templates            | AI engineer                             |
| [phase-2/agents-and-workers.md](phase-2/agents-and-workers.md)               | the `general@1` worker, capability, attempts, inspection      | AI engineer                             |
| [phase-2/gates-and-approval.md](phase-2/gates-and-approval.md)               | verification command, `re@1` gate, approval evidence          | QA lead and whoever approves merges     |
| [phase-2/integration-and-publish.md](phase-2/integration-and-publish.md)     | freshness, `mr@1`, publish, reconcile, the journal            | git or release engineer                 |
| [phase-3/recovery.md](phase-3/recovery.md)                                   | crash recovery, lease expiry, journal reconciliation          | runtime or backend engineer             |
| [phase-3/outcomes.md](phase-3/outcomes.md)                                   | `partial`, discard, abandon, waive                            | runtime or backend engineer             |
| [after-the-mvp.md](after-the-mvp.md)                                         | what is deferred, and why                                     | delivery lead                           |
| [open-items.md](open-items.md)                                               | what stays undecided                                          | everyone                                |
