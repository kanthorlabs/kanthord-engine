# Story 6 — The run order

Epic: `.agents/plan/epics/025-external-drive-acceptance-run.md`
Depends on: Story 5.

This is the EPIC bullet at `025-external-drive-acceptance-run.md:131`. It fixes the order of the seven invocations. **No run story restates it**, and Stories 7 to 10 name only their own position in it.

## Change

Run the seven scenarios under the one tag of Story 5, in this exact order, each on its own line, and **do not join them with `&&`**:

```sh
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"
node scripts/e2e/run.mjs P1B-E1 --tag "$TAG"
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"
node scripts/e2e/run.mjs P1B-E2 --tag "$TAG"
node scripts/e2e/run.mjs P1B-E3 --tag "$TAG"
node scripts/e2e/run.mjs P1-E5 --tag "$TAG"
```

The order is fixed by four reasons, and no invocation moves:

- `P1-E1` and `P1-E2` gate first, because Podman may be absent on an environment that must still gate.
- `P1B-E1` follows them on the same `local` driver, so a broken harness loop is found before a container is built.
- `P1-E4`, `P1B-E2` and `P1B-E3` run as one group, because they share the container prerequisite.
- `P1-E5` runs last, because it is the one `integration` scenario and it needs a quiet forge.

**The continuation policy.** A scenario that fails on the product records its outcome and the run continues to the next scenario. A run that stops at the first defect returns one finding and six unknowns. Record the exit status of each line and continue.

**The group policy.** A prerequisite failure stops its own group only, because the prerequisites are not shared.

| Group     | Prerequisite                                                    | Scenarios                   |
| --------- | --------------------------------------------------------------- | --------------------------- |
| base      | the pinned `git` binary, and the artifact built from the commit | all seven                   |
| container | Podman reachable at the pinned version, with no pull            | `P1-E4`, `P1B-E2`, `P1B-E3` |
| forge     | a complete `.env.e2e`, the throwaway repository and credential  | `P1-E5`                     |

An unmet group prerequisite reports `unavailable` for each scenario of that group, writes no passing bundle, and the run continues to the next group. An unmet **base** prerequisite stops the whole run.

**The run cost, accepted and not reduced.** `scripts/e2e/lib/scenario/p1-e4.ts:105-108` calls `provisionImages`, and `scripts/e2e/lib/podman/provision.ts:258-270` builds two images per invocation. The three Podman scenarios therefore build six images and share none. Add no sharing mechanism; `020-wiring-and-scenarios.md` owns `scripts/e2e/lib/podman/`.

## Constraints

- Pass `--tag "$TAG"` on every line. A missing `--tag` mints a fresh tag silently.
- Pass no `--daemon-host` and no `--client-host`. EPIC 020 makes both an argument fault for the three `P1B-*` ids.
- Do not re-run one id under the same tag. `claimBundleDirectory` at `scripts/e2e/lib/tag.ts:31-53` refuses it with `tag-reused`, exit `2`.
- Change no order to make a failing scenario pass.

## Verify

- Each of the seven lines writes `.data/acceptance-<tag>/<id>/bundle.json`.
- `declaredScenarioOrder` in `scripts/e2e/lib/record/manifest.ts`, written by Story 1, equals these seven ids in this order. Assert it by reading the file, and never restate the order in a second place.
- The manifest `scenarios` array of Story 13 lists the seven ids in invocation order, and `node scripts/e2e/run.mjs --check-manifest "$TAG"` exits 0 on it. `--check-manifest` is the mechanism that asserts this order, per `025-external-drive-acceptance-run.md:222`.
- A scenario that exits non-zero still leaves a `bundle.json` whose `outcome` is `failed` or `unavailable`, and the next line still runs.
- Proof: lines `202` to `208` of the run block at `025-external-drive-acceptance-run.md:200-218`.
