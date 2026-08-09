# Story 08 — The proposal states what a human confirms

Epic: `.agent/plan/epics/011.1-acceptance-run-preconditions.md`

This story ships no test. It changes exact text in two files, and a reviewer checks each string.

## Change

### 1. `docs/proposal/phase-1/README.md:13`

Replace the whole line:

```markdown
**Exit criteria:** Ulrich onboards his real repository from a second machine over the VPN, imports a two-objective plan, exports it identical, and reads status. Every execution route answers `not-implemented`.
```

with:

```markdown
**Exit criteria:** Ulrich onboards his real repository from a second machine over the VPN, imports a two-objective plan, exports it identical, and reads status. Every execution route answers `not-implemented`. A coding agent rehearses every scenario and reports the run green. Ulrich then drives the same journey through the same CLI and the same API, and confirms it. The confirmation is recorded, and the phase does not exit without it.
```

The Goal sentence at line 5, "a human drives the daemon end to end", stays unchanged.

### 2. `docs/proposal/README.md:40`

Replace the whole line:

```markdown
Every scenario is executable by a coding agent and by a human, with no separate procedure for either. There is no actor field. A scenario that only a human can judge is not a scenario; it is product acceptance, and it is recorded separately.
```

with:

```markdown
Every scenario is executable by a coding agent and by a human, with no separate procedure for either. There is no actor field. A scenario that only a human can judge is not a scenario; it is product acceptance, and it is recorded separately. Recorded separately means it is not an oracle and not a scenario. It carries its own verdict, and a phase exits on the scenario verdict and the acceptance verdict together.
```

## Constraints

- Two amendments, and nothing else changes in `docs/proposal/`. Do not touch the acceptance table at
  `docs/proposal/README.md:82-88`, the scenario oracles at `docs/proposal/phase-1/README.md:61-110`,
  or any other line.
- Keep the `docs/proposal/` prose style: one paragraph per line, no hard wrap, no new heading, no new
  bullet.
- Do not add the four judgment subjects to `docs/proposal/README.md`. The EPIC scopes this story to
  two amendments. See the suggestion in `index.md`.
- `src/domain/rows.test.ts` reads `docs/proposal/phase-1/domain.md`, not these two files, so no test
  parses the changed text.

## Verify

- `git diff --stat docs/proposal/` reports exactly two files and exactly two changed lines.
- `npx prettier --check docs/proposal/README.md docs/proposal/phase-1/README.md` passes; the
  pre-commit hook runs `prettier --write` over `*.md`.
- `npm run verify` exits 0.
- Proof: this story delivers no line of the EPIC Proof block. A reviewer checks each replaced string
  against the two blocks above.
