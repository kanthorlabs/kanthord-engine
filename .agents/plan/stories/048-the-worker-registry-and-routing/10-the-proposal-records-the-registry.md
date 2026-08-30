# Story 10 — The proposal records the registry

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 2, Story 6, Story 7

## Change

- Edit `docs/proposal/phase-2/agents-and-workers.md`.
  1. Delete the harness-qualified paragraph at line 9 (the paragraph beginning "A worker kind executes one objective under a lease. Kinds are `general@1`…" through "A node carrying a harness-qualified kind is claimed and reported through the same operations as any other node. Worker binding precedence is project, then graph, then node. The most specific binding wins. An objective binds one repository, so a node-level binding changes the worker kind only.").
  2. Replace the deleted content with the following information, stated as a decision document (state each fact, omit alternatives and history):
     - The worker id grammar: `^[a-z][a-z0-9-]*@[1-9][0-9]*$`. A dot is forbidden so that a harness cannot be smuggled into a name.
     - The three `composition` values: `single` (one execution path driving at most one agent), `composed` (drives multiple agents), `self-managed` (an external harness drives its own agents). The set is closed.
     - The two-entry registry table with all fields for both entries (copy the Decisions table from the EPIC verbatim: `claude@1` and `opencode@1` with driver, agents, claims, deliverables, harness, composition).
     - Every internal worker (`general@1`, `tdd@1`, `poc@1`, `research@1`, `git@1`) is phase-2 work and is absent from the registry.
     - `expansion` and `initiative` are unroutable until an internal worker is registered in the registry.
     - The three eligible sets and their subset rule: `capable ⊇ authorized ⊇ available`. `capable` is derived from the registry alone. `authorized` is supplied by the caller. `available` is supplied by the caller.
     - Routing takes the first entry of the intersection in registry declaration order.
     - An empty intersection answers `unroutable` with `failedSet` naming the first set (in the order `capable`, `authorized`, `available`) whose intersection with the previous sets is empty.
     - The four role contracts (one record per agent): agent id, purpose, and capabilities.tools. State that `re@1` holds `read, bash, grep, find, ls` and the other three hold the full tool set.
     - The closed harness set: `claude-code` and `opencode` (deny by default), `pi` (does not deny by default). Generation fails when a harness cannot deny by default.
     - Role path ownership is not represented. The constraint that `swe@1` and `te@1` differ by paths is stated as an open gap.

## Constraints

- Write in decision-document style: state the decision and its constraints. Cut every alternative, rejection, comparison and measurement.
- Do not add motivation, history, or the phrase "EPIC 048" into the document.

## Verify

- `docs/proposal/phase-2/agents-and-workers.md` exists and contains no harness-qualified paragraph (the paragraph that begins "A worker kind executes one objective under a lease" and mentions `claude.swe@1`).
- `pnpm run verify` exits 0 (the proposal test at `test/helpers/proposal.ts` passes).
- Proof: none in the `PASS EPIC-048` Proof block; this story has no dedicated test file. It satisfies the document-amendment requirement of the EPIC.
