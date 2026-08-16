# EPIC 025 — External-drive acceptance run

Status: **draft**.

## Goal

Phase 1b closes on evidence. A coding agent runs every declared scenario against the assembled product under one tag, and it writes one machine-readable run manifest. A human then drives the two-client journey, answers the acceptance checklist row by row, and signs it. One verdict points at the `P1B-E2` bundle.

The verdict has two axes. The scenario axis is machine-checked: the seven scenario bundles, the regression record, and one commit across them. The acceptance axis is the human confirmation: the drive, the checklist and the judgment. The block exits on both, and `node scripts/e2e/run.mjs --check-manifest <tag>` gates the run procedure between them.

This epic exists because a block can hold three green scenarios and no decision. EPIC 020 makes each scenario runnable. Nothing makes the run happen once, in order, on the real deployment shape, with a report that opens a fix epic for each blocker.

## Non-goals

- **No `src/` code.** This epic edits no file under `src/` and no file under `docs/proposal/`. A defect it finds becomes a separate fix epic, because a fix inside an acceptance run destroys the evidence the run exists to produce.
- **No oracle, and no scenario code.** EPIC 020 owns every oracle, every scenario file, every driver and every topology of this block. A run story names a scenario id and the command that runs it, and it asserts nothing of its own.
- **No new scenario.** `020-wiring-and-scenarios.md:36` declares the three block ids, and `docs/proposal/phase-1/README.md:59-108` declares the four phase-1 ids. A gap found here becomes a proposal amendment, then an EPIC 020 story. It never becomes a story in this epic.
- **No verdict change.** The tag mint, the verify record, the acceptance record and `scripts/e2e/lib/record/verdict.ts` belong to EPIC 011.1, and EPIC 020 adds the three block ids to the required set at `020-wiring-and-scenarios.md:77`. This epic consumes them unchanged.
- **No environment proof.** `P1B-E2` proves the two-host logic in containers on one machine. It proves no routing, no VPN and no TLS. `013-external-drive-overview.md:24` states the exit criterion as two harness processes on **two machines**, and this run does not reach that. The gap is named as an obligation on EPIC 013 below, and this epic changes no exit criterion. Phase 3 proves the environment once.
- **No merge of bundles.** A bundle is immutable evidence. The manifest and the report reference a bundle by path and by digest.
- **No CLI command.** EPIC 020 ships `kanthord event list` as the one command it owns (`020-wiring-and-scenarios.md:17`), and the checklist below reads the event log through that command. This epic writes no command and no `src/cli/inventory.ts` row.
- **Nothing is committed.** `docs/proposal/README.md:116` says a run writes an evidence bundle and not a `PASS` marker in the repository. `.data/acceptance-*/` and `.agent/acceptance/` are ignored.

## The one code deliverable, and why it exists

`npm run verify` verifies no procedure of this epic today. `scripts/e2e/lib/record/verdict.ts:65-131` reads bundles, `verify.json`, commits and outcomes only. It never opens `.agent/acceptance/<tag>/report.md`, so an empty report passes a path test. The acceptance record holds one `drive`, one `judgment` and one free-form `note` (`scripts/e2e/lib/main.ts:266-324`, `scripts/e2e/lib/record/acceptance.ts:83-94`), so it represents no checklist row.

This epic therefore ships one module under `scripts/e2e/lib/record/`, one runner option pair, and one `node:test` file. That file is the deliverable `npm run verify` gates. Everything the manifest cannot check is named as a reviewer judgment in the table below, and it is claimed as nothing more.

### What the machine checks, and what a reviewer judges

| Fact                                                                       | Mechanism                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| seven bundles under one tag, each `passed`                                 | `--verdict`, after EPIC 020 adds the three ids     |
| a verify record with exit status zero                                      | `--verdict`                                        |
| one commit across every bundle and record                                  | `--verdict`                                        |
| a signed acceptance record, `drive: confirmed` and `judgment: accepted`    | `--verdict`                                        |
| the seven scenario ids in the declared order                               | `--check-manifest`                                 |
| each bundle names its own tag and its own scenario id inside `bundle.json` | `--check-manifest`                                 |
| each manifest bundle digest equals the file on disk                        | `--check-manifest`                                 |
| six checklist rows, each answered, each `rejected` row with a note         | `--check-manifest`                                 |
| a non-empty report at the recorded digest                                  | `--check-manifest`                                 |
| one fix epic named per blocker                                             | `--check-manifest`                                 |
| the report groups findings by root cause                                   | reviewer judgment                                  |
| the report prose is accurate and complete                                  | reviewer judgment                                  |
| the human drove the journey rather than read a transcript                  | reviewer judgment, recorded by `--drive confirmed` |
| the checklist answers are truthful                                         | reviewer judgment                                  |

