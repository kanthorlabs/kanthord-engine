# EPIC 016 — Readiness applied — stories

Epic: `.agent/plan/epics/016-readiness-applied.md`
Prereq: EPIC 015 (sequence order). EPIC 014 declares `src/domain/node-trigger.ts`, `NodeTriggerId` and both trigger tables, and flips the `ready → pending` matrix cell. EPIC 015 adds the `secret` capability and moves event attribution to the resolved actor.

`plan.import` leaves a project with a `ready` frontier, every node state write goes through one store method that names a required trigger, and each derived transition carries one event attributed to the daemon instance.

## Dispatch order

`npm run verify` is green at the end of each **numbered step** below, not after each file. Two steps are multi-file units, and no intermediate state of a unit typechecks.

1. `01-proposal-amendment.md`
2. `02-derive-readiness.md`
3. `03-services-readiness.md` + `09-the-event.md` — **one coupled pair** over `src/services/readiness/dependency.ts`. Story 03 alone ships a capability whose event fields are unpinned.
4. `12-journey-oracle-repaired.md` — the harness repair. It is self-contained: `runJourney` is driven in unit tests by a fake CLI returning canned stdout (`scripts/e2e/lib/scenario/journey.test.ts:49-51`), so it depends on no production change. Landing it here removes any window in which the oracle disagrees with the daemon.
5. **The atomic unit: `04` + `05` + `07` + `08` + `10`.** Run all five before `npm run verify`. They cannot be split:
   - `04` deletes `upsertNode`, `insertEdge` and `deleteEdge` from `PlanStore`, which `src/commands/plan/import-plan.ts:418,452,464` still calls until `07`.
   - `04` gives `SqlitePlanStore` a required constructor, which breaks `src/main.ts:163` until `10`.
   - `08` adds `plan` to `RecoverExpiredLeasesDependencies`, which `src/main.ts:191-195` must supply, and `10` is what reorders construction so `plan` is in scope there.
   - `05` is the guard set inside the `setNodeState` that `04` creates.
     A partial unit fails `npm run typecheck`, and `npm test` is a bare `node --test` that collects every affected suite. Do not attempt a green gate inside the unit.
6. `06-eslint-rule.md` — **after the atomic unit.** `src/commands/startup/recover-expired-leases.ts:147` holds a literal the rule forbids until Story 08 lands, so an earlier run fails `npm run lint`.
7. `11-application-fixture.md`

An additive alternative exists — keep `upsertNode`, `insertEdge` and `deleteEdge` beside the new methods, migrate each caller, then delete them in a final story. It buys a green gate per file at the cost of one extra story and a window in which the mutation boundary is bypassable. The atomic unit is chosen instead, because the boundary this epic exists to create is either closed or it is not.

## Stories

- 1 — `state-machine.md` and `transition.ts` lose the scheduler on six lines, line 19 gains the readiness demotion as a writer of `pending`, and line 120 keeps the phase-2 scheduler → `01-proposal-amendment.md`
- 2 — `deriveReadiness` in `src/domain/readiness.ts`, pure, ordered bytewise, trigger-stamped → `02-derive-readiness.md`
- 3 — the `readiness` capability: `Readiness.apply` and `DependencyReadiness` → `03-services-readiness.md`
- 4 — `PlanStore` loses three writes and gains `mutateGraph` and `setNodeState` → `04-closed-mutation-api.md`
- 5 — `setNodeState` checks the declaration, the level and the matrix → `05-set-node-state-validation.md`
- 6 — `no-restricted-syntax` closes every node and edge write outside the plan store, over an enumerated exemption list → `06-eslint-rule.md`
- 7 — `plan.import` replaces three loops with one `mutateGraph` call → `07-import-plan-mutation.md`
- 8 — `recover-expired-leases` writes through `setNodeState` under two triggers → `08-recover-expired-leases-mutation.md`
- 9 — `node.ready` and `node.pending`, attributed to the daemon instance → `09-the-event.md`
- 10 — `main.ts` hoists `instanceId` and inverts the plan-store construction order → `10-composition.md`
- 11 — `src/main.readiness.test.ts` drives the real daemon over one migrated database → `11-application-fixture.md`
- 12 — the journey oracle asserts a task-state map in place of `tasksAllPending` → `12-journey-oracle-repaired.md`

## Facts (needed for implementation)

### Greenfield gaps

