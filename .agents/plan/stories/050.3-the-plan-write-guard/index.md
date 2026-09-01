# EPIC 050.3 — The plan-write guard — stories

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Prereq: EPIC 050 and EPIC 050.2, implemented. Every story here reads a `run` row and the `subtree-busy` refusal EPIC 050 registered.

A human editing the plan cannot write under a worker's feet. Five plan commands gain one guard, and the two lease-derived reads on a plan write stop being read.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the ship diagram. A story that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 enforces it.

Five stories carry a pair: 2, 3, 4, 5 and 6. Four carry none.

Four of the five ship diagrams pin their tail with `note over Command: tail unchanged by EPIC 050.3`. Each of those commands is between 250 and 760 lines and this epic inserts one read into its prefix. The pinned tail is listed in the story that pins it, so the claim is checkable by a reviewer rather than implied. The note claims one thing: no **seam call** after it moves. Story 3 deletes an array push and Story 7 changes a domain function inside a pinned tail, and neither is a message, so both notes stay true. Story 6 moves one seam call out of its tail, and the `~clock.now` citation is the declaration of exactly that. `unblock-node` is 123 lines and its whole trace is drawn.

## Dispatch order

Story 1 is independent — one new read on the plan store.

Story 8 registers the error code on five operations and must land before Stories 2 to 6, all of which throw it.

Stories 2, 3, 4, 5 and 6 depend on Stories 1 and 8, and are independent of each other. They can run concurrently, one command each.

Story 7 depends on Story 3, which removes the other reader of `facts.lease` in the same command.

Story 9 depends on every prior story.

A workable serial order: **1 → 8 → 2 → 3 → 4 → 5 → 6 → 7 → 9**.

## Stories

- 1 — The run-covers-node rule → `01-the-run-covers-node-rule.md`
- 2 — The create-node guard → `02-the-create-node-guard.md` — draws `baseline-create-node` and `create-node-guard`
- 3 — The update-node guard → `03-the-update-node-guard.md` — draws `baseline-update-node` and `update-node-guard`
- 4 — The delete-node guard → `04-the-delete-node-guard.md` — draws `baseline-delete-node` and `delete-node-guard`
- 5 — The unblock-node guard → `05-the-unblock-node-guard.md` — draws `baseline-unblock-node` and `unblock-node-guard`
- 6 — The import-plan guard → `06-the-import-plan-guard.md` — draws `baseline-import-plan` and `import-plan-guard`
- 7 — Containment stops reading the lease → `07-containment-stops-reading-the-lease.md`
- 8 — `subtree-busy` joins the plan operations → `08-subtree-busy-joins-the-plan-operations.md`
- 9 — The proposal records one guard → `09-the-proposal-records-one-guard.md`

## Facts, verified against the source

The epic that preceded this split described a guard the code does not have. Each of these was checked
before the stories were written, and each one changed a story.

- **`leaseHeld` is private.** `src/services/plan/sqlite.ts:558`, called only at `:276` and `:306`. No command calls it, so no command's seam trace changes when it dies.
- **One command names the lease.** `grep -n "lease" src/commands/node/*.ts src/commands/plan/import-plan.ts` returns exactly `update-node.ts:187`. `create-node.ts` and `unblock-node.ts` hold no guard, so Stories 2 and 5 **add** a refusal rather than replacing one.
- **`containmentMovable` is the second reader.** `src/domain/plan-containment.ts:9` tests `!facts.lease`, and it is reached from `update-node.ts:184` and `import-plan.ts:316`. It is a domain function, so it is invisible at the seam and Story 7 draws nothing.
- **`delete-node`'s guard is a third path.** `readSubtreeExecutionFacts` at `sqlite.ts:349-353` carries a `lease` member in the closed `executionBlockers` list, and `delete-node.ts:105` refuses `binding-in-use` on any member. That list already carries a `run` member at `:359-361`, matching any run row rather than an active one. EPIC 050.4 swaps them; this epic leaves both.
- **No plan operation declares `lease-held`.** `grep -rn '"lease-held"' src/http/contract/` binds it to `node.claim`, `node.heartbeat`, `node.release` and `node.report`. Story 8 therefore adds and removes nothing.
- **`delete-node` reads the clock late.** `:75`, after two plan reads — the only one of the five that does not read it first. Its baseline draws that order.
- **`import-plan` reads the clock at `:390`, inside the tail.** Story 6 moves it to the top of the transaction so the guard has a `now`, and the move carries `~clock.now` with a citation rather than `+`. It is the one seam call that leaves a pinned tail in this epic.
- **`import-plan` cannot seed its guard before `:190`.** The ids it deletes are the project's nodes no submitted document names, and that set needs `storedNodes` from the graph read. Its guard therefore sits after that read and before the first write at `:408`, and its diagram draws the ordinal.
- **`create-node` writes before it reads the graph.** `blobs.put` at `:116` and `:122` precede `plan.readGraph` at `:128`. That is why `runCoversNode` expands the closure inside the store: a command-side ancestor walk would need the graph read, and placing the guard after it would refuse after two blob writes.

## Decisions the source check forced

- **The seed is what the command names; the closure is what the store computes.** Five commands pass between one id and a whole document set, and none of them holds an ancestor list at the point the guard must fire.
- **The closure is symmetric, and the direction is not a per-command mode.** A run above a seed covers it and a run below it covers it, in all five commands. The consequences are stated: a run on an existing child refuses a `create-node` under that parent, and a run on a descendant refuses an `update-node` of an objective. A mode argument whose two values no test could tell apart from a bug is not worth the parameter.
- **`relation` has a precedence, because a multi-id seed makes one node two things.** `self` beats `ancestor` beats `descendant`, evaluated over the seed set as a whole. The bytewise tie-break picks the row; the precedence names it. Only `import-plan` passes such a seed.
- **The pair draws the path that still succeeds.** Each guarded command's diagram uses a fixture with no active run, because that is the path whose seam order changed. Drawing the refusal would give the story a second live diagram. The refusal is proven by its own case and by the byte-identical comparison, and each story names which.
- **The guard is the last refusal in `unblock-node` and an early one everywhere else.** In each command it follows the refusals decided from a row already read and precedes the first write. The drawn ordinal is the contract, and the byte-identical assertion is the proof.
- **One shipped behaviour is relaxed, in two commands.** A node holding a live node lease and no run was refused a containment move and is now admitted. `containmentMovable` has two callers — `update-node.ts:184` and `import-plan.ts:316` — so the one-line change relaxes both. The lease is written only by a claim, and from EPIC 050.1 a claim writes a run in the same transaction, so the two disagree only for a row left by a crash, which EPIC 050.4 deletes. Story 3 asserts the update case and Story 7 asserts the import case, so it is a decision and not a regression.
- **`ContainmentFacts.lease` survives unread for one epic.** Deleting the field belongs with `leaseHeld`, the private method that computes it, and that is EPIC 050.4's story 5. Story 7 asserts no production file reads it, which is what makes the interval safe.

## What this epic is not

It is **not** invisible to a document reader. Five operations gain a declared error, so every emitted
OpenAPI document changes. That change is adding a member to an enum, which `docs/proposal/api/README.md:96`
permits inside `/v1` and which a client must tolerate by the same document, so the version moves by
patch and no capability is retired. The epic says so in those terms rather than claiming to be
wire-invisible, which it is not.

## Still open

Nothing blocks dispatch.