## The driver

`/work` cannot drive this epic beyond the one test file, because the rest of it is a run and a report. `.claude/commands/e2e.md` drives it. That command states "This command drives EPIC 012" at `e2e.md:16`, hard-codes the four phase-1 ids at `:43-53`, and defines the phase-1 acceptance subjects at `:109-114`. **This epic owns the update**, and one story below carries it.

## The scenario set the verdict requires

`scripts/e2e/lib/record/verdict.ts:20-25` lists four phase-1 ids today. `020-wiring-and-scenarios.md:77` adds `P1B-E1`, `P1B-E2` and `P1B-E3` to that list. So `--verdict <tag>` exits zero on **seven** bundles once EPIC 020 lands, and on four until then. The seven-bundle rule of this epic is a consequence of that EPIC 020 story, and it is not a statement about the code today.

## The phase-1 axis is amended, not replayed

`013-external-drive-overview.md:11` says the block changes no phase-1 behaviour. That claim is false, and **EPIC 013 owns the correction**. Four block epics change shipped phase-1 behaviour:

- EPIC 016 turns an imported plan from every node `pending` into a derived `ready` frontier (`016-readiness-applied.md:7`).
- EPIC 016 appends new `node.ready` events during import (`016-readiness-applied.md:52,95`).
- EPIC 017 states it outright: "This changes shipped phase-1 behaviour, deliberately" (`017-per-node-graph-write.md:30`).
- EPIC 015 attributes new human events to the bootstrap actor identity and widens the actor kinds (`015-actor-identity.md:36,61`).

The break is concrete. `scripts/e2e/lib/scenario/journey.ts:388-399` asserts `tasksAllPending: true`. `runJourney` is called by `p1-e1.ts:10`, `p1-e4.ts:225` and `p1-e5.ts:149`, so all three fail after EPIC 016. `P1-E2` is transport-only and it is unaffected.

The regression boundary of this epic is therefore an **amended** phase-1 journey. It preserves transport, packaging, import, export and real-forge compatibility, and it expects the new ready frontier. Re-running the old oracle guarantees failure and proves no compatibility. **EPIC 016 owns the `journey.ts` repair and the matching `docs/proposal/phase-1/README.md` oracle amendment**, because EPIC 016 is the epic that changes the frontier. This epic runs the amended journey and repairs nothing.

## The story kinds

Three kinds of story, because one task shape does not fit all three.

| Kind             | Stories                                                                                | Shape                                      |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| frame            | the manifest; the command update; the run frame; the order; the report and the verdict | it creates and reads run state             |
| scenario run     | the phase-1 axis; P1B-E1; P1B-E2; P1B-E3                                               | the five tasks below                       |
| human acceptance | the rehearsal and the gate                                                             | a drive, a checklist and one signed record |

## The task shape

Every scenario run story carries the same five tasks, so a human and a coding agent execute one procedure.

| Task    | Meaning                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------- |
| setup   | prove the prerequisites of its own group, then arrange the host state the scenario needs                 |
| seed    | supply the scenario data, or prove the absence that the scenario needs                                   |
| run     | invoke the EPIC 020 command for the scenario id, and nothing else                                        |
| cleanup | confirm the runner released every resource, on the failure path and the success path                     |
| record  | append the bundle reference, the digest and the outcome to the manifest, and every finding to the report |

A scenario with no data to seed still carries a seed task, and that task proves the absence.

## The preconditions the run needs

`013-external-drive-overview.md:126-154` states four deployment properties, and none of them is new code. Each is a setup task of a run story, and an unmet one reports `unavailable`.

- **`http.allowedHosts` names the exact authority each client sends, port included.** `src/services/config/convict.ts:167-171` has no usable default and `kanthord config generate` writes the two loopback entries only. `src/http/server/host.ts:20` matches the string with the port, so a client reaching a container IP answers `403 host-forbidden`.
- **A non-loopback bind needs a token**, per `src/services/config/refusals.ts:70-77`. The runner delivers it as a mounted mode-`0600` file, never an argument and never an environment variable.
- **`kanthord db migrate` runs on the daemon host.** `src/cli/options.ts:118-128` refuses a non-loopback base url, so the migration runs inside the daemon container and every other command runs from a client.
- **The daemon terminates no TLS**, per `docs/proposal/phase-1/transport.md:29`. The run records that every token crossed a private container network in cleartext, and it claims no transport security.

