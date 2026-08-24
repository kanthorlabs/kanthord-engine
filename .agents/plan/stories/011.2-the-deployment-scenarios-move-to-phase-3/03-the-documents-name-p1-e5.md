# Story 03 — The documents name P1-E5

Epic: `.agents/plan/epics/011.2-the-deployment-scenarios-move-to-phase-3.md`
Depends on: Story 01.

This story ships no production code, no new test and no edit. It confirms the written references a
code rename cannot reach. Stories 01 and 02 cover every code and message site. The two live
documents the EPIC names were amended ahead of this epic.

## Change — nothing

Edit no file. A story that edits nothing still has a job: it proves the rename is complete, and it
names every place the old id stays on purpose.

## Change — confirm, do not re-edit

These carry the new names already. Read each and confirm; change nothing.

- `docs/proposal/README.md` — the four modes, and the rule that every `deployment` scenario
  belongs to phase 3
- `docs/proposal/phase-1/README.md` — the P1-E5 declaration and the exit criterion
- `docs/proposal/phase-2/README.md` — the P3-E7 pointer
- `docs/proposal/phase-3/README.md` — P3-E6 and P3-E7
- `docs/proposal/api/repository.md:14` and `:104`
- `.agents/plan/epics/012-phase-1-acceptance-run.md`
- `.claude/commands/e2e.md`

## Change — nothing, in these records

A closed record states what it did at the time, and rewriting it destroys the history. Confirm each
still contains `P1-E3` after the story, and leave every one untouched.

- `.agents/plan/epics/000-phase-1-overview.md`
- `.agents/plan/epics/007-repository-registration.md`
- `.agents/plan/stories/007-repository-registration/**` — `10-repository-register.md`,
  `11-repository-projection.md`, `13-e2e-acceptance-gate.md`, `index.md`
- `.agents/plan/epics/011-end-to-end-scenarios.md`
- `.agents/plan/stories/011-end-to-end-scenarios/**` — `01-the-runner.md`,
  `04-p1-e1-the-onboarding-journey.md`, `06-the-driver-and-the-profile.md`,
  `11-p1-e3-the-vpn-run.md`, `index.md`
- `.agents/plan/epics/011.1-acceptance-run-preconditions.md`
- `.agents/plan/stories/011.1-acceptance-run-preconditions/**` — `03-the-acceptance-record.md`,
  `04-the-verdict-command.md`, `07-the-real-profile-reads-env-e2e.md`,
  `09-the-driver-matches-the-mechanism.md`, `index.md`
- `.agents/plan/stories/011.2-the-deployment-scenarios-move-to-phase-3/**` — this story set names
  the old id because it performs the rename
- `.agents/tdd/**`

## Change — nothing, in this code site

- `scripts/e2e/lib/main.test.ts` — `P1-E3` is the id the runner refuses. The EPIC coverage item
  `P1-E3 is not a known scenario id, and the runner names P1-E5 in its refusal` requires the
  refusal to name it. Deleting the string deletes the assertion.

## Constraints

- Change no oracle text. A scenario's mode, driver, profile and assertions belong to the
  proposal.
- Do not delete `scripts/e2e/lib/driver/ssh.ts` or its test. Phase 3 consumes the driver.

## Verify

- This command prints nothing:

  ```bash
  grep -rl "P1-E3" . \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.data \
    --exclude-dir=.agents \
    | grep -v 'scripts/e2e/lib/main\.test\.ts$'
  ```

  Run it from the repository root. A non-empty result names a live document that still carries the
  old id. The `.agents` tree is excluded whole, because every record in it is closed. Match the
  retained path by suffix, never with a `^\./` anchor: `--exclude-dir` drops the `./` prefix from
  the output, so an anchored filter matches nothing and the check passes for the wrong reason.

- `npm run verify` exits 0.
- Proof: delivers the EPIC coverage item
  `P1-E3 is not a known scenario id, and the runner names P1-E5 in its refusal`, jointly with
  Story 01.