- `src/domain/node-trigger.ts` does **not** exist in the tree. EPIC 014 Story 13 creates it with `internalTriggerIds` (fifteen ids), `internalTransitions`, `NodeTriggerId` and `triggerTransition`. `grep -rn "NodeTriggerId\|setNodeState\|mutateGraph" src/` returns nothing today.
- `src/domain/readiness.ts:12` defines `isReady(dependencies: readonly Dependency[])` where `Dependency = { state: NodeState; waived: boolean }` (`:3-6`). **No production file imports it.** `satisfiesDependency` at `:8` counts `done` and `partial` only.
- `waivedAt` never reaches `isReady`. It lives on `StoredEdge` at `src/domain/plan-graph.ts:25` as `number | null`, and no production file collapses it into `Dependency.waived`. Story 2 is the first.
- `src/services/readiness/` does not exist. `src/services/` holds fourteen capabilities plus `home-lock` today (`src/domain/layout.test.ts:108-123`, fifteen array entries). EPIC 015 Story 2 adds `secret` → fifteen capabilities, sixteen entries. Story 3 adds `readiness` → **sixteen capabilities, seventeen entries**, and the `it(...)` title at `src/domain/layout.test.ts:101` becomes `sixteen`. `.agent/plan/epics/016-readiness-applied.md:48` and `:105` say fifteen; that count predates EPIC 015.
- `eslint.config.js` holds **no** `no-restricted-syntax` block. Every ban today is `no-restricted-imports` per glob.
- No declared union of event `type` values exists anywhere. `AppendEventInput.type` is a bare `string` at `src/services/event/index.ts:8`. `node.ready` and `node.pending` appear in no file.

### Gotchas

- `SqlitePlanStore` has **no constructor** today (`src/services/plan/sqlite.ts:115`) and twenty call sites construct it through `createPlanStore()` at `test/helpers/plan.ts:13-15`. Story 4 keeps that helper callable with no argument by defaulting to a discarding readiness, so only the five import-driving test sites change.
- `src/services/plan/sqlite.test.ts:537-554` scans the module source from the **first** `ON CONFLICT` to the next quote and asserts the slice names none of `state`, `block_reason` or `discard_reason`. Declare the two new `UPDATE node` constants above `INSERT_NODE`.
- `INSERT_NODE` at `src/services/plan/sqlite.ts:25-28` hardcodes `'pending'` and omits `state`, `block_reason` and `discard_reason` from its `ON CONFLICT(id) DO UPDATE SET` list. It stays byte for byte: an insert must place a node in the table before its edges exist.
- `Storage.transact` refuses a nested transaction (`src/services/storage/sqlite.ts:36`, `assertIdle()`). `mutateGraph`, `setNodeState` and `Readiness.apply` all take the caller's `Transaction` and open none.
- `Transaction.run` returns `void` (`src/services/storage/index.ts:2`), so no row count is available. `setNodeState` reads the node **before** the update to decide the no-op, and keeps the `AND state = ?` guard as the concurrency defence.
- An edge points from the dependent to the dependency: `src/commands/plan/import-plan.ts:444-447` sets `fromNode: node.id` and `toNode: dependency`.
- `flat config resolves one rule name by last-wins per file`, per the notes at `eslint.config.js:204-207` and `:384-387`. `no-restricted-syntax` must appear in exactly one block.
- Fourteen test files under `src/` seed `node` or `edge` rows with raw SQL and must be named in the Story 6 exemption list, or `npm run lint` fails on all fourteen. The list command that finds them is in Story 6.
- `docs/proposal/phase-1/state-machine.md` names the scheduler on seven lines: 11, 19, 27, 63, 85, 86 and 120. Story 1 amends six and leaves 120, which is phase-2 content and names the scheduler that `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md` builds. Line 19 also claims import and `unblock` are the only writers of `pending`, which EPIC 014's `ready → pending` flip makes false; Story 1 adds the readiness demotion as the third writer.
- `kanthord status` prints **five** fields — `kanthord: node <kind> <state> <blockReason|-> <count>` (`src/cli/status.ts:30`). The `parseStatusCounts` regex at `scripts/e2e/lib/scenario/journey.ts:72` has four groups and never reads `match[3]`.
- The two-objective e2e fixture (`test/e2e/fixtures/two-objective/plan/`) holds one initiative, two objectives and four tasks. **No objective carries `depends_on`**, and exactly two tasks do. The frontier is therefore two `pending` tasks, two `ready` tasks, and both objectives `ready`.
- `launchDaemon` (`test/helpers/daemon.ts:29`) passes **no parent environment**, returns no base url and no port, and waits on the literal stdout `"kanthord: ready\n"`. The caller reserves the port and writes it into the config itself (`src/main.test.ts:155-158`).
- `publishIdentity` writes `<home>/daemon.lock.identity` as pretty JSON with `instanceId` (`src/services/home-lock/sqlite.ts:141-150`, `src/services/home-lock/identity.ts:3-12`). Story 11 reads `instanceId` from that file.
- `seedRegistry` (`test/helpers/rows.ts:21-77`) writes `project_a`, a provider, a repository **named `kanthord-verify`** and the project binding. Story 11 seeds it into the migrated database over `node:sqlite` before the daemon starts, so no git remote is needed.
- `plan.validate` returns `documentsHash` and `revision` (`src/queries/plan/validate-plan.ts:57-58`). Story 11 feeds both into `plan.import`.
- `docs/proposal/phase-1/plan-format.md:21,27` require an `## Acceptance criteria` heading on a task, `repo` on every objective, and no `repo` on a task.
- `src/domain/transition.ts` holds no `allowedPairs` symbol. The matrix is `transitions` (56 rows) plus a private `lookup` Map, read through `canTransition` at `:468`. `allowedPairs` lives in `src/domain/transition.test.ts:9-52`.
- **`setNodeState` applies readiness after its own write, so the stored state is not always the declared `to`.** A node written to `ready` with an unsatisfied dependency is demoted straight back to `pending`, and a node written to `pending` with no unsatisfied dependency is promoted straight back to `ready`. Any test that seeds a subject and asserts the declared `to` must pin the subject's dependencies first. Story 5 states the rule per `to` value.
- **Seeded parent nodes are readiness subjects too.** An `initiative` or `objective` parent left in `pending` is promoted by the first write that runs readiness, which appends an extra `node.ready` event. Seed every parent in `done`; a `done` node is never a subject.
- `src/http/contract/cursor.ts:5` defaults `event.list` `limit` to `100` and caps it at `500`.
- `ImportPlanDependencies` at `src/commands/plan/import-plan.ts:35-44` holds **no `git` member**. Import resolves `repo` to a repository id through a table read at `:120-127` and touches no remote, so a seeded `repository` row is a complete registration for a test.
- `tsconfig.json` `include` covers `src/**/*.ts`, `test/**/*.ts` and `scripts/**/*.ts`, so `npm run typecheck` compiles every test file and an `@ts-expect-error` fixture in a test is enforced by the gate.