## The continuation policy

A scenario that fails on the product records its outcome, and the run continues to the next scenario. The epic exists to group every finding by root cause and to open one fix epic per blocker. A run that stops at the first defect returns one finding and six unknowns.

A prerequisite failure stops **its own group only**, because the prerequisites are not shared. Podman absent says nothing about the real-forge run of `P1-E5`. The three groups are fixed here.

| Group     | Prerequisite                                                               | Scenarios                   |
| --------- | -------------------------------------------------------------------------- | --------------------------- |
| base      | the pinned `git` binary, and the artifact built from the commit under test | all seven                   |
| container | Podman reachable at the pinned version, with no pull                       | `P1-E4`, `P1B-E2`, `P1B-E3` |
| forge     | a complete `.env.e2e`, and the throwaway repository and credential valid   | `P1-E5`                     |

An unmet group prerequisite reports `unavailable` for each scenario of that group, writes no passing bundle, and the run continues to the next group. An unmet base prerequisite stops the whole run, because every scenario shares it.

## The run cost, stated

`scripts/e2e/lib/scenario/p1-e4.ts:105-108` calls `provisionImages`, and `scripts/e2e/lib/podman/provision.ts:258-270` builds two images on each invocation. There is no run-level image sharing, so the three Podman scenarios build **six** images in one run and share none. Every fix epic needs a new tag, so every re-run repeats those six builds and repeats the `P1-E5` real-forge run against a quiet repository.

This epic accepts that cost and adds no sharing mechanism. **EPIC 020 owns run-level image sharing** if it is wanted, because EPIC 020 owns `scripts/e2e/lib/podman/`.

## Stories

- **The run manifest and its checker** — a new `scripts/e2e/lib/record/manifest.ts` and a new `scripts/e2e/lib/record/manifest.test.ts`, plus `--record-manifest --tag <tag> --manifest <file>` and `--check-manifest <tag>` in `scripts/e2e/lib/main.ts`. The manifest is canonical JSON at `.data/acceptance-<tag>/manifest.json`, written through `redact` and ordered key by key like `serializeAcceptanceRecord` at `scripts/e2e/lib/record/acceptance.ts:47-61`. It holds `schemaVersion`, `tag`, `commit`, `proposalRevision`, `scenarios`, `checklist`, `report`, `findings` and `outcome`. `scenarios` is an ordered array of `{ id, bundlePath, sha256, outcome }` in invocation order. `checklist` is exactly six rows of `{ row, subject, answer, note }`, where `answer` is `confirmed` or `rejected`. `report` is `{ path, sha256, bytes }`. `findings` is an array of `{ id, action, name, description, fixEpic }`. `--check-manifest` asserts, in this order: the scenario ids equal the declared order below, member for member; each named `bundle.json` exists, its digest equals the recorded one, and its own `tag` and `scenarioId` fields equal the run tag and the declared id; six checklist rows exist, each answered, and each `rejected` row carries a non-empty note; the report file exists, its digest matches and its byte count is above zero; every finding whose `id` starts with `B` names a `fixEpic`; and the outcome is `failed` when any bundle is not `passed` or any checklist row is `rejected`. It reuses `RunnerError` and `exitCodeFor` at `scripts/e2e/lib/main.ts:460`, so it adds no exit code. **The bundle-identity check closes a real gap**: `RawBundle` at `scripts/e2e/lib/record/verdict.ts:27` reads `commit` and `outcome` only, so a bundle copied from another tag or another scenario passes the verdict at the expected path with a matching commit and `passed`. `Bundle` at `scripts/e2e/lib/bundle.ts:38-58` already carries `tag` and `scenarioId`, so the checker reads them and needs no runner change elsewhere.

- **The `/e2e` command update** — `.claude/commands/e2e.md`. `:16` changes from "This command drives EPIC 012" to naming EPIC 012 and EPIC 025, and it states that the phase argument selects the id list. `:43-53` gains the phase-1b list in the order below, beside the phase-1 list it already holds. The acceptance subjects at `:109-114` gain the phase-1b checklist of this epic beside the phase-1 subjects, each labelled by phase. The run block gains `--record-manifest` before the rehearsal and `--check-manifest` before the verdict. The exit-code table at `:151-157` is unchanged, because this epic adds no code. **No other epic updates this file**: EPIC 020 declares that it owns no acceptance run at `020-wiring-and-scenarios.md:21`.

