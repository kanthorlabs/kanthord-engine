# Plan 08: Root — the explanation pages and the handoff item

## Scope

Repository: `kanthorlabs/kanthord`.

This plan writes the remainder of root `docs/brainstorm/HANDOFF.md:89` at `c418936`: "The same build also adds the floor attributes to `docs/explanation/worker-contract.md`, and restates the live run and the release gate in `docs/explanation/coder-worker.md`." It also deletes that item after plans 06 and 07 land.

Today `docs/explanation/coder-worker.md` states that each unit runs every verification of its list in the live checkout (`:291`), that the verdict unit runs the node verifications (`:375`) and that the release gate runs every listed command with no copy and no memo (`:388`). `docs/explanation/worker-contract.md:103` lists no floor attribute. `docs/how-to-guides/declare-affected-tests.md:92` gives the report `version` `1` only.

The plan delivers:

- The floor attributes in the row `worker.verification` of `worker-contract.md`.
- The own commands, the result copy, the verification memo and the done record in `coder-worker.md`.
- The report version 2 with `floor` in `declare-affected-tests.md`.
- The deletion of the item `HANDOFF.md:89`.

Out of scope:

- The design pages under `docs/brainstorm/`. Root pull request #277 holds the rules.
- The suite pass proposal (open items O1 and O2).

## Model

Sonnet at high effort. The plan restates merged behavior in three pages, and each sentence cites the design page and the engine code.

## Sources

- `docs/brainstorm/worker-service.impl.md:1368-1370` — the own command, the skip of each node command, the done record.
- `docs/brainstorm/worker-service.impl.md:1388`, `:1409-1411` — the release gate and the verdict unit.
- `docs/brainstorm/worker-service.impl.md:1475-1493` — the result copy and the verification memo.
- `docs/brainstorm/worker-service.impl.md:1595-1611` — the report version 2.
- `docs/brainstorm/tracking-service.impl.md:86-88` — the floor attributes.
- `docs/brainstorm/worker-service.md:400-411`, `:428` — the summary text of the same rules.
- The merged code of `dogfood-time/` plans 01 and 02 and of this set, plans 01, 02, 06 and 07.

## Depends on

- Plans 01 and 02 of this set merged to engine `main`. Plans 06 and 07 landed on engine `main` and apps `main`.
- Start from `origin/main` of `kanthorlabs/kanthord`.

## Provides

No code seam.

## Tasks

### 08.1 Add the floor attributes

- Files: `docs/explanation/worker-contract.md` (edit)
- Do:
  1. In the row `worker.verification` (`:103`), after `kanthord.affected.failed`, add: "`kanthord.affected.floor_count` and `kanthord.affected.floor_seconds` from `floor` of a version 2 report, and `kanthord.affected.total_seconds` when `floor.total_seconds` is not null".
  2. Keep every other cell of the row.
- Cite: `tracking-service.impl.md:86-88`; engine `src/worker/unit/method-telemetry.ts`, `affectedEnd`.
- Verify: `npx prettier --check docs/explanation/worker-contract.md` passes.

### 08.2 Restate the live run and the release gate

- Files: `docs/explanation/coder-worker.md` (edit)
- Do:
  1. In "In short" (`:26`), state that the live checkout runs only the own commands of a unit, and that the release gate runs each node command once in a clean clone.
  2. In step 6 (`:238`), state that the node unit holds the node verifications, and that each of them is a node command, so the node unit has no own command.
  3. In step 7, item 5 (`:291`) and the diagram text (`:266`, `:274`), replace "each verification command of the unit" with "each own command of the unit". Define the own command: a verification of the unit that the node does not list. State that a unit with no own command passes with an empty list.
  4. In step 7, add the memo: inside one execution, a command on an unchanged tree reuses its earlier pass. Only the release gate also reuses a code failure. No timeout, cancellation or infrastructure result is reused. A hit writes no span.
  5. In "The done record" (`:357-367`), state that a done record certifies the own commands of its unit only.
  6. In "The verdict unit" (`:375`), replace "It runs the node verifications only." with "It runs no command in the live checkout. The release gate runs the node verifications."
  7. In steps 8 and 9, item 2 (`:388`), add: "A command that the list holds again copies the result of its first run. A command that passed on the same tree in this execution reuses that pass."
  8. Check each example of "Example: a run with no problem" (`:101-178`), "A verification fails" (`:546-565`), "The release gate fails" (`:592-594`) and the rework example (`:669-695`). Change each sentence that runs a node command in the live checkout.
- Cite: `worker-service.impl.md:1368-1370`, `:1388`, `:1411`, `:1475-1493`; engine `src/worker/unit/steps-implement.ts` `ownCommandsOf`, `src/worker/unit/verification-memo.ts`.
- Verify: `npx prettier --check docs/explanation/coder-worker.md` passes. `rg -n 'runs the node verifications only|each verification command of the unit' docs/explanation/coder-worker.md` prints nothing.

### 08.3 Give the report version 2 in the how-to page

- Files: `docs/how-to-guides/declare-affected-tests.md` (edit)
- Do:
  1. In the report table (`:92`), change `version` to "`1` or `2`. Version 2 adds the optional `floor`."
  2. Add the row `floor`: "Version 2 only. `tests`: the count of test files whose import closure holds every production file. `seconds`: the test time of those files that ran. `total_seconds`: the test time of every test file, or null unless `selection` is `all`."
  3. Keep the declaration `version` `1` (`:129`). The declaration has no version 2.
- Cite: `worker-service.impl.md:1595-1598`.
- Verify: `npx prettier --check docs/how-to-guides/declare-affected-tests.md` passes.

### 08.4 Delete the handoff item

- Files: `docs/brainstorm/HANDOFF.md` (edit)
- Do:
  1. Delete the item of `:89` that names the engine plan set `suite-pass-record`.
  2. Keep every other item.
- Verify: `rg -n 'suite-pass-record' docs/brainstorm/HANDOFF.md` prints nothing. `npx prettier --check docs/brainstorm/HANDOFF.md` passes.

### 08.E Gate

- Run `npx prettier --check docs/explanation/worker-contract.md docs/explanation/coder-worker.md docs/how-to-guides/declare-affected-tests.md docs/brainstorm/HANDOFF.md`.
- Run `rg -n 'suite-pass-record' docs/brainstorm/HANDOFF.md`. It prints nothing.
- The pull request body lists each changed sentence with its design line and its engine function.
