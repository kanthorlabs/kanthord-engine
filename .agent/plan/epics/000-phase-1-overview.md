# Phase 1 — epic overview

Status: **draft**. The Stories lists are agreed. The Verification Gates are sketches, and each epic is finalised just before `/author` runs on it.

Source: `docs/proposal/phase-1/`, `docs/proposal/api/`, `docs/proposal/database/`.

Phase 1 goal: every entity, service interface, command and query exists, and a human drives the daemon end to end. No agent is connected.

Exit criterion: Ulrich onboards his real repository from a second machine over the VPN, imports a two-objective plan, exports it identical, and reads status. Every execution route answers `not-implemented`.

## Order

Foundation layers first, then vertical use cases, then the contract sweep, then the scenarios. An epic must be verifiable when it closes, so a use case that cannot be driven through a route does not close.

| #     | Epic                        | Stories | Capability at close                                                                  |
| ----- | --------------------------- | ------- | ------------------------------------------------------------------------------------ |
| 001   | Runtime foundation          | 9       | The daemon starts, owns its home exclusively, and the test harness exists.           |
| 002   | Domain and state machine    | 11      | The machine is defined and unit tested. Every service interface exists.              |
| 003   | Storage                     | 8       | Every phase-1 table exists. Migrations are idempotent. Secrets and blobs persist.    |
| 004   | Transport skeleton          | 8       | A request reaches a handler under the full transport policy, and the CLI carries it. |
| 004.5 | Contract schemas            | 7       | Every phase-1 read shape is a zod schema plus an example. No handler is written.     |
| 005   | Test infrastructure         | 5       | Two fixture remotes answer real git HTTP and ssh, and each passes its own list.      |
| 006   | Git primitives              | 8       | A ref write is a compare-and-swap. The three ref roles never blur.                   |
| 007   | Repository registration     | 10      | A human registers a real remote and reads it back, end to end.                       |
| 007.5 | Startup recovery            | 7       | Startup proves no predecessor child survives before it removes anything.             |
| 008   | Project and plan            | 15      | A human imports, exports and re-imports a plan with per-node conflict choices.       |
| 009   | CLI surface and composition | 9       | The program is assembled, stops cleanly, and an unwired command fails a test.        |
| 010   | Contract completion         | 4       | Blobs, events, and every later-phase route answering `501`.                          |
| 010.5 | Browser access              | 6       | A named origin reaches the daemon. An empty list keeps the 004 behaviour.            |
| 010.6 | Idempotent POST             | 8       | A keyed `POST` retried is suppressed, per an operation policy in the registry.       |
| 011   | End-to-end scenarios        | 11      | P1-E1, P1-E2, P1-E4 and P1-E3 produce evidence bundles.                              |
| 012   | Phase 1 acceptance run      | 6       | The scenarios ran once, in order, and one verdict points at the P1-E3 bundle.        |

Total: 132 stories.

`007.5` carries a decimal because it was inserted after `008` to `012` were numbered, and renumbering five epics would break every cross-reference for no gain. `004.5`, `010.5` and `010.6` carry one for the same reason.

## Dependencies

```
001 ─> 002 ─> 003 ─> 004 ─┬─> 005 ─> 006 ─> 007 ─> 007.5 ─┬─> 009 ─> 010 ─> 010.5 ─> 010.6 ─> 011 ─> 012
                          │                                 │
                          ├─────────────────────────────────┴─> 008 ─┘
                          │
                          └─> 004.5 (parallel, unblocks the Flutter client)
```

004.5 needs 002 for the domain enums and 004 for the registry, and it needs nothing else: `src/http/contract/` imports no storage and no command, so a schema is authorable before its handler exists. It therefore runs **in parallel** with 005 to 008 rather than in the chain, and it is the one epic whose consumer is a second repository. `kanthord-apps/docs/api/parallel-development.md` states what that repository does with it.

010.5 needs 010, because a browser client reads real routes and a preflight over a registry that still answers `501` everywhere proves nothing. 010.6 needs 010 for the same reason — a policy per operation is registry data — and 010.6 follows 010.5 because `Idempotency-Key` reaches a browser only through the preflight allow list 010.5 owns. 011 needs both, because a scenario drives the browser path and the retry path.

007.5 needs 007, because a reap needs a journal row that only a real git operation writes, and 009 needs 007.5, because the composition root wires recovery in before readiness.

