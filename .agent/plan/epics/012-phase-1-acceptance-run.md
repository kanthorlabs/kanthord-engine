# EPIC 012 — Phase 1 acceptance run

Status: **PASS**.

## Goal

Phase 1 closes on evidence. A coding agent runs every declared phase-1 scenario against the assembled product and reports the run green, a human then drives the same journey and signs it, and one verdict points at the P1-E5 bundle.

The verdict has two axes. The scenario axis is machine-checked: every declared scenario, the regression suite, and one commit across them. The acceptance axis is the human confirmation: the drive, and the judgment no oracle can assert. Phase 1 exits on both.

This epic exists because a phase can hold four green scenarios and no decision. EPIC 011 makes each scenario runnable. Nothing makes the run happen once, in order, on the real profile, with a report that opens a fix epic for each blocker.

## Non-goals

- **No production code, and no `node:test` case.** This epic writes a report. A defect it finds becomes a separate fix epic, because a fix inside an acceptance run destroys the evidence the run exists to produce.
- **No oracle.** EPIC 011 owns every oracle. A run story names a scenario id and the command that runs it, and it asserts nothing of its own. Two statements of one oracle disagree eventually.
- **No new scenario.** `docs/proposal/phase-1/README.md` declares which scenarios exist. A gap found here becomes a proposal amendment, then an EPIC 011 story. It never becomes a story in this epic.
- **No runner change.** Cleanup, the failure path, the run id and the bundle format belong to EPIC 011. The tag mint, the verify record, the acceptance record and the verdict belong to EPIC 011.1. This epic consumes them, and it adds no option to `scripts/e2e/run.mjs`.
- **No merge of bundles.** A bundle is immutable evidence. The report references bundles by path and per-file digest.
- **Nothing is committed.** `docs/proposal/README.md` says a run writes an evidence bundle and not a `PASS` marker in the repository. A bundle names the commit under test and the proposal revision, so the bundle identifies the source and the source never carries the bundle. `.data/acceptance-*/` and `.agent/acceptance/` are ignored. A committed bundle would also make one redaction defect permanent, and it would grow the repository by one copy of every log on every rerun.

## The driver

`/work` cannot drive this epic, because there is no failing test to write and no production code to make pass. `.claude/commands/e2e.md` drives it, and a human or a coding agent runs that command against one phase. The command executes scenario ids and writes the report; it defines no scenario and restates no oracle.

## The story kinds

Three kinds of story, because one task shape does not fit all three.

| Kind             | Stories                                            | Shape                                     |
| ---------------- | -------------------------------------------------- | ----------------------------------------- |
| frame            | the run frame; the report and the verdict          | it creates and reads run state            |
| scenario run     | the fixture baseline; the container gate; the exit | the five tasks below                      |
| human acceptance | the rehearsal and the gate                         | a drive, a judgment and one signed record |

## The task shape

Every scenario run story carries the same five tasks, so a human and a coding agent execute one procedure.

| Task    | Meaning                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| setup   | prove the prerequisites, then arrange the host state the scenario needs              |
| seed    | supply the scenario data, or prove the absence that the scenario needs               |
| run     | invoke the EPIC 011 command for the scenario id, and nothing else                    |
| cleanup | confirm the runner released every resource, on the failure path and the success path |
| record  | append the bundle reference, the outcome, and every finding to the report            |

A scenario with no data to seed still carries a seed task, and that task proves the absence. A first run needs an absent home, and proving it absent is arranging the precondition.

## The continuation policy

A scenario that fails on the product records its outcome, and the run continues to the next
scenario. The epic exists to group every finding by root cause and to open one fix epic per blocker,
and a run that stops at the first defect returns one finding and three unknowns.

A prerequisite failure is the one exception. It reports `unavailable`, and it stops the run, because
a scenario that cannot start proves nothing about the product and the next scenario shares the same
prerequisite.

## Stories

- **The run frame** — one run tag from `node scripts/e2e/run.mjs --mint-tag`, an isolated run directory `.data/acceptance-<tag>/`, and a report at `.agent/acceptance/<tag>/report.md`. The runner mints the tag, because a shell timestamp is not portable and a one-second timestamp collides between two parallel invocations. Tag reuse is refused, so a rerun is a new tag. The tag reaches every invocation as an explicit argument; an exported variable that no command receives produces bundles the report cannot name. `node scripts/e2e/run.mjs --record-verify --tag <tag>` runs the regression suite and records it under the same tag, because `docs/proposal/README.md` names two kinds of proof and the phase exits on both. The report carries the commit under test, the proposal revision, each bundle path and digest, the verify record, the acceptance record, the findings, and one outcome of `passed`, `blocked` or `failed`. A `blocked` outcome is never reported as a pass.

- **Run the fixture baseline — P1-E1 and P1-E2** — the mandatory local gate, on the `local` driver and the fixture profile. Setup proves the pinned `git` binary and builds the artifact from the commit under test. Seed is the two-objective fixture under `test/e2e/fixtures/`. Run invokes `scripts/e2e/run.mjs P1-E1 --tag <tag>` then `P1-E2 --tag <tag>`. Cleanup confirms no temporary home, no daemon process and no held home lock survive. Record appends both bundles.

