# Story 17 — The claim reuses an active run of its own driver

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: EPIC 018 (`claim-node.ts`), Story 7 (the first fixture that leaves an active run with a free lease).

This epic creates the first case where a task run is active and its task lease is free: a rejected, a failed or a cancelled report under the limit keeps both runs active and frees the task lease alone, so the task lease row carries a null owner while the objective lease row still names the reporting actor.

## Change

### `src/commands/node/claim-node.ts` of `018-claim-and-lease.md:85`

- **Step 5**, the objective run: branch on whether `execution.activeRunOfNode(transaction, objectiveId)` returns a run, and not on whether the objective lease was newly acquired. A run exists: call `execution.adoptRun` with the new fence. No run: open one.
- **Step 6**, the task run: apply the same branch for the task node.
- **Before either adoption**, compare the driver. When the returned run's `driver` is not the driver of the claim, throw the claim command's `run-driver-mismatch` refusal with `details: { runDriver: run.driver, claimDriver }`, and **adopt nothing**. An external attempt under an internal run breaks the composite driver foreign key of `018-claim-and-lease.md:57`. The handler maps that refusal to `409 illegal-transition` with the `run-driver` branch of `illegalTransitionDetails`.
- **This refusal is defence in depth, and no route reaches it.** `runDriversUnderObjective` at `src/services/execution/sqlite.ts:261` selects the objective's runs and its tasks' runs, active and ended alike, so the drive-mode pin of EPIC 018 refuses every foreign-driver run before the adoption runs. The guard ships because a command with no guard on a foreign-driver adoption depends on a caller two steps away. `closeObjective` keeps its `driver = 'external'` assertion for the same reason, per `019-outcome-report.md:32`.
- `openAttempt` then mints the next number over the surviving attempt rows, which is what makes the attempt limit reachable across two claims and across a daemon restart.

## Constraints

- Add no method. `activeRunOfNode` and `adoptRun` already ship from `018-claim-and-lease.md:83`, and `run_one_active` at `src/services/storage/migration-0003-execution-and-journal.ts:46` refuses a second active run.
- Do not use `objectiveDrivePin` here unless the claim already calls it. The refusal above is a single-run driver comparison; the pin over run history stays where EPIC 018 put it. **Do not narrow the pin input either.** A filter that hides the active run from `runDriversUnderObjective` moves the active-run case from `drive-mode-pinned` to this refusal, which redefines an EPIC 018 guard from inside this epic.
- Change no other step of `claimNode`, and change no response field.
- The refusal writes nothing: it throws before the first write of the claim.

## Verify

Edit `src/commands/node/claim-node.test.ts`, keeping every existing case.

- `it("a second claim after a rejected report adopts the same run", ...)` — report `rejected` under the limit with the same actor, claim again, and assert the run id is equal across the two claims, the minted attempt number is `2`, and the task fence is new. Assert the run id by identity.
- `it("a second claim after a cancelled report and after a failed report adopts the same run", ...)` — two cases.
- `it("a second actor cannot claim a task whose objective lease is held", ...)` — `409 lease-held`, because the objective lease still names the first actor.
- `it("the same actor claims a sibling task under the held objective lease", ...)` — the claim answers, and the objective run id is the same run id.
- `it("a claim over an active run of another driver is drive-mode-pinned and adopts nothing", ...)` — write an internal active run under the objective directly in the database, claim as a harness, and assert `drive-mode-pinned`, no `adoptRun` call, and a byte-identical database before and after. The pin owns this case; the `run-driver-mismatch` refusal is unreachable from a route and is covered at the handler in `src/http/server/node/claim-node.test.ts`.
- `it("the active run survives a restart and adoption is the only recovery", ...)` — covered end to end in Story 20; here assert the unit-level part: with the run active and the task lease free, a claim adopts rather than opens, proved by the run row count staying at one.
- `node --test src/commands/node/claim-node.test.ts src/commands/node/release-node.test.ts src/commands/node/heartbeat-node.test.ts` exits 0.
- Re-run every hermetic assertion of `018-claim-and-lease.md:169-215`: `node --test src/commands/node/*.test.ts src/http/server/node/*.test.ts src/main.claim.test.ts` exits 0. The claim-side run reuse is the regression risk of this epic.
- `npm run verify` exits 0.
- Proof: `src/commands/node/claim-node.test.ts`. Hermetic coverage: `019-outcome-report.md:140` (the re-claim half), `:172` and `:181`.
