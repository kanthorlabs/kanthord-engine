# Story 11 — The proposal declares the three scenario ids

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 1.

`AGENTS.md` makes `docs/proposal/` the source of truth for behaviour, and the three ids live in planning files only today. **This story lands before the three scenario files**, because EPIC 025 runs no scenario the proposal does not declare.

## Change

### `docs/proposal/phase-1/README.md`

Append three sections to the `## End-to-end scenarios` section, after the closing paragraph at `:112` and before the end of the file. Order: `### P1B-E1`, `### P1B-E2`, `### P1B-E3`.

Each heading follows the existing form exactly, an em dash and a title:

```text
### P1B-E1 — The single-harness loop
### P1B-E2 — Two harness clients on one daemon
### P1B-E3 — The stale harness loses its claim
```

Each section uses the field order the `P1-E4` and `P1-E5` sections use: **Mode**, **Driver** and **Profile** on one line, **Why it exists**, **Automation**, **Human action**, **Topology** for a `podman` id only, **Oracle**, **Evidence**.

Every field repeats a decision the EPIC already took. **Decide nothing new here.**

- **`P1B-E1`** — mode `deterministic`, driver `local`, profile fixture, plan `three-objective`, automation `scripts/e2e/run.mjs P1B-E1`, human action none, no Topology field. Oracle: one registered harness lists the ready frontier; each alpha task claims with attempt number 1, heartbeats, and reports `accepted`; alpha reaches `awaiting_approval` on an attestation; `node show` returns that `attestedObjectId` and the computed `projection`; an attest by the human token is `403 actor-forbidden`; `node close` by the human token moves alpha to `done`; `gamma` still reads `pending` and beta's first task still reads `ready`. Evidence: every command with its exit status, and the node state of each of the five tasks by identity.

- **`P1B-E2`** — mode `deterministic`, driver `podman`, profile fixture, plan `three-objective`, automation `scripts/e2e/run.mjs P1B-E2`, human action none. Topology: four containers in three network namespaces — the fixture-remote and daemon pod of `P1-E4`, and two client containers, each with no daemon volume. Oracle: the ten phases of the exit journey, in order, as Story 15 states them. Evidence adds the second client identity, the product artifact digest, the base image digest and the architecture. State that **this is the block's exit criterion**.

- **`P1B-E3`** — mode `deterministic`, driver `podman`, profile fixture, plan `two-objective`, automation `scripts/e2e/run.mjs P1B-E3`, human action none. Topology: the topology of `P1B-E2`. Oracle: an unheartbeated lease expires; the second client's first `200` carries a fence greater than the first; a report on the stale fence is `409 lease-held` and changes no node state; exactly one `outcome.reported` event exists for the task, naming the second actor. Evidence adds the observed takeover latency, which is diagnostic.

## Constraints

- **Amend no other line of that file.** In particular, the `P1-E1` oracle line that reads "all `pending`" at `:78` belongs to EPIC 016, in the same change as its `journey.ts` repair. If that line still reads `all pending`, Story 1 Check 1 already failed and this epic does not start.
- Add no scenario to `docs/proposal/README.md` and no row to any phase-3 file.
- Declare no `integration` and no `deployment` mode. All three are `deterministic`.
- Move no `sql` fence anywhere in `docs/proposal/`, because `test/helpers/proposal.ts` compares them.

## Verify

- `node --test scripts/e2e/lib/scenario/discipline.test.ts` exits 0 after Story 12 lands the parity assertion. Until then, assert by hand that the section holds exactly seven `### ` headings, in the order `P1-E1`, `P1-E2`, `P1-E4`, `P1-E5`, `P1B-E1`, `P1B-E2`, `P1B-E3`.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/scenario/discipline.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:158`.