- **Run the container gate — P1-E4** — the `podman` driver and the fixture profile. Setup proves Podman reachable at the pinned version, records rootless or rootful mode and the architecture, and provisions the images with no pull. It never starts a Podman machine. Seed is the same fixture, delivered into the client container. Run invokes `scripts/e2e/run.mjs P1-E4 --tag <tag>`. Cleanup confirms no container, pod, network or volume carries the run id label. Record appends the bundle, the product artifact digest, the base image digest and the architecture, because an `arm64` pass is not evidence for another architecture.

- **Run the exit — P1-E5** — the `local` driver and the real profile, on one machine. Setup proves `.env.e2e` complete and the real credential valid; a missing prerequisite fails the run as unavailable and never skips. Seed is a hand-authored two-objective plan against the real repository, not the fixture, because fixture object ids and the fixture default branch do not transfer. Run invokes `scripts/e2e/run.mjs P1-E5 --tag <tag>`. Cleanup removes the temporary home, the token file and the daemon process. No phase-1 operation writes a ref on the remote, so the forge is unchanged and the run names no remote branch. Record appends the bundle, the repository and the detected default branch. This is the bundle the phase exits by pointing at. No phase-1 scenario crosses the VPN: `docs/proposal/README.md` puts every `deployment` scenario in phase 3.

- **The rehearsal** — a coding agent runs the four scenarios and the verify record under one tag, and reports the scenario axis green with `node scripts/e2e/run.mjs --verdict <tag> --scenarios-only`. The rehearsal is repeatable and unattended, because no scenario pauses for a human. It never closes the phase: `--scenarios-only` checks one axis and says nothing about the other. The rehearsal exists so the human gate meets a run that already works, and so the human drives the same CLI and the same API the rehearsal drove.

- **The human gate** — Ulrich drives the P1-E5 journey himself, through the CLI and the API, on the commit under test. He then judges the four subjects `docs/proposal/README.md` keeps out of every scenario: the first-run message, the validation finding set a human reads while authoring a plan by hand, the re-import suggestion set, and the `plan export` rendering. He authors a plan with three faults in one document, reads the findings, fixes them, and drives a re-import that needs a per-node choice. One invocation of `node scripts/e2e/run.mjs --record-acceptance --tag <tag>` signs the drive and the judgment. This is not an oracle and not a scenario, and it is not advisory either: it is the acceptance axis, and the phase does not exit without it.

- **The report and the verdict** — findings grouped by root cause, each as `<B1/S1> - action:<YES/NO> - <name> - <description>`. Each blocker opens a fix epic and phase 1 stays open. The outcome is not asserted in prose: `node scripts/e2e/run.mjs --verdict <tag>` checks both axes and returns the exit status, and the report records that command and its exit status. The scenario axis needs a bundle per declared scenario, all `passed`, a verify record with exit status zero, and one commit across every record. The acceptance axis needs a signed record on that same commit. Phase 1 closes on a zero exit status from `--verdict`, a P1-E5 bundle, a proposal revision and an implementation commit.

## Verification gate

Gates: `npm run verify`

Proof: this epic ships no code, so the Proof is the run and the report it produced. The exit run is part of it, because the epic exists to produce the exit verdict.

Each scenario runs on its own line, and a failing line does not stop the next one. The verdict, not
the shell, decides the outcome.

```bash
TAG=$(node scripts/e2e/run.mjs --mint-tag)
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"
node scripts/e2e/run.mjs P1-E5 --tag "$TAG"
node scripts/e2e/run.mjs --record-verify --tag "$TAG"
node scripts/e2e/run.mjs --verdict "$TAG" --scenarios-only
# the human gate, after the rehearsal is green
node scripts/e2e/run.mjs --record-acceptance --tag "$TAG" --by Ulrich \
  --drive confirmed --judgment accepted --note-file "$NOTE"
node scripts/e2e/run.mjs --verdict "$TAG" \
  && test -f ".agent/acceptance/$TAG/report.md" \
  && echo "PASS EPIC-012"
```

Coverage required beyond the Proof:

- The report names every bundle by path and digest, and it modifies no bundle.
- The report records the `--verdict` command and its exit status, and the outcome it states agrees
  with that exit status.
- A `blocked` outcome exits `2` or `3`, and a `failed` outcome exits `1`, so a stopped run never
  reads as a pass and never reads as a defect. `.claude/commands/e2e.md` holds the one exit-code
  table; this list restates no number that the table does not carry.
- A missing P1-E5 prerequisite reports unavailable and writes no passing bundle.
- A failing scenario does not stop the scenarios after it, and each one still writes a bundle.
- Every bundle, the verify record and the acceptance record name one commit under test.
- The rehearsal passes `--scenarios-only` and the full verdict still fails until the gate is signed.
- Every blocker in the report has a fix epic, and phase 1 does not close while one is open.
- The report holds no token, no credential and no secret, in the commands, the logs and the diagnostics.