- **The run frame** — one run tag from `node scripts/e2e/run.mjs --mint-tag`, an isolated run directory `.data/acceptance-<tag>/` per `scripts/e2e/lib/tag.ts:15-17`, one bundle directory per scenario id per `:19-21`, and a report at `.agent/acceptance/<tag>/report.md`. Each bundle holds `bundle.json`, written by `writeBundle` at `scripts/e2e/lib/bundle.ts:261-283`. It holds a `logs/` directory **only when `bundle.logs` is non-empty**, per `:270-281`, so an absent `logs/` is not a finding. Every byte passes `redact` before it reaches disk. `readCommit` at `:317` stamps the commit under test into each bundle. **A bundle carries no proposal revision**: `Bundle` declares no such field, and `scripts/e2e/lib/main.ts:629-631` reads the commit alone. `readProposalRevision` at `bundle.ts:326` serves the verify record and the acceptance record only, and the manifest takes its own copy from the same command. The runner mints the tag, because a shell timestamp is not portable and a one-second timestamp collides between two parallel invocations. **Tag reuse is refused per scenario directory only**, by `claimBundleDirectory` at `scripts/e2e/lib/tag.ts:31-53`: a verify record is overwritten, an acceptance record is refused at `record/acceptance.ts:96-100`, and minting reserves no tag globally. A rerun is therefore a new tag by procedure, and `--check-manifest` binds every record to one tag and one commit. The tag reaches every invocation as an explicit argument; an exported variable that no command receives produces bundles the manifest cannot name. `node scripts/e2e/run.mjs --record-verify --tag <tag>` runs the regression suite and writes `.data/acceptance-<tag>/verify.json` per `scripts/e2e/lib/tag.ts:23-25`. **No report writer exists**, and none is built here: the coding agent authors `report.md` by hand, the verdict neither creates nor reads it, and `--check-manifest` is the only mechanism that binds the report to the run.

- **The run order** — seven invocations under one tag, in this exact order: `P1-E1`, `P1-E2`, `P1B-E1`, `P1-E4`, `P1B-E2`, `P1B-E3`, `P1-E5`. The two phase-1 local scenarios gate first, because Podman may be absent on an environment that must still gate. `P1B-E1` follows them on the same `local` driver, so a broken harness loop is found before a container is built. The three Podman scenarios run as one group, because they share the container prerequisite. `P1-E5` runs last, because it is the one `integration` scenario and it needs a quiet forge. The order is fixed here, `--check-manifest` asserts it, and no run story restates it.

- **Run the amended phase-1 axis — P1-E1, P1-E2, P1-E4 and P1-E5** — the regression evidence that the block preserved transport, packaging, import, export and real-forge compatibility. It runs the journey **EPIC 016 amended**, which expects the ready frontier at `scripts/e2e/lib/scenario/journey.ts:388-399`. Setup proves the base prerequisites, and the `P1-E4` line adds the container prerequisite while the `P1-E5` line adds the forge prerequisite. Seed is the two-objective fixture under `test/e2e/fixtures/` for the first three, and a hand-authored plan against the real repository for `P1-E5`, because fixture object ids and the fixture default branch do not transfer. Run invokes `scripts/e2e/run.mjs P1-E1 --tag <tag>`, then `P1-E2`, then `P1-E4`, then `P1-E5`, each in the position the order above gives it. Cleanup confirms no temporary home, no daemon process, no held home lock and no container, pod, network or volume carrying a run id label. Record appends the four bundles, the repository name and the detected default branch. A failure on this axis is a phase-1 regression, and it is a blocker against the block epic that caused it.

- **Run the single-harness loop — P1B-E1** — the `local` driver and the `fixture` profile. Setup proves the base prerequisites. **Seed is the three-objective fixture** at `test/e2e/fixtures/three-objective/`, because the scenario declaration takes the `three-objective` plan axis and asserts that `gamma` reads `pending`. Run invokes `scripts/e2e/run.mjs P1B-E1 --tag <tag>` and nothing else. Cleanup confirms no temporary home, no daemon process and no held home lock survive. Record appends the bundle and its digest.

