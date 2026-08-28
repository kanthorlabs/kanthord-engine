# Story 4 — Proposal defines harness-qualified kinds

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`

## Change

Two files under `docs/proposal/phase-2/` need amending. No source files change.

### `docs/proposal/phase-2/agents-and-workers.md`

**Target: line 9.**

Current text of line 9:

```
A worker kind executes one objective under a lease. Kinds are `general@1`, `tdd@1` and `git@1`. Worker binding precedence is project, then graph, then node. The most specific binding wins. An objective binds one repository, so a node-level binding changes the worker kind only.
```

Replace with:

```
A worker kind executes one objective under a lease. Kinds are `general@1`, `tdd@1` and `git@1`. A harness-qualified kind names an external harness and the agent persona it dispatches, using the convention `<harness>.<agent>@<version>`. The four harness-qualified kinds are `claude.swe@1`, `claude.te@1`, `opencode.swe@1` and `opencode.te@1`. The daemon validates a harness-qualified kind at import and never executes one. Claim is not restricted by worker kind; an actor of one harness may claim a node of any worker kind. A node carrying a harness-qualified kind is claimed and reported through the same operations as any other node. Worker binding precedence is project, then graph, then node. The most specific binding wins. An objective binds one repository, so a node-level binding changes the worker kind only.
```

No other lines in this file change.

### `docs/proposal/phase-2/instructions-and-profiles.md`

**Target: line 9.**

Current text of line 9:

```
`tdd@1` is a worker strategy, not an agent. Worker kinds are `general@1`, `tdd@1` and `git@1`. `tdd@1` drives `te@1`, `swe@1` and `re@1`.
```

Replace with:

```
`tdd@1` is a worker strategy, not an agent. Worker kinds are `general@1`, `tdd@1` and `git@1`. Harness-qualified kinds are `claude.swe@1`, `claude.te@1`, `opencode.swe@1` and `opencode.te@1`; they name an external harness and the persona it dispatches and are validated at import but never executed by the daemon. `tdd@1` drives `te@1`, `swe@1` and `re@1`.
```

No other lines in this file change.

## Constraints

- Do not add the four values to the agent list on line 7 of `agents-and-workers.md`
  (`Agents are \`general@1\`, \`swe@1\`, \`te@1\` and \`re@1\`.`). Harness-qualified
  kinds are worker kinds, not agents.
- `swe@1` and `te@1` remain agent names and must not appear as worker kinds in either
  document.
- Do not edit any line other than line 9 in either file.

## Verify

The `docs/proposal/` files are not covered by the Proof command. Verify manually
that:

- `agents-and-workers.md:9` contains all four harness-qualified kind values in the
  fixed order.
- `instructions-and-profiles.md:9` contains all four harness-qualified kind values.
- Neither document lists `swe@1` or `te@1` as worker kinds.
- `npm run verify` exits 0 (no source changes means no new lint or compile errors).

Proof: this story delivers the EPIC Goal #3 (proposal document amendment); it does
not contribute a line to the `PASS EPIC-041` Proof command, which covers test files
only.
