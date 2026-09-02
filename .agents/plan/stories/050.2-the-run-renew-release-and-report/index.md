# EPIC 050.2 — The run renew, release and report — stories

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Prereq: EPIC 050 and EPIC 050.1, both implemented. EPIC 050 states the run row and the exclusion rules; EPIC 050.1 lands migration `12`, opens the run at the claim and creates the expiry pass.

A fence guards every write after the claim. This epic rewrites `node.renew`, `node.release` and the prelude of `node.report`, and it carries the wire announcement of the whole worker protocol.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the ship diagram. A story that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 enforces it.

Four stories carry a diagram: 3, 4, 5 and 6. The other five carry none.

## Dispatch order

Story 1 is independent — a greenfield pure function.

Story 2 depends on EPIC 050 Story 2 (`runRow`) and on EPIC 050.1 Story 3, which rewrites `openRun` and lands the `RunRecord` shape `runById` returns.

Story 7 is a wide fan-out across the contract and must land before Stories 3 to 6, all of which need its request fields and its event types.

Story 3 depends on Stories 1, 2 and 7. Story 4 depends on Story 3. Stories 5 and 6 depend on Stories 1, 2 and 7 and are independent of each other.

Story 8 depends on Story 7. Story 9 depends on Stories 1 to 8.

A workable serial order: **1 → 2 → 7 → 3 → 4 → 5 → 6 → 8 → 9**.

## Stories

- 1 — Run authority → `01-run-authority.md`
- 2 — The authority seams → `02-the-authority-seams.md`
- 3 — The renew → `03-the-renew.md` — draws `baseline-renew-task` and `renew-success`
- 4 — The lifetime refusal → `04-the-lifetime-refusal.md` — draws `renew-refusal-lifetime-exceeded`
- 5 — The release → `05-the-release.md` — draws `baseline-release-task` and `release-success`
- 6 — The report prelude → `06-the-report-prelude.md` — draws `baseline-report-prelude` and `report-authority-prelude`
- 7 — The worker contract → `07-the-worker-contract.md`
- 8 — The policy amendment and the capability swap → `08-the-policy-amendment-and-the-capability-swap.md`
- 9 — The proposal records the authority model → `09-the-proposal-records-the-authority-model.md`

## Decisions the baseline comparison forced

Drawing each shipped path before drawing its replacement produced three corrections. The EPIC carries them.

- **A renew renews the run and every lease that run holds.** `heartbeat-node.ts:82` renews the objective lease beside the node lease. A run on `runTtlMs` that outlived an objective lease on `leaseTtlMs` would free a node that another claim then takes, under a run that still holds authority. The three lease steps stay until EPIC 050.4, which removes them and changes no wire shape.
- **A release returns the node to `ready` and cancels the open attempt.** `release-node.ts:166-179` does both. Ending the run alone would leave the node `running` under no run, which no claim can take and no report can close.
- **The release reads the attempts once.** `release-node.ts:101` and `:114` call `attemptsOfRun` twice with one argument, which is two steps of one token and one wasted read.

## Where the wire lands

EPIC 050.1 changed `node.claim` while still declaring `external-drive`, because a capability name announces a finished shape and the claim is half of one. No build is published between the two epics, so no client observes a half-changed protocol. Story 8 retires `external-drive`, declares `worker-model` and moves `KANTHORD_VERSION` to `28.0.0`, once, for both epics. EPIC 050.4 changes no wire shape.

## Facts

The Facts section of `.agents/plan/stories/050-the-run-the-fence-and-exclusion/index.md` covers the prerequisite epics, the storage layer, the command conventions, the contract fan-out and the config template. Every fact there holds here. Two additions:

- `src/commands/node/heartbeat-node.ts` is 208 lines and holds the objective lease renewal at `:82-91` and `:145-184`. Story 3 moves the file and keeps that block.
- `src/commands/node/release-node.ts` holds two branches: the exhausted branch at `:123-165`, which blocks the node and already ends the run, and the ordinary branch at `:166-201`, which ends no run. Story 5 adds `execution.endRun` to the second and changes the first only where the event type moves.