- **Run the two-client scenario — P1B-E2** — the `podman` driver and the `fixture` profile, and the block's exit criterion per `013-external-drive-overview.md:13`. Setup proves the container prerequisite, records rootless or rootful mode and the architecture, provisions the two images with no pull, and never starts a Podman machine. It confirms the four preconditions above against the topology the runner builds. **Seed is the three-objective fixture**, the same one `P1B-E1` seeds, delivered into both client containers. Run invokes `scripts/e2e/run.mjs P1B-E2 --tag <tag>`. Cleanup confirms no container, pod, network or volume carries the run id label, the second client container included. Record appends the bundle, the product artifact digest, the base image digest and the architecture, because an `arm64` pass is not evidence for another architecture. This is the bundle the block exits by pointing at.

- **Run the takeover — P1B-E3** — the `podman` driver and the `fixture` profile. Setup is the setup of `P1B-E2`, and it builds two more images because no sharing exists. **Seed is the two-objective fixture** at `test/e2e/fixtures/two-objective/`, because the scenario declaration takes the `two-objective` plan axis: a takeover needs one task and no objective dependency. Run invokes `scripts/e2e/run.mjs P1B-E3 --tag <tag>`. Cleanup confirms the run id label survives on no resource. Record appends the bundle and the observed takeover latency, which is diagnostic and never an assertion of this epic.

- **The rehearsal** — a coding agent runs the seven scenarios and the verify record under one tag, writes the manifest scenario rows, and reports the scenario axis green with `node scripts/e2e/run.mjs --verdict <tag> --scenarios-only`. The rehearsal is repeatable and unattended, because no scenario pauses for a human. It never closes the block: `--scenarios-only` returns at `scripts/e2e/lib/record/verdict.ts:153-155` and says nothing about the other axis. The rehearsal exists so the human gate meets a run that already works, and so the human drives the same CLI and the same API the rehearsal drove.

- **The human gate** — Ulrich drives the `P1B-E2` journey himself, through the CLI, on the commit under test. Every step of the drive and every checklist row is one command, because EPIC 020 ships `kanthord event list` and the CLI covers the last read the checklist needed. He registers two harness actors, claims and reports from each, and closes an objective as the bootstrap `human` actor. He answers the six checklist rows below, and the coding agent writes each answer into the manifest. One invocation of `node scripts/e2e/run.mjs --record-acceptance --tag <tag>` signs the drive and the judgment, and `scripts/e2e/lib/record/acceptance.ts:96-100` refuses a second write, because a signature is not edited. The signed record carries one `drive`, one `judgment` and one note, so the manifest is the only place a row appears by itself. This is the acceptance axis, and the block does not exit without it.

- **The report and the verdict** — findings grouped by root cause, each as `<B1/S1> - action:<YES/NO> - <name> - <description>`, and each blocker copied into the manifest with its fix epic. The outcome is not asserted in prose: `node scripts/e2e/run.mjs --check-manifest <tag>` checks the procedure and `node scripts/e2e/run.mjs --verdict <tag>` checks both axes, and the report records both commands with their exit status. The scenario axis needs one bundle per declared id, all `passed`, a verify record with exit status zero, and one commit across every record. The acceptance axis needs a signed record on that same commit. The block closes on a zero exit status from both commands, a `P1B-E2` bundle, a proposal revision and an implementation commit.

## The product acceptance a machine cannot check

`docs/proposal/README.md:40` keeps judgment out of every scenario, so this is recorded apart from the oracles. The pivot claims that a human reads the graph and believes the harnesses did the work the plan describes. No oracle asserts belief. Ulrich runs this checklist after the rehearsal is green, on the commit under test, through the CLI only.

`019-outcome-report.md:7,77` decides how the human reads a result: `node.show` on an objective returns `attestedObjectId` and `projection`. So the object id is a node view field, and it is not audit-log spelunking. The event log stays the source for attribution alone, and it is read through `kanthord event list`, which EPIC 020 ships (`020-wiring-and-scenarios.md:17`). No checklist row needs a hand-authored HTTP request. EPIC 019 replaces the `z.unknown()` payload at `src/http/contract/event.ts:26` with the typed `eventPayload` union of `src/http/contract/event-payload.ts`, so a checklist row may name a payload key and the reviewer reads a documented shape rather than an opaque object.

