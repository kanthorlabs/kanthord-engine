# Story 8 — Run the single-harness loop: P1B-E1

Epic: `.agent/plan/epics/021-external-drive-acceptance-run.md`
Depends on: Story 6, for the third position in the order.

This is the EPIC bullet at `021-external-drive-acceptance-run.md:135`. The `local` driver and the `fixture` profile.

## The five tasks

### setup

Prove the **base** prerequisites only: the pinned `git` binary answers, and the artifact is built from the commit under test. This scenario needs no container and no forge.

### seed

The **three-objective** fixture at `test/e2e/fixtures/three-objective/`. The scenario declaration takes the `three-objective` plan axis and asserts that `gamma` reads `pending`. The runner seeds it; supply nothing by hand. Story 3 proves the fixture exists.

### run

```sh
node scripts/e2e/run.mjs P1B-E1 --tag "$TAG"
```

Invoke nothing else.

### cleanup

Confirm no temporary home, no daemon process and no held home lock survive, on the failure path as well as the success path.

### record

Append one row to the manifest `scenarios` array in the third position, with `id: "P1B-E1"`, its `bundlePath`, its `sha256` and its `outcome`.

## Constraints

- Assert nothing of your own. `020-wiring-and-scenarios.md:83` owns the oracle of this scenario, and it asserts every state by node identity.
- Do not run this scenario before `P1-E1` and `P1-E2`. It shares the `local` driver with them, and a broken harness loop must be found before the first container is built.
- Repair no defect found here.
- Do not merge, edit or move the bundle.

## Verify

- `.data/acceptance-<tag>/P1B-E1/bundle.json` exists, and its `tag` field equals the run tag and its `scenarioId` field equals `P1B-E1`.
- The bundle names the commit under test.
- On a green run the bundle reports `outcome: "passed"`.
- A failure does not stop `P1-E4`, and the bundle is still written.
- Proof: line `204` of the run block at `021-external-drive-acceptance-run.md:200-218`.
