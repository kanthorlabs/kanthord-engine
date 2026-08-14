# Story 10 — Run the takeover: P1B-E3

Epic: `.agent/plan/epics/021-external-drive-acceptance-run.md`
Depends on: Story 6, for the sixth position in the order. Story 9, for the setup it repeats.

This is the EPIC bullet at `021-external-drive-acceptance-run.md:139`. The `podman` driver and the `fixture` profile.

## The five tasks

### setup

The setup of Story 9, repeated in full. **It builds two more images**, because no run-level image sharing exists: `scripts/e2e/lib/scenario/p1-e4.ts:105-108` calls `provisionImages` and `scripts/e2e/lib/podman/provision.ts:258-270` builds two images on each invocation. Accept the cost and add no sharing mechanism.

### seed

The **two-objective** fixture at `test/e2e/fixtures/two-objective/`. The scenario declaration takes the `two-objective` plan axis, because a takeover needs one task and no objective dependency. **This is not the fixture Stories 8 and 9 seed.**

### run

```sh
node scripts/e2e/run.mjs P1B-E3 --tag "$TAG"
```

Invoke nothing else.

### cleanup

Confirm the run id label survives on no resource: no container, no pod, no network and no volume. Confirm it on the failure path as well as the success path.

### record

Append one row to the manifest `scenarios` array in the sixth position. Record the observed takeover latency **in the report prose of Story 13**, and never as an assertion of this epic.

**The latency has no bundle note key.** `noteKeys` at `scripts/e2e/lib/bundle.ts:82-91` is a closed allowlist of eight names and holds no latency member, and `note()` throws `invalid-argument` for a name outside it. Read the latency from the scenario output and put it in the report. Add no key to `noteKeys`; `021-external-drive-acceptance-run.md:241` fixes the file list of this epic and `bundle.ts` is not in it.

## Constraints

- Assert nothing of your own. `020-wiring-and-scenarios.md:99` owns this oracle.
- **The scenario waits on wall clock and controls no clock**, because the daemon exposes no time API. It polls `node claim` at 250 ms to a deadline of 60000 ms under a `leaseTtlMs` of 2000. Do not shorten the deadline and do not retry a timeout as a pass.
- The observed latency is diagnostic. A latency inside the deadline is not a finding.
- Repair no defect found here.
- Do not merge, edit or move the bundle.

## Verify

- `.data/acceptance-<tag>/P1B-E3/bundle.json` exists, its `tag` field equals the run tag, and its `scenarioId` field equals `P1B-E3`.
- The bundle names the commit under test.
- On a green run the bundle reports `outcome: "passed"`.
- No Podman resource carries the run id label after the run.
- A failure does not stop `P1-E5`, and the bundle is still written.
- Proof: line `207` of the run block at `021-external-drive-acceptance-run.md:200-218`.
