# EPIC 002 — Domain and state machine

Status: **draft**.

## Goal

The state machine of `docs/proposal/phase-1/state-machine.md` is defined as data and unit tested exhaustively. Every service interface of `docs/proposal/phase-1/domain.md` exists, including the ones phase 2 fills.

## Non-goals

- No scheduler. Phase 2 drives the machine.
- No persistence. EPIC 003 writes the rows, and the `CHECK` clauses restate these rules there.
- No agent, verify or lease behaviour. Their interfaces exist and their implementations throw `not-implemented`.

## Stories

- **Identity** — a prefixed ULID per kind, mint and parse. A prefix that disagrees with a kind is an error.
- **Entity schemas on zod** — repository, project, provider, profile, node, edge, plan revision, workspace, lease, run, attempt, candidate, check result, git operation, event.
- **Transition matrix as data** — every ordered pair of different states at each of the three levels, with the note of each row. `canTransition(level, from, to)` reads the table.
- **Aggregation per level** — `done` when every child is `done`; `partial` when at least one is `done` and at least one is `discarded`; `discarded` when every child is `discarded`. A task is never `partial`.
- **Readiness and block reasons** — a node is `ready` when every dependency is `done` or `partial`. The six block reasons, and which of them `unblock` clears alone.
- **Task order** — a topological walk, tie-broken by the ULID part of the identity. No position field.
- **Attempt accounting** — a rejection increments; the configured limit moves the task to `blocked` with `attempt-limit`.
- **Service interfaces** — config, storage, crypto, git, graph, event, agent, verify, lease. A phase-2 interface exists and throws.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"
```

Hermetic coverage required beyond the Proof:

- The transition test enumerates the full cross product of states at all three levels and asserts the matrix cell, so a missing pair fails rather than passes silently.
- Aggregation is asserted on every combination of child outcomes at both parent levels.
- Task order is asserted stable across repeated runs on a graph with two unordered tasks.
