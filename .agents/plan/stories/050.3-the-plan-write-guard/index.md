# EPIC 050.3 — The plan-write guard — stories

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Prereq: EPIC 050, EPIC 050.1 and EPIC 050.2, implemented. Every story here reads a `run` row of EPIC 050.1's migration `12`, drafted at `.agents/plan/pending/050.1-migration-12.md`, and the `subtree-busy` code EPIC 050.1 Story 1 (01-the-claim-contract) registered. Stories 2 to 6 also read the recorder of EPIC 050.1 Story 6 (06-the-conformance-harness) and the runner of EPIC 050.1 Story 7 (07-the-conformance-runner), because each adds a scenario file.

A human editing the plan cannot write under a worker's feet. Five plan commands gain one guard, and the two lease-derived reads on a plan write stop being read.

## Locked paths

**This epic holds no `00-groundwork.md`, because it needs no locked path.** Every path the nine
stories edit was checked with `scripts/lane-check.sh` against both engineer roles, and every one is
allowed to exactly one of them: `src/**` production source and `docs/proposal/**` to the
software-engineer, `src/**/*.test.ts`, `test/helpers/**` and `test/sequence/**` to the test-engineer.
No path is denied to both, so no `Executor:` line and no `Paths:` line appears in this epic, and
`.agents/plan/authoring.md` refuses an empty groundwork story written anyway.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the ship diagram. A story that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 enforces it.

Five stories carry a pair: 2, 3, 4, 5 and 6. Four carry none.

Four of the five ship diagrams pin their tail with `note over Command: tail unchanged by EPIC 050.3`. Each of those commands is between 250 and 800 lines and this epic inserts one read into its prefix. The pinned tail is listed in the story that pins it, so the claim is checkable by a reviewer rather than implied. The note claims one thing: no **seam call** after it moves. Story 3 deletes an array push and Story 7 changes a domain function inside a pinned tail, and neither is a message, so both notes stay true. Story 6 moves one seam call out of its tail, and the `~clock.now` citation is the declaration of exactly that. `unblock-node` is 123 lines and its whole trace is drawn.

## Dispatch order

Story 1 is independent — one new read on the plan store.

Story 8 registers the error code on five operations and must land before Stories 2 to 6, all of which throw it.

Stories 2, 3, 4, 5 and 6 depend on Stories 1 and 8, and are independent of each other. They can run concurrently, one command each.

Story 7 depends on Story 3, which removes the other reader of `facts.lease` in the same command.

Story 9 depends on every prior story.

A workable serial order: **1 → 8 → 2 → 3 → 4 → 5 → 6 → 7 → 9**. No story in it depends on a later
one: Story 1 and Story 8 read nothing of this epic, Stories 2 to 6 read both of them, Story 7 reads
Story 3 and Story 6, and Story 9 reads all eight.

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

