# Story 3 — The EPIC 016 and EPIC 020 obligations, verified and not re-landed

Epic: `.agents/plan/epics/025-external-drive-acceptance-run.md`
Depends on: EPIC 016, EPIC 020.

**This story edits no file.** `025-external-drive-acceptance-run.md:177-183` names five obligations this epic places on other epics. Each one is owned there. This story proves all five before a run story spends six container image builds and one real-forge run against them.

## Change

None. Assert only.

## Verify

Run each check and record the result. A false fact stops the epic and is reported to the human. Repair nothing from here.

- `node --test scripts/e2e/lib/scenario/discipline.test.ts` exits 0, and the proposal-parity case finds exactly `P1-E1`, `P1-E2`, `P1-E4`, `P1-E5`, `P1B-E1`, `P1B-E2` and `P1B-E3`. This proves the EPIC 020 obligation at `025-external-drive-acceptance-run.md:181`. Today `docs/proposal/phase-1/README.md` declares four ids at lines 61, 80, 89 and 100, so this check fails until EPIC 020 lands.
- Read `scripts/e2e/lib/record/verdict.ts:20-25` and confirm `knownScenarioIds` holds all seven ids. This proves the obligation at `025-external-drive-acceptance-run.md:183`, and the seven-bundle rule depends on it.
- Read `scripts/e2e/lib/record/acceptance.ts:63-68` and confirm its own private `knownScenarioIds` list. **This is a second four-id list that `020-wiring-and-scenarios.md:77` does not name.** It gates only the "tag holds at least one bundle" check at `acceptance.ts:83-94`, so a stale list does not block a run in which any phase-1 bundle exists. Record its content as a finding of kind `S` if it still holds four ids. Do not edit it.
- Read `scripts/e2e/lib/tag.ts:6` and confirm `ScenarioId` admits the three `P1B-*` ids. Story 1 does not typecheck without it.
- Read `scripts/e2e/lib/scenario/journey.ts` around line 388 and confirm the `tasksAllPending` assertion is amended to the derived ready frontier. This proves the EPIC 016 obligation at `025-external-drive-acceptance-run.md:180`. Without it `P1-E1`, `P1-E4` and `P1-E5` each fail, per `025-external-drive-acceptance-run.md:66`.
- Confirm `test/e2e/fixtures/three-objective/` exists with `plan/journey/` holding `initiative.md`, `alpha/`, `beta/` and `gamma/`. Stories 8 and 9 seed it. Today `test/e2e/fixtures/` holds `real-two-objective` and `two-objective` only.
- Confirm `kanthord event list` is registered, by reading `src/cli/inventory.ts` for an `["event", "list"]` entry naming the single operation id `event.list`. Checklist rows 2 and 6 of Story 12 drive it.
- `node --test src/cli/reachability.test.ts src/http/contract/authorization.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: none of its own. This story is the precondition of the run block at `025-external-drive-acceptance-run.md:200-218`.
