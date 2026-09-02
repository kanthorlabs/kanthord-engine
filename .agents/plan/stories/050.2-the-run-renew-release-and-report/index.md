# EPIC 050.2 — The run renew, release and report — stories

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Prereq: EPIC 050 and EPIC 050.1, both implemented. EPIC 050 states the run row and the exclusion rules; EPIC 050.1 Story 2 (`02-the-expiry-pass`) creates the expiry pass, EPIC 050.1 Story 3 (`03-the-claim-of-a-task`) lands migration `12` and opens the run at the claim, and EPIC 050.1 Story 6 (`06-the-conformance-harness`) through Story 8 (`08-the-range-gate`) land the sequence harness, its runner and the range gate.

A fence guards every write after the claim. This epic rewrites `node.renew`, `node.release` and the
prelude of `node.report`, and it carries the wire announcement of the whole worker protocol.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the
ship diagram. A story that changes no path draws nothing. `.agents/plan/authoring.md` is the grammar,
and `scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 (`08-the-range-gate`) enforces it.

Four stories carry a diagram: 3, 4, 5 and 6. Five carry none. Story 4
(`04-the-lifetime-refusal`) draws a refusal against the baseline Story 3 (`03-the-renew`) draws, so
the epic holds four live diagrams and three baselines.

**This epic holds no `00-groundwork.md`.** It edits no path `scripts/lane-check.sh` denies to both
engineers: Story 8 (`08-the-policy-amendment-and-the-capability-swap`) section 7 records the human
ruling that this epic bumps no version, so `package.json` is untouched, and
`.agents/plan/authoring.md:117` forbids manufacturing an empty groundwork story.

## Dispatch order

Story 1 (`01-run-authority`) is independent — a greenfield pure function. `src/domain/run-authority.ts`
exists nowhere today.

Story 2 (`02-the-authority-seams`) depends on EPIC 050 Story 2 (`02-the-run-row`) for `runRow` and on
EPIC 050.1 Story 3 (`03-the-claim-of-a-task`), which rewrites `openRun` and lands the `RunRecord`
shape `runById` returns. `RunRecord` today holds `leaseFence` and no `fence`, `expiresAt`, `worker` or
`maxLifetimeAt`, and the `run` table has no such columns.

Story 7 (`07-the-worker-contract`) is a wide fan-out across the contract and must land before Stories
3 to 6, all of which need its `runId` and `runFence` request fields.

Story 3 (`03-the-renew`) depends on Stories 1, 2 and 7. Story 4 (`04-the-lifetime-refusal`) depends on
Story 3. Stories 5 (`05-the-release`) and 6 (`06-the-report-prelude`) depend on Stories 1, 2 and 7 and
are independent of each other.

Story 8 (`08-the-policy-amendment-and-the-capability-swap`) depends on Story 7. Story 9
(`09-the-proposal-records-the-authority-model`) depends on Stories 1 to 8.

A workable serial order: **1 → 2 → 7 → 3 → 4 → 5 → 6 → 8 → 9**. No story in it depends on a later one.

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

## Decisions taken during authoring, and now recorded in the EPIC

Four questions the diagrams exposed. A human ruled each one.

- **The node read precedes the authority check on all three operations.** `assertRunAuthority`
  condition 5 refuses `target-outside-run` for a target that is neither the run's node nor in its
  subtree, and an absent node and an initiative both satisfy it. With the node read after the
  authority check, `src/commands/node/release-node.ts:68` — `node-not-found`,
  `src/commands/node/release-node.ts:72` — `initiative-not-claimable`,
  `src/commands/node/heartbeat-node.ts:70` — `node-not-found`,
  `src/commands/node/heartbeat-node.ts:74` — `initiative-not-claimable` and
  `src/commands/outcome/report-outcome.ts:116` — `initiative-not-reportable` all become unreachable
  and two wire-visible codes change meaning. The four ship diagrams therefore read the node first,
  and each of Stories 3, 5 and 6 carries a pair of cases plus a `target-outside-run` control that
  proves the precedence. See `03-the-renew.md`, `05-the-release.md`, `06-the-report-prelude.md`.

- **Story 5 converts all three `lease.released` producers, the objective path included.** They are
  `src/commands/node/release-node.ts:154`, `:191` and `src/commands/node/release-node.ts:290` —
  `lease.released`, the third on the objective path Story 5 otherwise leaves alone. Leaving it would
  keep the type produced, so it could not leave `eventTypes`, and the epic's decision that no
  `lease.*` type remains would be false. Only the type and the payload change there; its reads stay
  for EPIC 050.4 Story 5 (`05-the-release-drops-the-lease`). See `05-the-release.md`.

- **The event types are registered by the stories that write their producers, not by Story 7.**
  `src/http/contract/event-payload.test.ts:344` — `it` asserts every produced type is declared and
  `src/http/contract/event-payload.test.ts:365` — `it` asserts every declared non-retired type has a
  producer, both by literal string scan over `src/commands` and `src/services`. Story 7 dispatches
  before all four command stories, so it would fail one scan in each direction. Story 3
  (`03-the-renew`) owns `run.renewed` and retires `lease.renewed`; Story 5 (`05-the-release`) owns
  `run.ended` and retires `lease.released`. See `03-the-renew.md`, `05-the-release.md`,
  `07-the-worker-contract.md` section 5.

- **This epic bumps no version.** `src/domain/version.ts:1` — `KANTHORD_VERSION` stays at `"27.8.1"`
  and `package.json:3` — `"version"` stays with it. `src/domain/version.test.ts:13` —
  `assert.equal` binds the two, and they sit in different lanes, so moving them costs a story slot
  for no wire signal — the capability list is what describes the wire. EPIC 050.4 Story 0
  (`00-groundwork`) moves the pair to `29.0.0` for the whole block. See
  `08-the-policy-amendment-and-the-capability-swap.md` section 7.

## Where the wire lands

EPIC 050.1 changed `node.claim` while still declaring `external-drive`, because a capability name
announces a finished shape and the claim is half of one. No build is published between the two epics,
so no client observes a half-changed protocol. Story 8
(`08-the-policy-amendment-and-the-capability-swap`) retires `external-drive` and declares
`worker-model`, once, for both epics. EPIC 050.4 changes no wire shape.

## Facts (needed for implementation)

The Facts section of `.agents/plan/stories/050-the-run-the-fence-and-exclusion/index.md` covers the
prerequisite epics, the storage layer, the command conventions, the contract fan-out and the config
template. Every fact there holds here. These are the additions this authoring verified:

- **Nothing EPIC 050.1 builds exists yet.** `src/domain/run-authority.ts`, `src/services/expiry/`,
  `expireRuns`, `execution.runById`, `execution.renewRun`, `src/commands/run/`, `test/sequence/`,
  `test/helpers/sequence-conformance.ts` and `scripts/verify-epic-sequence.ts` are all absent. The
  highest shipped migration is `src/services/storage/migration-0011-deliverable.ts:4` — `version`,
  so there is no migration `12`.
- **The run table carries no authority columns.** The effective DDL is
  `src/services/storage/migration-0007-external-execution.ts:12` — `CREATE TABLE run`, fourteen
  columns, holding `src/services/storage/migration-0007-external-execution.ts:20` — `lease_fence` and
  no `fence`, `expires_at` or `max_lifetime_at`. `src/domain/run.ts:13` — `runRow` already declares
  the post-migration shape, and `src/services/storage/schema-parity.test.ts:90` — `it`
  compares table names only, which is why the two can diverge without failing.
- **`src/commands/node/heartbeat-node.ts` is 208 lines**, and its trace order is not its file order:
  `src/commands/node/heartbeat-node.ts:117` — `renewLease` and
  `src/commands/node/heartbeat-node.ts:145` — `renewObjectiveLease` are declared after the command
  and invoked at `:81` and `:84`, above the `events.append` at `:93`. Story 3 (`03-the-renew`) moves
  the file and keeps that block.
- **`src/commands/node/release-node.ts` holds two task branches**: the exhausted branch at
  `src/commands/node/release-node.ts:123` — `projected.exhausted`, which blocks the node and already
  ends the run, and the ordinary branch from `src/commands/node/release-node.ts:166` — `closeAttempt`,
  which ends no run. Story 5 (`05-the-release`) adds `execution.endRun` to the second and changes the
  first only where the event type moves.
- **The two `attemptsOfRun` reads are at `src/commands/node/release-node.ts:101` — `attemptsOfRun`
  and `src/commands/node/release-node.ts:115` — `attemptsOfRun`.** Line `:114` holds
  `dependencies.execution` and not the method name. Story 5 collapses `:101` and `:115` into one read.
- **`releaseObjective`'s whole-graph read is at `src/commands/node/release-node.ts:211` —
  `readAllNodes`**, not `:210`, which holds `dependencies.plan`.
- **`no-active-run` survives.** `src/commands/node/release-node.ts:96` — `no-active-run` dies with the
  `activeRunOfNode` Story 5 removes, but
  `src/commands/node/release-node.ts:243` — `no-active-run` on the objective path still throws it, so
  the member and its HTTP mapping stay.
- **`lease-held` becomes unreachable on `node.report` and is not removed.** Story 6
  (`06-the-report-prelude`) deletes both throw sites,
  `src/commands/outcome/report-outcome.ts:187` — `lease-held` and
  `src/commands/outcome/report-outcome.ts:203` — `lease-held`, and no other site in the file throws
  it. EPIC 050.4 Story 8 (`08-lease-held-is-retired`) retires the code across the product.
- **`heartbeatIntervalMs` is triplicated with no shared constant**:
  `src/commands/node/heartbeat-node.ts:112`, `src/commands/node/claim-node.ts:356` and
  `src/commands/node/claim-node.ts:415`. It is not a config key; `src/services/config/index.ts:28` —
  `Settings` holds nine keys and none of them is it.
- **`acceptExecution` exists nowhere in `src/`.** EPIC 051 draws it at
  `.agents/plan/epics/051-the-execution-checkpoint.md:374` with `Caller->>Command`, so it is a nested
  command on another path and `report-execution-checkpoint` never owned the report tail.
- **No `PlanStore` method touches `node.assignment`.** The column is declared at
  `src/services/storage/migration-0011-deliverable.ts:26` — `assignment`, and `setNodeAssignment`
  exists nowhere. The epic's two assignment assertions read the raw row by SQL.
- **`eventTypes` holds 38 members**, at `src/domain/event-type.ts:1` — `eventTypes`, and
  `src/domain/event-type.ts:44` — `retiredEventTypes` is typed `readonly EventType[]`, so a removed
  member cannot be listed there at all. `src/http/contract/openapi.test.ts:416` — `equal` pins the
  count at 38; both event changes of this epic are replacements, so it does not move.
- **`"renew"` sorts to index 15 of `actionSegments`**, between
  `src/http/contract/path.ts:55` — `rename` and `src/http/contract/path.ts:56` — `report`:
  `"rename" < "renew"` at the fourth character and `"renew" < "report"` at the third. The array holds
  24 members and `src/http/contract/path.test.ts:40` — `equal` pins that count.
- **The registry holds 73 operations, 50 routed.** A rename changes neither, and
  `src/http/contract/registry.test.ts:50` — `equal` and `:64` pin both.