- **`leaseHeld` is private.** `src/services/plan/sqlite.ts:564`, called only at `:278` and `:308`. No command calls it, so no command's seam trace changes when it dies.
- **One command names the lease.** `grep -n "lease" src/commands/node/*.ts src/commands/plan/import-plan.ts` returns exactly `src/commands/node/update-node.ts:189`. `create-node.ts` and `unblock-node.ts` hold no guard, so Stories 2 and 5 **add** a refusal rather than replacing one.
- **`containmentMovable` is the second reader, and it has three callers.** `src/domain/plan-containment.ts:9` tests `!facts.lease`, and it is reached from `src/commands/node/update-node.ts:178`, `src/commands/plan/import-plan.ts:320` and `src/queries/plan/validate-plan.ts:230`. It is a domain function, so it is invisible at the seam and Story 7 draws nothing.
- **`delete-node`'s guard is a third path.** `readSubtreeExecutionFacts` at `sqlite.ts:351-356` carries a `lease` member in the closed `executionBlockers` list, and `src/commands/node/delete-node.ts:105` refuses `binding-in-use` on any member. That list already carries a `run` member at `:361-364`, matching any run row rather than an active one, so `delete-node` refuses `binding-in-use` for an expired and an ended run where the other four admit the write. EPIC 050.5 Story 5 owns the list; this epic leaves both members and Story 4 asserts the consequence.
- **No plan operation declares `lease-held`.** `grep -rn '"lease-held"' src/http/contract/` binds it to `node.claim`, `node.heartbeat`, `node.release` and `node.report`. Story 8 therefore adds and removes nothing.
- **`delete-node` reads the clock late.** `:75`, after two plan reads — the only one of the five that does not read it first. Its baseline draws that order.
- **`import-plan` reads the clock at `:395`, inside the tail.** Story 6 moves it to just after the idempotency replay so the guard has a `now`, and the move carries `~clock.now` with a citation rather than `+`. It is the one seam call that leaves a pinned tail in this epic.
- **`import-plan` cannot seed its guard before `:195`.** The ids it deletes are the project's nodes no submitted document names, and that set needs `storedNodes` from the graph read. Its guard therefore sits after that read and before the first write at `:413`, and its diagram draws the ordinal.
- **`create-node` writes before it reads the graph.** `blobs.put` at `:116` and `:122` precede `plan.readGraph` at `:128`. That is why `runCoversNode` expands the closure inside the store: a command-side ancestor walk would need the graph read, and placing the guard after it would refuse after two blob writes.
- **Two drawn methods carry a label the harness dictates.** EPIC 050.1 Story 6 (06-the-conformance-harness) projects `events.append` by `input.type` then `input.subjectId`, and `plan.setNodeState` by `input.id` then `input.trigger`. Both methods appear only in `unblock-node`, so its two diagrams draw `events.append:node.unblocked:T` and `plan.setNodeState:T:manual-unblock`. Every other method these diagrams draw carries no projection, and each appears once per diagram, which is what the standard admits.
- **`SubtreeExclusionRefusal.expiresAt` is `number | null`** at `src/domain/run-exclusion.ts:21 — `expiresAt``, and `isLive` treats a null as live at `src/domain/run-exclusion.ts:43 — `run.expiresAt === null``. SQL answers the other way for `expires_at > ?`. Migration `12` declares the column `NOT NULL`, so the one divergent row cannot be seeded, and Story 1 states the constraint on its case-18 fixture rather than leaving it to be found.

## Decisions the source check forced

- **The seed is what the command names; the closure is what the store computes.** Five commands pass between one id and a whole document set, and none of them holds an ancestor list at the point the guard must fire.
- **The closure is symmetric, and the direction is not a per-command mode.** A run above a seed covers it and a run below it covers it, in all five commands. The consequences are stated: a run on an existing child refuses a `create-node` under that parent, and a run on a descendant refuses an `update-node` of an objective. A mode argument whose two values no test could tell apart from a bug is not worth the parameter.
- **`relation` has a precedence, and it decides before the byte order does.** `self` beats `ancestor` beats `descendant`, evaluated over the seed set as a whole, and the bytewise tie-break then picks the row inside the winning class. That is the order `subtreeExclusion` evaluates at `src/domain/run-exclusion.ts:88-105`; a read that ordered by node id across the classes would answer `ancestor` where the shipped rule answers `self`. Story 1 asserts the two agree.
- **The pair draws the path that still succeeds.** Each guarded command's diagram uses a fixture with no active run, because that is the path whose seam order changed. Drawing the refusal would give the story a second live diagram. The refusal is proven by its own case and by the byte-identical comparison, and each story names which.
- **The guard is the last refusal in `unblock-node` and an early one everywhere else.** In each command it follows the refusals decided from a row already read and precedes the first write. The drawn ordinal is the contract, the byte-identical assertion is the proof of what a refusal wrote, and each story's decision table is the proof of which refusal wins.
- **One shipped behaviour is relaxed, in three call sites.** A node holding a live node lease and no run was refused a containment move and is now admitted. `containmentMovable` has three callers — `src/commands/node/update-node.ts:178`, `src/commands/plan/import-plan.ts:320` and `src/queries/plan/validate-plan.ts:230` — so the one-line change relaxes all three, and the third is the `plan.validate` report. The lease is written only by a claim, and from EPIC 050.1 a claim writes a run in the same transaction, so the two disagree only for a row left by a crash, which no command writes after EPIC 050.4. Story 3 asserts the update case and Story 7 asserts the import case and the query case, so it is a decision and not a regression.
- **`ContainmentFacts.lease` survives unread for two epics.** Deleting the field belongs with `leaseHeld`, the private method that computes it, and that is EPIC 050.5 Story 5. Story 7 asserts no production file reads it, which is what makes the interval safe.

## What this epic is not

It is **not** invisible to a document reader. Five operations gain a declared error, so every emitted
OpenAPI document changes. That change is adding a member to an enum, which `docs/proposal/api/README.md:96`
permits inside `/v1` at `:96` and which a client must tolerate by the same document, so the version moves by
patch and no capability is retired. The epic says so in those terms rather than claiming to be
wire-invisible, which it is not.