| #   | Subject                              | What Ulrich confirms                                                                                                                                                                                                                           |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The graph reads as the plan          | `node list` and `node show` describe the same work the imported plan describes. A state he did not expect is a finding, not a lookup.                                                                                                          |
| 2   | The work is attributed               | `kanthord event list --type lease.claimed` and `kanthord event list --type outcome.reported`, run with the configured human token, name one actor per action. Each record names the harness that did it, and the two harness actor ids differ. |
| 3   | The result is readable from the node | `node show` on the finished objective returns the `attestedObjectId` its harness attested and the `projection` the daemon computed, per `019-outcome-report.md:77`. He reads no database and no log file.                                      |
| 4   | The refusal is legible               | The `409 lease-held` a second harness receives says which node is held, and a human reads the reason without a stack trace.                                                                                                                    |
| 5   | The close is a human act             | An objective at `awaiting_approval` is closed by `node close` with the human token, and the command a human recognizes is one command.                                                                                                         |
| 6   | The block broke nothing he uses      | The phase-1 journey he signed for EPIC 012 still reads the same through the same commands, with the ready frontier of EPIC 016 in place of the all-`pending` import.                                                                           |

A `rejected` answer on any row is a blocker, the manifest row carries the note, and the acceptance note names the row.

## The verdict, and what a fix epic is numbered

`.claude/commands/e2e.md` holds the one exit-code table, and this epic restates no number it does not carry.

- A `passed` outcome with a zero `--verdict` exit status and a zero `--check-manifest` exit status closes the block.
- Any other outcome keeps the block open. Each blocker opens one fix epic, and a suggestion opens none.
- **A fix epic takes the next unused decimal suffix under the epic that owed the defect, and it names the owner in metadata.** A defect in EPIC 018 opens `.agent/plan/epics/018.<n>-<slug>.md`, where `<n>` is the lowest integer that no file under `.agent/plan/epics/` already uses. The file carries a `Fixes: EPIC 018` line beside `Status:`. **The filename encodes no convention**: the decimal namespace is a general insertion namespace, and `007.5`, `009.5`, `010.5`, `010.6`, `011.1` and `011.2` are insertions rather than fixes. The metadata line is the only statement of what a fix epic repairs. A defect that no epic of the block owed opens `025.<n>-<slug>.md` under the same rule. This epic never repairs what it finds.
- A re-run after a fix epic lands is a **new tag**, and it repeats every story of this epic. It rebuilds six container images and repeats the real-forge run. A mixed tag is refused by the commit condition of the verdict.

## The obligations this epic places on other epics

Each one is stated here and owned there. This epic writes none of them.

- **EPIC 013** — correct `013-external-drive-overview.md:11`. The block does change phase-1 behaviour, and the four changes are named above.

- **EPIC 013** — reconcile the exit criterion at `013-external-drive-overview.md:24` with the run this epic performs. The criterion says two harness processes on **two machines**. `P1B-E2` runs two client containers on **one** machine, and this epic states that plainly. EPIC 013 either restates the criterion as two-host logic in two network namespaces, or it keeps the two-machine wording and moves the criterion to phase 3. **The container run excludes exactly four things that matter operationally**, and each one belongs in the corrected text: a public host authority in `http.allowedHosts` rather than a container alias; a bearer token in cleartext over a network the operator does not own, because the daemon terminates no TLS (`013-external-drive-overview.md:169`); the reverse-proxy or private-network configuration that supplies TLS; and the delivery of each harness token to its machine, which `015-actor-identity.md` names an operator responsibility and no epic proves. This epic writes none of that correction, and it runs no scenario that closes the gap.
- **EPIC 016** — amend `scripts/e2e/lib/scenario/journey.ts:388-399` from `tasksAllPending: true` to the derived ready frontier, and amend the matching `P1-E1` oracle line in `docs/proposal/phase-1/README.md`. Without it `P1-E1`, `P1-E4` and `P1-E5` each fail before this epic runs.
- **EPIC 020** — declare `P1B-E1`, `P1B-E2` and `P1B-E3` in `docs/proposal/phase-1/README.md`, with their mode, driver, profile and oracle, **before** it authors the three scenario files. `AGENTS.md` makes the proposal the source of truth, and the ids exist in planning files only today. EPIC 020 owns the story at `020-wiring-and-scenarios.md:70`, and `scripts/e2e/lib/scenario/discipline.test.ts` gates it. **This epic runs no scenario the proposal does not declare.**
- **EPIC 020** — own run-level image sharing if the six image builds per run are unacceptable. This epic accepts them.
- **EPIC 020** — add the three ids to `scripts/e2e/lib/record/verdict.ts:20-25`, per `020-wiring-and-scenarios.md:77`. The seven-bundle rule of this epic depends on it.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test scripts/e2e/lib/record/manifest.test.ts \
  && echo "PASS EPIC-025-UNIT"