### Decisions this planner pinned, which the EPIC left open

- **D1.** `ReadinessInput` carries **no** `instanceId`. `DependencyReadiness` takes it at construction. The EPIC names it on the input at `:48` and on the constructor at `:55`; the constructor wins, because `SqlitePlanStore` calls `apply` and holds no identity, and because an input member lets any caller spoof event attribution. **The EPIC needs a one-line amendment at `:48`;** this is an interface-contract change, not an execution detail.
- **D2.** `setNodeState` throws a plain `Error` with three message templates, and Story 5 pins four exact rendered messages M1-M4. `src/services/plan/index.ts` declares no error class, and `src/commands/startup/recover-expired-leases.ts:143` already throws a plain `Error` for the same premise. No HTTP refusal maps to it.
- **D3.** The Story 6 rule exempts an **enumerated fifteen-path list** — `src/services/plan/sqlite.ts` plus the fourteen legacy test files that seed `node` or `edge` rows with raw SQL — and **not** a `src/**/*.test.ts` glob. A glob would exempt every test file that will ever exist and stop the rule being a mechanism. The list makes each exemption a visible decision, and a new test that seeds a row with raw SQL fails `npm run lint` and reaches for `test/helpers/rows.ts` instead. A `lintCase` proves a new `.test.ts` path is still covered, and a source test pins the list at fifteen exact paths with no `*`.
- **D4.** The guard order inside `setNodeState` is **matrix, then declaration, then level**. Placing the matrix check first makes `canTransition` a reachable, observable branch: `pending → running` throws the matrix message, which is what `.agent/plan/epics/016-readiness-applied.md:98` requires. The reverse order makes the branch dead code, because `src/domain/node-trigger.test.ts` asserts every row of both tables names a legal cell — and a dead branch can only be "proved" by a source scan, which proves nothing about execution. Each of the three negative cases therefore uses a pair that passes every earlier guard.
- **D5.** Type-level facts are proved with `@ts-expect-error` fixtures compiled by `npm run typecheck`, never by slicing source text. That covers `trigger` being required on `SetNodeStateInput` and absent from `MutateGraphInput`.
