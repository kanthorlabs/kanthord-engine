# EPIC 002 — Domain and state machine

Status: **ready**.

## Goal

The state machine of `docs/proposal/phase-1/state-machine.md` is defined as data and unit tested exhaustively. Every service interface of `docs/proposal/phase-1/domain.md` exists, including the ones phase 2 fills.

## Non-goals

- No scheduler. Phase 2 drives the machine.
- No persistence. EPIC 003 writes the rows, and the `CHECK` clauses restate these rules there.
- No agent, verify or lease behaviour. Their interfaces exist and their implementations throw `not-implemented`.

## Stories

- **`services/ids` and `services/clock`** — the two capabilities `domain/` may not hold. `domain/` is pure, so it mints no ULID and reads no wall clock. `IdGenerator` mints a prefixed ULID per kind, and `Clock` returns the one timestamp a command needs. A command takes both through its dependencies, and a test passes a Mock, which is what makes an id and a timestamp assertable rather than "some value".
- **Identity** — the prefixed-ULID grammar, and parse. Parsing and prefix-to-kind agreement are pure and stay in `domain/`; a prefix that disagrees with a kind is an error. Minting is `services/ids`.
- **The schema inventory, in three categories** — the phase goal says every entity exists, so the plan states what counts. **Persisted row schemas**, one per phase-1 table: repository, project, project binding, provider, profile, blob, node, edge, plan revision, workspace, lease, run, attempt, agent invocation, candidate, check result, git operation, event, migration. A row schema exists because the table exists, not because a phase-1 command reads it. **Value schemas**: the state, the block reason, the identity, the blob reference. **Code-defined registries**: the closed worker-kind set and the closed agent-kind set.
- **The worker and agent registries** — two closed zod enums in `domain/`, and the TypeScript type derives from each. Worker kinds are `general@1`, `tdd@1` and `git@1`; agent kinds are `general@1`, `swe@1`, `te@1` and `re@1`. Both are phase-1 vocabulary with phase-1 consumers, and neither carries an implementation. Worker appears in plan frontmatter, `project.worker`, `node.worker` and `run.worker`. Agent appears in the `agent_invocation.agents` `CHECK` clause of `docs/proposal/database/agent_invocation.md` and in the `agent` service interface, which types a role rather than accepting a string. EPIC 008 validates against these enums rather than restating them, and EPIC 003 asserts the DDL `CHECK` agrees with the enum.
- **The profile row, and only the row** — the four columns of `docs/proposal/database/profile.md`: `id`, `repository_id`, `content_blob`, `updated_at`, plus the `profile_` identity kind. `docs/proposal/phase-2/README.md` owns the profile document: its frontmatter, the `checks` map, the template metadata and the role prose. That split is the point of the table design — the row holds no copy of a document field, "because a copy in a column would be a second truth that drifts". Phase 1 must not parse, render or validate the document.

  **The seams phase 1 owes phase 2.** `docs/proposal/phase-2/README.md` implements `general@1` and `re@1` on `pi-coding-agent`, and the `general@1` worker that composes them. Phase 1 leaves the vocabulary and the storage, and nothing behind them: the two registries above; the `agent`, `verify` and `lease` interfaces that exist and throw (this epic); the `run`, `attempt`, `agent_invocation`, `candidate` and `check_result` tables (EPIC 003); the `profile` table with `content_blob` referencing `blob`, and `workspace.profile_blob` referencing `blob`, which together are the pin that lets phase 2 fix a profile per objective (EPIC 003); the blob store (EPIC 003); and every phase-2 and phase-3 route installed with its operation id, path, lifecycle, authentication and `501` answer — execution, outcome, profile, template, `agent.list` and `instructions.resolve` alike (EPIC 010). `tdd@1`, `swe@1`, `te@1` and `git@1` are enumerated here and built after the MVP.

- **Transition matrix as data** — every ordered pair of different states at each of the three levels, with the note of each row. `canTransition(level, from, to)` reads the table.
- **Aggregation per level** — `done` when every child is `done`; `partial` when at least one is `done` and at least one is `discarded`; `discarded` when every child is `discarded`. A task is never `partial`.
- **Readiness and block reasons** — a node is `ready` when every dependency is `done` or `partial`. The six block reasons, and which of them `unblock` clears alone.
- **Task order** — a topological walk, tie-broken by the ULID part of the identity. No position field.
- **Attempt accounting** — a rejection increments; the configured limit moves the task to `blocked` with `attempt-limit`.
- **Service interfaces** — config, storage, crypto, git, graph, event, agent, verify, lease, ids, clock. A phase-2 interface exists and throws.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test src/domain/**/*.test.ts && echo "PASS EPIC-002"
```

Hermetic coverage required beyond the Proof:

- The transition test enumerates the full cross product of states at all three levels and asserts the matrix cell, so a missing pair fails rather than passes silently.
- Aggregation is asserted on every combination of child outcomes at both parent levels.
- Task order is asserted stable across repeated runs on a graph with two unordered tasks.
- A lint rule proves `domain/` imports neither `ulid` nor a clock, so minting cannot drift back into the pure layer.
