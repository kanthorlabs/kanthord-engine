# Story 03 — The documents name P1-E5

Epic: `.agent/plan/epics/011.2-the-deployment-scenarios-move-to-phase-3.md`
Depends on: Story 01.

This story ships no production code and no new test. It resolves the written references a code
rename cannot reach.

## Change — the enumerated list

Edit exactly these files, and no others.

| File                                                                        | Edit                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `.agent/plan/stories/007-repository-registration/13-e2e-acceptance-gate.md` | every `P1-E3` becomes `P1-E5`; the gate it describes is the one-machine real-repository run |

Nothing else needs an edit. Stories 01 and 02 cover every code and message site, and the proposal
and the two acceptance documents were amended ahead of this epic.

## Change — nothing, in these files

Confirm each still contains `P1-E3` after the story, and leave every one untouched. A closed
record states what it did at the time, and rewriting it destroys the history.

- `.agent/plan/epics/011-end-to-end-scenarios.md`
- `.agent/plan/epics/011.1-acceptance-run-preconditions.md`
- `.agent/plan/stories/011-end-to-end-scenarios/**` — `01-the-runner.md`,
  `04-p1-e1-the-onboarding-journey.md`, `06-the-driver-and-the-profile.md`,
  `11-p1-e3-the-vpn-run.md`, `index.md`
- `.agent/plan/stories/011.2-the-deployment-scenarios-move-to-phase-3/**` — this story set names
  the old id because it performs the rename
- `.agent/tdd/history/**` — `2026-08-07-011-end-to-end-scenarios.md`,
  `2026-08-08-011-end-to-end-scenarios.md`,
  `2026-08-09-011.1-acceptance-run-preconditions.md`
- `.agent/tdd/memory/software-engineer/2026-08-08.md`
- `.agent/tdd/memory/test-engineer/2026-08-08.md`

## Change — confirm, do not re-edit

These carry the new names already. Read each and confirm; change nothing.

- `docs/proposal/README.md` — the four modes, and the rule that every `deployment` scenario
  belongs to phase 3
- `docs/proposal/phase-1/README.md` — the P1-E5 declaration and the exit criterion
- `docs/proposal/phase-2/README.md` — the P3-E7 pointer
- `docs/proposal/phase-3/README.md` — P3-E6 and P3-E7
- `docs/proposal/api/repository.md:14` and `:104`
- `.agent/plan/epics/012-phase-1-acceptance-run.md`
- `.claude/commands/e2e.md`

## Constraints

- Change no oracle text. A scenario's mode, driver, profile and assertions belong to the
  proposal.
- Do not delete `scripts/e2e/lib/driver/ssh.ts` or its test. Phase 3 consumes the driver.

## Verify

- This command prints nothing:

  ```bash
  grep -rl "P1-E3\|P2-E5" . \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.data \
    | grep -v '^\./\.agent/plan/epics/011-end-to-end-scenarios\.md$' \
    | grep -v '^\./\.agent/plan/epics/011\.1-acceptance-run-preconditions\.md$' \
    | grep -v '^\./\.agent/plan/stories/011-end-to-end-scenarios/' \
    | grep -v '^\./\.agent/plan/stories/011\.2-the-deployment-scenarios-move-to-phase-3/' \
    | grep -v '^\./\.agent/tdd/'
  ```

  Run it from the repository root. A non-empty result names a file this story missed.

- `npx prettier --check .agent/plan/stories/007-repository-registration/13-e2e-acceptance-gate.md`
  passes.
- `npm run verify` exits 0.
- Proof: delivers the EPIC coverage item
  `P1-E3 is not a known scenario id, and the runner names P1-E5 in its refusal`, jointly with
  Story 01.
