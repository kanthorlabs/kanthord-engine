# Story 7 — Run the amended phase-1 axis: P1-E1, P1-E2, P1-E4 and P1-E5

Epic: `.agent/plan/epics/025-external-drive-acceptance-run.md`
Depends on: Story 6, for the position of each of the four invocations.

This is the EPIC bullet at `025-external-drive-acceptance-run.md:133`. It is the regression evidence that the block preserved transport, packaging, import, export and real-forge compatibility. It runs the journey **EPIC 016 amended**, and it repairs nothing.

## The five tasks

### setup

- Prove the **base** prerequisites: the pinned `git` binary answers, and the artifact is built from the commit under test.
- Before `P1-E4`, prove the **container** prerequisite: Podman is reachable at the pinned version, and no image pull is needed.
- Before `P1-E5`, prove the **forge** prerequisite: `.env.e2e` is complete, and the throwaway repository and its credential are valid.
- An unmet container prerequisite reports `unavailable` for `P1-E4` and does not stop `P1-E5`. An unmet forge prerequisite reports `unavailable` for `P1-E5` alone.

### seed

- `P1-E1`, `P1-E2` and `P1-E4` take the **two-objective** fixture at `test/e2e/fixtures/two-objective/`. The runner seeds it; supply nothing by hand.
- `P1-E5` takes a **hand-authored plan against the real repository**, because the fixture object ids and the fixture default branch do not transfer.

### run

Invoke each, in the position Story 6 gives it, and nothing else:

```sh
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"
node scripts/e2e/run.mjs P1-E5 --tag "$TAG"
```

### cleanup

Confirm, after each line and on the failure path as well as the success path:

- no temporary home survives;
- no daemon process survives;
- no home lock is held;
- no container, pod, network or volume carries the run id label of that invocation.

### record

Write positions 1, 2, 4 and 7 of the manifest `scenarios` array — `P1-E1`, `P1-E2`, `P1-E4` and `P1-E5` — one row per id with `bundlePath`, `sha256` and `outcome`, leaving positions 3, 5 and 6 for Stories 8, 9 and 10. The finished array matches `declaredScenarioOrder` at `scripts/e2e/lib/record/manifest.ts:17-25`. Append to the report the repository name and the detected default branch that the `P1-E5` bundle observed.

## Constraints

- **The oracle is the amended one.** `scripts/e2e/lib/scenario/journey.ts:388-399` asserted `tasksAllPending: true`, and EPIC 016 amends it to the derived ready frontier. `runJourney` is called by `p1-e1.ts:10`, `p1-e4.ts:225` and `p1-e5.ts:149`, so all three depend on that repair. **Re-running the old oracle guarantees failure and proves no compatibility.** Story 3 proves the repair landed.
- Assert nothing of your own. EPIC 020 and phase 1 own every oracle. A gap is a finding about the oracle.
- Repair no defect. A failure on this axis is a **phase-1 regression** and a blocker against the block epic that caused it, per `025-external-drive-acceptance-run.md:133`.
- Do not merge, edit or move a bundle.

## Verify

- Each of the four lines writes `.data/acceptance-<tag>/<id>/bundle.json`, and each bundle names the commit under test in its `commit` field.
- Each bundle names its own id in `scenarioId` and the run tag in `tag`. `Bundle` carries both at `scripts/e2e/lib/bundle.ts:39-60`, and `--check-manifest` of Story 2 asserts them.
- On a green axis each of the four bundles reports `outcome: "passed"`.
- A failing line does not stop the next line, and it still writes a bundle.
- Proof: lines `202`, `203`, `205` and `208` of the run block at `025-external-drive-acceptance-run.md:200-218`.
