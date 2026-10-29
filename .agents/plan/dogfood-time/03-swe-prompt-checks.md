# Plan 03: Agent catalog — the checks before completion of `swe@1`

## Scope

This plan copies step 4 of the root `swe@1` prompt into the engine prompt (decision D9, suggestion S1 of the time optimization review).

Root cause: step 4 of `static/prompt/swe@1.md:13` tells the coder to "Run the verification commands of the work prompt, also when a command runs a whole test suite." Root pull request #277 changed step 4 of `docs/brainstorm/assets/prompt/swe@1.md:13`. The new text tells the coder to run the targeted verification commands, and a whole suite only when the change needs one. The engine prompt still holds the old text. In phase 1, `bash` tool calls of 4 min or more took 67.7 min of the coder executions (`00-index.md`, "Out of scope").

The plan delivers:

- Step 4 of `static/prompt/swe@1.md` with the root text, word for word.
- The assert of `src/agent/catalog.test.ts` that reads step 4.

Out of scope:

- Every other line of `static/prompt/swe@1.md`. A diff against the root prompt at `c8c41e7` shows only line 13.
- Root `docs/brainstorm/HANDOFF.md:89`. Aelita opens the root pull request that deletes its prompt clause.

## Model

Sonnet at medium effort. The change is one prompt line and one test assert.

## Sources

- Root `docs/brainstorm/assets/prompt/swe@1.md:13` — step 4 "Checks before completion".
- Root `docs/brainstorm/HANDOFF.md:89` — the copy of the prompt into `engine/static/prompt/swe@1.md`.

## Depends on

- Start from `origin/main` of `kanthorlabs/kanthord-engine`. Plans 01, 02 and 04 touch no file of this plan.

## Tasks

### 03.1 Change the assert first

- Files: `src/agent/catalog.test.ts` (edit)
- Do:
  1. The assert at `:105-109` reads "Run every test file that names such a symbol. Run the verification commands of the work prompt, also when a command runs a whole test suite. Do not run another whole test suite."
  2. Replace its text with "Run every test file that names such a symbol. Run the verification commands of the work prompt that run targeted tests. Run a whole test suite only when your change needs one, for example after a change to a shared module."
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/agent/catalog.test.ts` fails on the changed assert only.

### 03.2 Copy step 4

- Files: `static/prompt/swe@1.md` (edit)
- Do:
  1. Replace line 13 with line 13 of root `docs/brainstorm/assets/prompt/swe@1.md` at `c8c41e7`, word for word.
  2. Run `rg -n 'whole test suite' src static`. Each other hit that quotes the old text of step 4 takes the new text. Change no other text.
- Cite: decision D9.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/agent/catalog.test.ts` passes.

### 03.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the changed assert of task 03.1 failed before task 03.2 and passes after it.
- Run `rg -n 'Do not run another whole test suite' static src`. It prints nothing.
- In the superrepo checkout, `diff docs/brainstorm/assets/prompt/swe@1.md <engine worktree>/static/prompt/swe@1.md` prints nothing.
