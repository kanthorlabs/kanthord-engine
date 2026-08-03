# EPIC 012 — Phase 1 acceptance run

Status: **draft**.

## Goal

Phase 1 closes on evidence. A maintainer or a coding agent runs every declared phase-1 scenario against the assembled product, records what no oracle can assert, and writes one verdict that points at the P1-E3 bundle.

This epic exists because a phase can hold four green scenarios and no decision. EPIC 011 makes each scenario runnable. Nothing makes the run happen once, in order, on the real profile, with a report that opens a fix epic for each blocker.

## Non-goals

- **No production code, and no `node:test` case.** This epic writes a report. A defect it finds becomes a separate fix epic, because a fix inside an acceptance run destroys the evidence the run exists to produce.
- **No oracle.** EPIC 011 owns every oracle. A run story names a scenario id and the command that runs it, and it asserts nothing of its own. Two statements of one oracle disagree eventually.
- **No new scenario.** `docs/proposal/phase-1/README.md` declares which scenarios exist. A gap found here becomes a proposal amendment, then an EPIC 011 story. It never becomes a story in this epic.
- **No runner change.** Cleanup, the failure path, the run id and the bundle format belong to EPIC 011. This epic consumes them.
- **No merge of bundles.** A bundle is immutable evidence. The report references bundles by path and per-file digest.
- **Nothing is committed.** `docs/proposal/README.md` says a run writes an evidence bundle and not a `PASS` marker in the repository. A bundle names the commit under test and the proposal revision, so the bundle identifies the source and the source never carries the bundle. `.data/acceptance-*/` and `.agent/acceptance/` are ignored. A committed bundle would also make one redaction defect permanent, and it would grow the repository by one copy of every log on every rerun.

## The driver

`/work` cannot drive this epic, because there is no failing test to write and no production code to make pass. `.claude/commands/e2e.md` drives it, and a human or a coding agent runs that command against one phase. The command executes scenario ids and writes the report; it defines no scenario and restates no oracle.

## The task shape

Every run story carries the same five tasks, so a human and a coding agent execute one procedure.

| Task    | Meaning                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| setup   | prove the prerequisites, then arrange the host state the scenario needs              |
| seed    | supply the scenario data, or prove the absence that the scenario needs               |
| run     | invoke the EPIC 011 command for the scenario id, and nothing else                    |
| cleanup | confirm the runner released every resource, on the failure path and the success path |
| record  | append the bundle reference, the outcome, and every finding to the report            |

A scenario with no data to seed still carries a seed task, and that task proves the absence. A first run needs an absent home, and proving it absent is arranging the precondition.

## Stories

- **The run frame** — one run tag from `date -u +%Y%m%d%H%M%S%N`, an isolated run directory `.data/acceptance-<tag>/`, and a report at `.agent/acceptance/<tag>/report.md`. Tag reuse is refused, so a rerun is a new tag. The tag reaches every invocation as an explicit argument; an exported variable that no command receives produces bundles the report cannot name. The tag carries nanoseconds because a one-second timestamp collides between two parallel invocations. The report carries the commit under test, the proposal revision, each bundle path and digest, the findings, and one outcome of `passed`, `blocked` or `failed`. A `blocked` outcome is never reported as a pass.

- **Run the fixture baseline — P1-E1 and P1-E2** — the mandatory local gate, on the `local` driver and the fixture profile. Setup proves the pinned `git` binary and builds the artifact from the commit under test. Seed is the two-objective fixture under `test/e2e/fixtures/`. Run invokes `scripts/e2e/run.mjs P1-E1 --tag <tag>` then `P1-E2 --tag <tag>`. Cleanup confirms no temporary home, no daemon process and no held home lock survive. Record appends both bundles.

- **Run the container gate — P1-E4** — the `podman` driver and the fixture profile. Setup proves Podman reachable at the pinned version, records rootless or rootful mode and the architecture, and provisions the images with no pull. It never starts a Podman machine. Seed is the same fixture, delivered into the client container. Run invokes `scripts/e2e/run.mjs P1-E4 --tag <tag>`. Cleanup confirms no container, pod, network or volume carries the run id label. Record appends the bundle, the product artifact digest, the base image digest and the architecture, because an `arm64` pass is not evidence for another architecture.

- **Run the exit — P1-E3** — the `ssh` driver and the real profile, on two real hosts across the VPN. Setup proves both hosts reachable, the real repository present and the real credential valid; a missing prerequisite fails the run as unavailable and never skips. Seed is a hand-authored two-objective plan against the real repository, not the fixture, because fixture object ids and the fixture default branch do not transfer. Run invokes `scripts/e2e/run.mjs P1-E3 --tag <tag> --daemon-host <a> --client-host <b>`. Cleanup removes the artifact and the configuration from both hosts, and it deletes no remote branch: the branches the run created are named in the report, and a human decides. Record appends the bundle, both host identities and the bind address. This is the bundle the phase exits by pointing at.

- **Product acceptance, recorded separately** — the judgment `docs/proposal/README.md` keeps out of every scenario: the first-run message, the validation finding set a human reads while authoring a plan by hand, the re-import suggestion set, and the `plan export` rendering. A maintainer authors a plan with three faults in one document, reads the findings, fixes them, and drives a re-import that needs a per-node choice. The result is an acceptance record inside the report, labelled as judgment. It is never an oracle and it never gates the run, because a machine cannot check it and a scenario that only a human can judge is not a scenario.

- **The report and the verdict** — findings grouped by root cause, each as `<B1/S1> - action:<YES/NO> - <name> - <description>`. Each blocker opens a fix epic and phase 1 stays open. Phase 1 closes on a `passed` outcome, a P1-E3 bundle, a proposal revision and an implementation commit.

## Verification gate

Gates: `npm run verify`

Proof: this epic ships no code, so the Proof is the run and the report it produced. The exit run is part of it, because the epic exists to produce the exit verdict.

```bash
TAG=$(date -u +%Y%m%d%H%M%S%N)
node scripts/e2e/run.mjs P1-E1 --tag "$TAG" \
  && node scripts/e2e/run.mjs P1-E2 --tag "$TAG" \
  && node scripts/e2e/run.mjs P1-E4 --tag "$TAG" \
  && node scripts/e2e/run.mjs P1-E3 --tag "$TAG" \
       --daemon-host "$KANTHORD_ACCEPT_DAEMON_HOST" \
       --client-host "$KANTHORD_ACCEPT_CLIENT_HOST" \
  && test -f ".agent/acceptance/$TAG/report.md" \
  && echo "PASS EPIC-012"
```

Coverage required beyond the Proof:

- The report names every bundle by path and digest, and it modifies no bundle.
- A `blocked` outcome exits non-zero, so a stopped run never reads as a pass.
- A missing P1-E3 prerequisite reports unavailable and writes no passing bundle.
- Every blocker in the report has a fix epic, and phase 1 does not close while one is open.
- The report holds no token, no credential and no secret, in the commands, the logs and the diagnostics.
