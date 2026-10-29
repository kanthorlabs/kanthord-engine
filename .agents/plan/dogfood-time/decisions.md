# Dogfood time plan decisions

The plans cite these decisions as D1 to D9. Each decision binds every plan and every task of this set.

## D1 — Source and gaps

The design pages under `docs/brainstorm/` of the root repository at `c8c41e7` are the rule (`engine/AGENTS.md:3-6`). The reference pages under `docs/reference/` follow them. A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report with the page line that proves the gap. Aelita brings it to Ulrich as one open item.

## D2 — The result copy

The rule of `docs/brainstorm/worker-service.impl.md:1475-1480` and `docs/brainstorm/mission-service.impl.md:236-245`:

- The copy applies inside one run list of the release gate and inside one run list of the evaluation. A run list has one tested input.
- A command copies when its text equals the text of an earlier item of the same run list. That earlier item has the class `pass`.
- The copy is the result `{ command, exit_code, signal, timed_out }` of the first run, as a new entry of `results` in list order. Its output is the output of the first run. Its flaky value is `false`.
- A copy writes no `worker.verification` span. Only the first run writes one.
- The owner of each index does not change. The node commands come first, so a node command owns the first run.
- The live run of a unit and the affected test run copy nothing.

## D3 — The own commands

The rule of `docs/brainstorm/worker-service.impl.md:1276`, `:1368-1370` and `:1409-1411`, and `docs/brainstorm/worker-service.md:403` and `:407`:

- An own command of a unit is a verification of the unit whose text equals no verification of the node.
- The live checkout runs only the own commands of a unit, in the order of the unit list. This applies to a task unit, to the node unit of a node with no task and to the verdict unit.
- The node unit and the verdict unit hold no own command. Their live verification passes with an empty list.
- The release gate keeps every node command and every task command in its run list. Decision D2 runs a repeated command once.
- A done record certifies the own commands of its unit only. Its digest stays the digest of the unit content.

## D4 — The release gate run and the reviewer run stay

RULED 2026-10-29 by Ulrich (open items O1 and O2, option A). The release gate runs every listed command in its clean clone, and a live result never counts there. The reviewer runs every listed command of the pinned revision, and the coder evidence replaces none of them. Plan 01 copies a repeated command inside one run list (decision D2). Plan 02 removes the node commands from the live checkout (decision D3).

## D5 — T3: no rule for the plan text

A plan keeps the whole suite in the node and in one task of the node. The import requires that each node verification equals a verification of one task of the node (`docs/brainstorm/mission-service.md:257`, `docs/reference/mission/import.md:36`). Decisions D2 and D3 run the repeated entry once at the release gate and once at the evaluation, and the live checkout skips it. No design page and no engine page gets a plan-writing rule.

## D6 — T5: the host suite of the next dogfood epic

The next dogfood epic runs the full engine suite on the host once, after the last merge of each phase. It does not pause the project between nodes for the host suite. CI `check` stays the suite gate of each pull request. A failed host suite at the end of a phase gets one fix node before the next phase starts. Aelita writes this rule in section "The host engine suite" and in section "Verification Gate" of the `epic.md` of the next epic. No plan of this set changes the engine for T5.

## D7 — Orphans

A plan removes each field, prop and helper that only fed the code that the plan removes. A plan removes no other dead code. It names other dead code in its pull request body.

## D8 — The usage of a stopped turn

RULED 2026-10-29 by Ulrich (open item O3, option B).

- At `message_end` of an assistant reply, the tracer keeps the usage attributes of that reply for the open turn.
- A turn that `stop` ends holds `error.type: stopped` and the usage attributes of its last finished reply. A turn with no finished reply holds `error.type: stopped` only.
- A turn that `turn_end` ends keeps its attributes of today.
- Root `docs/brainstorm/tracking-service.impl.md` adds this text after line 39: "A turn that the close of the agent trace ends also holds the usage attributes of its last finished reply. A revoked or lost execution counts no usage of a turn with no end. The session entry of the reply keeps the usage." Aelita opens the root pull request.

## D9 — The checks before completion of `swe@1`

RULED 2026-10-29 by Ulrich (suggestion S1, option A). Step 4 of `engine/static/prompt/swe@1.md` takes the text of step 4 of root `docs/brainstorm/assets/prompt/swe@1.md` at `c8c41e7`, word for word. No other line of the prompt changes. Aelita opens the root pull request that deletes the prompt clause of root `docs/brainstorm/HANDOFF.md:89`.
