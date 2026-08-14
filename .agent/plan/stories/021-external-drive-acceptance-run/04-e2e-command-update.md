# Story 4 — The `/e2e` command update

Epic: `.agent/plan/epics/021-external-drive-acceptance-run.md`
Depends on: Story 2, for the two options the run block gains.

This is the EPIC bullet at `021-external-drive-acceptance-run.md:127`. It edits `.claude/commands/e2e.md` and nothing else. **No other epic updates this file**: `020-wiring-and-scenarios.md:21` declares that EPIC 020 owns no acceptance run.

## Change

Five edits to `.claude/commands/e2e.md`. The file carries frontmatter at lines 1-5 with `description`, `argument-hint` and `allowed-tools`. **Leave the frontmatter unchanged.**

1. **Line 16.** Replace

   ```text
   This command drives EPIC 012. It executes scenarios; it never defines one.
   ```

   with

   ```text
   This command drives EPIC 012 and EPIC 021. The phase argument selects the id
   list. It executes scenarios; it never defines one.
   ```

2. **Lines 42-44, the run lead-in.** Keep the phase-1 sentence and add the phase-1b sentence after it, so both id lists sit beside each other:

   ```text
   Every invocation takes the same `--tag`, so one acceptance run writes one set of
   bundles. Read the phase README for the declared ids; phase 1 is `P1-E1`, `P1-E2`,
   `P1-E4` and `P1-E5`. Phase 1b is those four plus `P1B-E1`, `P1B-E2` and
   `P1B-E3`, run in one order.
   ```

3. **The `sh` block at lines 46-54.** Keep the phase-1 block as it is, and add a second labelled `sh` block after it for phase 1b, in the order of `021-external-drive-acceptance-run.md:131`:

   ```sh
   export TAG=$(node scripts/e2e/run.mjs --mint-tag)
   node scripts/e2e/run.mjs P1-E1 --tag "$TAG"    # fixture baseline, local driver
   node scripts/e2e/run.mjs P1-E2 --tag "$TAG"    # transport policy, local driver
   node scripts/e2e/run.mjs P1B-E1 --tag "$TAG"   # single harness loop, local driver
   node scripts/e2e/run.mjs P1-E4 --tag "$TAG"    # two namespaces, podman driver
   node scripts/e2e/run.mjs P1B-E2 --tag "$TAG"   # two clients, podman driver
   node scripts/e2e/run.mjs P1B-E3 --tag "$TAG"   # the takeover, podman driver
   node scripts/e2e/run.mjs P1-E5 --tag "$TAG"    # real repository, local driver
   node scripts/e2e/run.mjs --record-verify --tag "$TAG"
   node scripts/e2e/run.mjs --record-manifest --tag "$TAG" --manifest "$MANIFEST"
   node scripts/e2e/run.mjs --verdict "$TAG" --scenarios-only
   ```

   The `--record-manifest` line sits **before** the rehearsal verdict. The order paragraph at lines 56-58 gains one sentence: the three Podman ids run as one group because they share the container prerequisite, and `P1B-E1` runs on the `local` driver before the first container is built.

4. **Lines 109-114, the acceptance subjects.** Label the existing paragraph `For phase 1` and add a second paragraph labelled `For phase 1b`, naming the six checklist rows of `021-external-drive-acceptance-run.md:153-161` by subject: the graph reads as the plan; the work is attributed; the result is readable from the node; the refusal is legible; the close is a human act; the block broke nothing he uses. State that each row is answered `confirmed` or `rejected`, that a `rejected` row carries a note, and that the answers reach the manifest of Story 1.

5. **The `## The verdict` section at line 142.** Add `--check-manifest` beside `--verdict`, after the `--record-acceptance` invocation of lines 116-119:

   ```sh
   node scripts/e2e/run.mjs --record-manifest --tag "$TAG" --manifest "$MANIFEST"
   node scripts/e2e/run.mjs --check-manifest "$TAG"
   node scripts/e2e/run.mjs --verdict "$TAG"
   ```

   State that `--check-manifest` checks the run procedure and `--verdict` checks both axes, and that the block closes on a zero exit status from both.

## Constraints

- **The exit-code table at lines 151-157 is unchanged.** This epic adds no exit code, and that table is the one place a number is stated.
- The two rules at lines 20-26 are unchanged. This epic restates no oracle and invents no scenario.
- Edit no file under `src/`, no file under `docs/proposal/` and no other file under `.claude/`.
- Add no `--check-manifest` row to the report checklist at lines 128-140 that duplicates the verdict row; add one bullet naming `--check-manifest` and its exit status beside the existing `--verdict` bullet at line 137.

## Verify

- `git diff --name-only` names `.claude/commands/e2e.md` and no other path.
- Read the file back and confirm, by exact string:
  - line 16 names both EPIC 012 and EPIC 021;
  - the phase-1b `sh` block holds seven scenario invocations in the order `P1-E1`, `P1-E2`, `P1B-E1`, `P1-E4`, `P1B-E2`, `P1B-E3`, `P1-E5`;
  - `--record-manifest` appears before `--verdict … --scenarios-only`;
  - `--check-manifest` appears before the full `--verdict`;
  - the exit-code table still holds exactly four rows with exit values `0`, `1`, `2` and `3`.
- `npm run verify` exits 0. This file is not TypeScript, so the gate proves only that no source changed.
- Proof: none of its own. It makes the run block of `021-external-drive-acceptance-run.md:200-218` executable by the `/e2e` driver.