008 needs 004 for its routes and 007 for the repository an objective binds. 009 assembles what 007 and 008 built, and every later epic depends on it. 010 sweeps the routes neither use case reached, less `system.status`, which 009 must build to answer `kanthord status`. 011 proves the whole thing through the packaged binary. 012 runs it and decides.

## Why 012 exists

011 makes each scenario runnable. It never makes the run happen. A phase can hold four green scenarios and no decision, so 012 owns the four things no other epic owns: the run frame, the execution of P1-E3 on the real profile, the product acceptance that `docs/proposal/README.md` keeps out of every scenario, and the verdict that opens a fix epic for each blocker.

012 owns no oracle and invents no scenario. A run story names a scenario id and the 011 command, and asserts nothing of its own. A gap it finds becomes a proposal amendment, then an 011 story.

## Why 009 exists

A phase can close with every unit test green and no working program. A command can be written, exported, unit tested and never referenced by `src/main.ts`, and nothing in 001 to 008 notices. 009 owns the seams that no vertical use case owns: the declared CLI inventory and its parity assertion, the two CLI commands that belong to no use case (`status` and `run`) together with the `system.status` route they need, the daemon's shutdown path, the composition root asserted complete against every `routed` operation this phase implements, and the daemon-backed `npm run verify`.

`npm run verify` is staged for the same reason. It is every epic's gate, and `docs/proposal/api/system.md` makes `db status` an HTTP client command, so 001 defines `verify` without it and 009 restores it against a daemon the script starts itself.

## Decisions taken outside the proposal, then merged into it

Each of these came out of a debate round and now lives in the proposal files named.

| Decision                                                                                | Landed in                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `provider.register`, `provider.list` and `provider.show` move to phase 1                | `api/credential.md`, `api/new-decisions.md`      |
| Validation collects every finding                                                       | `phase-1/plan-format.md`, `api/graph.md`         |
| `repository register --upstream <branch>` gives the confirmation non-interactively      | `api/repository.md`                              |
| `plan.export` writes no status                                                          | `phase-1/plan-format.md`, `api/graph.md`         |
| Byte identity is against the accepted document, with a canonical rendering              | `phase-1/plan-format.md`                         |
| The import body is path-and-content pairs, with a decided path grammar                  | `api/graph.md`, `api/new-decisions.md`           |
| Re-import is a binary per-node choice, validated as a whole candidate graph             | `phase-1/plan-format.md`, `api/graph.md`         |
| `fromRevision` stays a hard reject; the merge-base model is deferred                    | `api/new-decisions.md`, `after-the-mvp.md`       |
| `choices_blob`, and `accepted_blob` holds the whole resulting graph                     | `database/plan_revision.md`                      |
| "Every entity" is one row schema per table, plus the two kind sets and the interfaces   | `phase-1/README.md`                              |
| Worker, Agent and Template persist nothing; only `profile` holds a row                  | `phase-1/domain.md`                              |
| The project CLI ships in phase 1, and P1-E1 creates and binds a project                 | `phase-1/README.md`                              |
| P1-E4 is the two-namespace Podman run, `deterministic`, a laptop gate                   | `phase-1/README.md`, `README.md`                 |
| The runner has two axes, an execution driver and a scenario profile                     | `README.md`                                      |
| Podman is a provisioned test prerequisite, with five hermeticity rules                  | `README.md`                                      |
| A container pair never substitutes for a `deployment` run                               | `README.md`                                      |
| `npm run verify` is staged, and it starts a daemon for the `db status` step             | `phase-1/domain.md`, `api/system.md`             |
| Both provider kinds, `git` and `llm`, ship in phase 1                                   | `phase-1/README.md`                              |
| The network-filesystem refusal is effective where the platform reports a type           | `phase-1/git-foundation.md`, `phase-1/README.md` |
| A browser client is supported through an allowed-origin list that is empty by default   | `phase-1/transport.md`, `api/README.md`          |
| A keyed `POST` is idempotent, by a policy per operation, memory-backed except import    | `api/README.md`                                  |
| `event.list` gains `wait`, and long polling is the decided progress channel             | `api/event.md`, `after-the-mvp.md`               |
| Schemas are authored ahead of their handlers, because a second repository consumes them | EPIC 004.5, `api/README.md`                      |

The last three rows came out of the client handover, and each has landed in the proposal file named. `kanthord-apps/docs/api/` is the client-side copy of the same decisions, so a change to any of them updates two repositories.
