# Story 9 — Run the two-client scenario: P1B-E2

Epic: `.agent/plan/epics/025-external-drive-acceptance-run.md`
Depends on: Story 6, for the fifth position in the order.

This is the EPIC bullet at `025-external-drive-acceptance-run.md:137`. The `podman` driver and the `fixture` profile. **This is the bundle the block exits by pointing at**, per `013-external-drive-overview.md:13`.

## The five tasks

### setup

- Prove the **container** prerequisite: Podman is reachable at the pinned version, with no pull.
- Record rootless or rootful mode and the architecture. `bundle.note` admits `podmanRootless` and `architecture`, which are members of the closed `noteKeys` allowlist at `scripts/e2e/lib/bundle.ts:82-91`.
- Provision the two images with no pull, and **never start a Podman machine**.
- Confirm the four deployment preconditions of `025-external-drive-acceptance-run.md:98-101` against the topology the runner builds:
  - `http.allowedHosts` names the exact authority each client sends, port included. `src/http/server/host.ts:20` matches the string with the port, so a client reaching a container IP answers `403 host-forbidden`. `src/services/config/convict.ts:167-171` has no usable default.
  - A non-loopback bind needs a token, per `src/services/config/refusals.ts:70-77`. The runner delivers it as a mounted mode-`0600` file, never an argument and never an environment variable.
  - `kanthord db migrate` runs inside the daemon container, because `src/cli/options.ts:118-128` refuses a non-loopback base url.
  - The daemon terminates no TLS, per `docs/proposal/phase-1/transport.md:29`. Record that every token crossed a private container network in cleartext, and claim no transport security.

### seed

The **three-objective** fixture at `test/e2e/fixtures/three-objective/`, the same one Story 8 seeds, delivered into **both** client containers.

### run

```sh
node scripts/e2e/run.mjs P1B-E2 --tag "$TAG"
```

Invoke nothing else.

### cleanup

Confirm no container, pod, network or volume carries the run id label, **the second client container included**. Confirm it on the failure path as well as the success path.

### record

Append one row to the manifest `scenarios` array in the fifth position. Append to the report the product artifact digest, the base image digest and the architecture, because **an `arm64` pass is not evidence for another architecture**. `noteKeys` at `scripts/e2e/lib/bundle.ts:82-91` admits `productDigest`, `baseDigest` and `architecture`, so the bundle already carries all three; reference them from the bundle rather than re-deriving them.

## Constraints

- Assert nothing of your own. `020-wiring-and-scenarios.md:85-97` owns the ten phases of this oracle.
- **This run proves no environment.** It proves the two-host logic in containers on one machine. It proves no routing, no VPN and no TLS. `013-external-drive-overview.md:24` states the exit criterion as two harness processes on **two machines**, and this run does not reach that. The gap is an obligation on EPIC 013 at `025-external-drive-acceptance-run.md:179`. Change no exit criterion here.
- Every request except the one race is sequential, so this scenario does not prove concurrent traffic.
- Repair no defect found here.
- Do not merge, edit or move the bundle.

## Verify

- `.data/acceptance-<tag>/P1B-E2/bundle.json` exists, its `tag` field equals the run tag, and its `scenarioId` field equals `P1B-E2`.
- The bundle names the commit under test.
- On a green run the bundle reports `outcome: "passed"`.
- The bundle `notes` carry `productDigest`, `baseDigest` and `architecture`.
- No Podman resource carries the run id label after the run, asserted for containers, pods, networks and volumes.
- A failure does not stop `P1B-E3`, and the bundle is still written.
- Proof: line `206` of the run block at `025-external-drive-acceptance-run.md:200-218`.