```

`scripts/e2e/lib/record/manifest.test.ts` does not exist today, so `node --test` exits non-zero before this epic is built rather than collecting a green sibling suite. It is the one file this epic writes, and it is the reason `npm run verify` gates a deliverable of this epic.

The run itself is the second half of the Proof. Each scenario runs on its own line, and a failing line does not stop the next one. The verdict and the manifest checker, not the shell, decide the outcome.

```bash
TAG=$(node scripts/e2e/run.mjs --mint-tag)
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"
node scripts/e2e/run.mjs P1B-E1 --tag "$TAG"
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"
node scripts/e2e/run.mjs P1B-E2 --tag "$TAG"
node scripts/e2e/run.mjs P1B-E3 --tag "$TAG"
node scripts/e2e/run.mjs P1-E5 --tag "$TAG"
node scripts/e2e/run.mjs --record-verify --tag "$TAG"
node scripts/e2e/run.mjs --verdict "$TAG" --scenarios-only
# the human gate, after the rehearsal is green
node scripts/e2e/run.mjs --record-acceptance --tag "$TAG" --by Ulrich \
  --drive confirmed --judgment accepted --note-file "$NOTE"
node scripts/e2e/run.mjs --record-manifest --tag "$TAG" --manifest "$MANIFEST" \
  && node scripts/e2e/run.mjs --check-manifest "$TAG" \
  && node scripts/e2e/run.mjs --verdict "$TAG" \
  && echo "PASS EPIC-025"
```

Hermetic coverage required beyond the Proof:

- `--check-manifest` fails when the manifest scenario ids are not the seven declared ids in the declared order. The failure names the first position that differs.
- `--check-manifest` fails when a `bundle.json` carries a `tag` other than the run tag, or a `scenarioId` other than the id the manifest names. Both fixtures copy a real bundle to the wrong path.
- `--check-manifest` fails when a recorded bundle digest differs from the file on disk, and it fails when the file is absent.
- `--check-manifest` fails on fewer than six checklist rows, on an unanswered row, and on a `rejected` row with an empty note. Each case is asserted by itself.
- `--check-manifest` fails on an absent report, on a zero-byte report, and on a report whose digest differs from the recorded one.
- `--check-manifest` fails when a finding whose id starts with `B` names no fix epic.
- `--check-manifest` fails when the manifest outcome is `passed` while a bundle is not `passed`, and when it is `passed` while a checklist row is `rejected`.
- The manifest serialization is byte-exact: one fixture asserts the whole file content, and the key order is asserted against the declared order.
- The manifest passes `redact`, asserted with a token in a finding description and in a checklist note.
- The `--check-manifest` exit status comes from `exitCodeFor` at `scripts/e2e/lib/main.ts:460`, asserted per runner code, so this epic adds no exit code.
- The report names every bundle by path and digest, and it modifies no bundle.
- The report records the `--check-manifest` and `--verdict` commands with their exit status, and the outcome it states agrees with both.
- A `blocked` outcome exits `2` or `3`, and a `failed` outcome exits `1`, so a stopped run never reads as a pass and never reads as a defect.
- Seven bundles carry the tag. A run that misses one exits non-zero on the scenario axis, which is the EPIC 020 obligation above.
- A missing group prerequisite reports `unavailable` for that group, writes no passing bundle, and leaves the other groups running. Podman absent, stopped or below the pinned version never skips.
- A failing scenario does not stop the scenarios after it, and each one still writes a bundle.
- Every bundle, the verify record, the acceptance record and the manifest name one commit under test.
- The rehearsal passes `--scenarios-only` and the full verdict still fails until the gate is signed.
- The report holds no token, no credential and no secret, in the commands, the logs and the diagnostics. Each harness actor token is checked absent as well as the configured token.
- No file under `src/` and no file under `docs/proposal/` changes during this epic, asserted by `git status` against the commit under test. The three files this epic writes are `scripts/e2e/lib/record/manifest.ts`, `scripts/e2e/lib/record/manifest.test.ts` and `.claude/commands/e2e.md`, plus the `scripts/e2e/lib/main.ts` option pair.
