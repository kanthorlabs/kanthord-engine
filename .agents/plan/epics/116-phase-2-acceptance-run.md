# EPIC 116 — Phase 2 acceptance run

Status: **ready**.

## Goal

Phase 2 closes on evidence. A coding agent runs every declared phase-2 scenario against the assembled product and reports the run green, a human then drives the exit criteria of `docs/proposal/phase-2/README.md` and signs them, and one verdict points at the P2-E4 bundle.

The verdict has two axes. The scenario axis is machine-checked: every declared scenario, the regression suite, and one commit across them. The acceptance axis is the human confirmation: the drive, and the judgment no oracle can assert. Phase 2 exits on both.

This epic exists because a phase can hold four green scenarios and no decision. EPIC 115 makes each scenario runnable. Nothing makes the run happen once, in order, with the live scenario on a real provider account, and with a report that opens a fix epic for each blocker.

## Non-goals

- **No production code, and no `node:test` case.** This epic writes a report and one command document. A defect it finds becomes a separate fix epic, because a fix inside an acceptance run destroys the evidence the run exists to produce.
- **No oracle.** EPIC 115 owns every oracle. A run story names a scenario id and the command that runs it, and it asserts nothing of its own. Two statements of one oracle disagree eventually.
- **No new scenario.** `docs/proposal/phase-2/README.md` declares which scenarios exist. A gap found here becomes a proposal amendment, then an EPIC 115 story. It never becomes a story in this epic.
- **No runner change.** The declared id set per phase, the `--phase` option, the live bounds, the fake agent, the fake reviewer, the hidden oracle, the cleanup path and the bundle format belong to EPIC 115. This epic consumes them, and it adds no option to `scripts/e2e/run.mjs`.
- **No product capability.** EPIC 101 to EPIC 114 own every capability the scenarios drive. A missing capability is a blocker against the epic that owns it.
- **No merge of bundles.** A bundle is immutable evidence. The report references each bundle by directory path and by one file manifest.
- **Nothing is committed.** `docs/proposal/README.md` says a run writes an evidence bundle and not a `PASS` marker in the repository. `.data/acceptance-*/` and `.agents/acceptance/` are ignored. A committed bundle would make one redaction defect permanent, and a live bundle carries provider usage.

## The driver

`/work` cannot drive this epic, because there is no failing test to write and no production code to make pass. `.claude/commands/e2e.md` drives it, and a human or a coding agent runs that command against phase 2. The command executes scenario ids and writes the report; it defines no scenario and restates no oracle.

## The story kinds

Three kinds of story, because one task shape does not fit all three.

| Kind             | Stories                                                        | Shape                                     |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------- |
| frame            | the run frame; the driver document; the report and the verdict | it creates and reads run state            |
| scenario run     | the product loop; the parked task; the safety gate; the exit   | the five tasks below                      |
| human acceptance | the rehearsal and the gate                                     | a drive, a judgment and one signed record |

## The task shape

Every scenario run story carries the same five tasks, so a human and a coding agent execute one procedure.

| Task    | Meaning                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| setup   | prove the prerequisites, then arrange the host state the scenario needs              |
| seed    | supply the scenario data, or prove the absence that the scenario needs               |
| run     | invoke the EPIC 115 command for the scenario id, and nothing else                    |
| cleanup | confirm the runner released every resource, on the failure path and the success path |
| record  | append the bundle reference, the outcome, and every finding to the report            |

A scenario with no data to seed still carries a seed task, and that task proves the absence.

## The continuation policy

A deterministic scenario that fails on the product records its outcome, and the run continues to the next deterministic scenario. The epic exists to group every finding by root cause and to open one fix epic per blocker, and a run that stops at the first defect returns one finding and three unknowns.

Two exceptions.

- A prerequisite failure reports `unavailable`, and it stops the run, because a scenario that cannot start proves nothing about the product and the next scenario shares the same prerequisite.
- P2-E4 never starts while a deterministic bundle reports anything other than `passed`. P2-E4 spends money on a real provider account, and a live run against a known defect buys one more copy of that defect. The stop is a cost gate, it is a command and not a comment, and the report states it as `blocked`, never as a pass.

## Stories

- **The run frame** — one run tag from `node scripts/e2e/run.mjs --mint-tag`, an isolated run directory `.data/acceptance-<tag>/`, and a report at `.agents/acceptance/<tag>/report.md`. The runner mints the tag, because a shell timestamp is not portable and a one-second timestamp collides between two parallel invocations. Tag reuse per scenario id is refused, so a rerun of one id is a new tag, while a later id joins the tag it belongs to. The tag reaches every invocation as an explicit argument; an exported variable that no command receives produces bundles the report cannot name. `node scripts/e2e/run.mjs --record-verify --tag <tag>` runs the regression suite and records it under the same tag, because `docs/proposal/README.md` names two kinds of proof and the phase exits on both. **The report records one file manifest per bundle, and no other digest.** The manifest is the `readonly HashRecord[]` that `hashFixtures` of `scripts/e2e/lib/bundle.ts` line 285 returns over `.data/acceptance-<tag>/<id>/`: one row per file, the path relative to that directory with `/` separators, the `sha256` hex of the bytes, sorted bytewise by path through the existing `byPathBytes`. A single `bundle.json` digest is not enough, because `documents/` and `logs/` hold evidence outside that file, and a tree digest names no file a human can open. No new function appears. The report also carries the commit under test, the proposal revision, the verify record, the acceptance record, the findings, and one outcome of `passed`, `blocked` or `failed`. A `blocked` outcome is never reported as a pass.

- **The driver document covers phase 2** — `.claude/commands/e2e.md` says it drives EPIC 012, it lists the four phase-1 ids inline, and its verdict and acceptance commands carry no phase. `docs/proposal/README.md` line 40 requires one procedure for a human and for a coding agent, so a phase-2 run cannot use a phase-1 document plus a spoken difference. This story edits that one file: it drives EPIC 012 for phase 1 and EPIC 116 for phase 2, it reads the declared id set from `docs/proposal/<phase>/README.md` and lists both sets, and every `--verdict` and `--record-acceptance` invocation carries `--phase <n>`, which EPIC 115 owns and defaults to `1`. It gains the cost gate block of the Proof below, and the rule that a `live` id runs only behind that gate. Its exit-code table stays the one table, and this story adds no number to it and copies none out of it. Its forge constraints become operator prerequisites, per the P2-E4 story.

- **Run the product loop — P2-E1** — the mandatory local gate, on the `local` driver and the fixture profile, in `deterministic` mode. Setup proves the pinned `git` binary and builds the artifact from the commit under test. Seed is the objective fixture under `test/e2e/fixtures/`, with the fake agent and the fake reviewer of EPIC 115. Run invokes `node scripts/e2e/run.mjs P2-E1 --tag <tag>`. Cleanup confirms no temporary home, no daemon process, no held home lock and no orphan agent process survive. Record appends the bundle, and the object id chain from the task commit to the fixture remote ref.

- **Run the parked task — P2-E2** — the `local` driver and the fixture profile, in `deterministic` mode. Setup is the P2-E1 setup. Seed is the fixture whose scripted reviewer rejects every attempt. Run invokes `node scripts/e2e/run.mjs P2-E2 --tag <tag>`. Cleanup confirms the same four resources released. Record appends the bundle, and it states that the attempt record in the bundle carries no credential, because the bundle is the artifact a human reads to diagnose from another machine.

- **Run the safety gate — P2-E3** — the `local` driver and the fixture profile, in `deterministic` mode. Setup is the P2-E1 setup, and it proves the fixture remote accepts a non-force push and rejects a non-fast-forward, which is the phase-2 row of the fixture acceptance table in `docs/proposal/README.md`. Seed is the fixture repository the harness advances by writing to the bare repository with the `git` binary. Run invokes `node scripts/e2e/run.mjs P2-E3 --tag <tag>`. Cleanup confirms the same four resources released. Record appends the bundle and the ancestry classification at each step.

- **Run the exit — P2-E4** — the `local` driver, a real provider account and a disposable repository, in `live` mode. It runs last, and the cost gate command decides when it starts. **This run spends money.** It needs one real provider registration with a working credential, and the phase does not exit without it: `docs/proposal/phase-2/README.md` states that the phase blocker is the unproven capacity to do real work, and the three deterministic scenarios prove plumbing. Setup proves the provider credential valid and confirms the EPIC 115 bounds: the maximum attempts, the maximum provider calls, the per-call token cap and the wall-clock timeout. **Three properties of the disposable repository are operator prerequisites, and the report never calls them proofs.** No forge query proves that a repository is throwaway, that no automation writes to it, or that no second writer pushes during the run, because a ref read reports one instant and not an interval. The operator therefore records three exact lines in the report, each naming the repository and the operator: `operator: throwaway confirmed <repository>`, `operator: no-automation confirmed <repository>` and `operator: no-second-writer confirmed <repository>`. A missing product prerequisite fails the run as unavailable and never skips. Seed is the disposable repository and the one-task plan of `test/e2e/fixtures/p2-e4/plan/`. **The hidden oracle stays in the kanthord checkout, and the model is EPIC 115's, restated and not amended.** `test/e2e/fixtures/p2-e4/oracle/hidden.test.mjs` is never pushed to the disposable origin, never delivered into the daemon home and never written into the objective workspace; the runner copies it into one `mkdtemp` judge clone of the landed object id after the work lands, and runs it there. The claim the record carries is the EPIC 115 claim, at the EPIC 115 scope: the oracle text reached no recorded prompt and no recorded prompt source of this run. It is not a claim that no tool call could read the file. Run invokes `KANTHORD_E2E_LIVE=1 node scripts/e2e/run.mjs P2-E4 --tag <tag>`, once. There is no automatic rerun: a live failure is evidence about that run, and a second run costs money and proves nothing about the first. Cleanup removes the temporary home, the credential file, the daemon process and the agent process tree. Record appends the bundle, the provider, the model, the usage, the prompt hashes, the run and attempt ids, and the hidden test output. This is the bundle the phase exits by pointing at. No phase-2 scenario crosses the VPN: `docs/proposal/README.md` puts every `deployment` scenario in phase 3.

- **The rehearsal** — a coding agent runs P2-E1, P2-E2 and P2-E3 and the verify record under one tag, and reports the three bundle outcomes, the verify exit status and the cost gate exit status. The rehearsal is repeatable and unattended, because no deterministic scenario pauses for a human and none reaches a provider. It stops short of `--scenarios-only`, because that command needs a bundle for every declared id and P2-E4 spends money. It never closes the phase. The rehearsal exists so the exit run and the human gate meet a product that already works, and so the human drives the same CLI and the same API the rehearsal drove.

- **The human gate** — Ulrich drives the exit criteria of `docs/proposal/phase-2/README.md` himself, through the CLI and the API, on the commit under test: he registers a provider, authors one objective with two tasks, runs it, reads the attempt record of every task, approves, and sees the work reach remote origin. He then judges the three subjects that journey needs and no oracle asserts: whether onboarding reaches a working daemon from nothing, whether the attempt record of a task is enough to diagnose it from another machine, and whether the approval evidence is enough to approve on. **`kanthord profile verify` is not judged here.** `docs/proposal/phase-2/README.md` line 33 states that it is manual and that it blocks nothing, so a human judgment on it would make it a phase gate. One invocation of `node scripts/e2e/run.mjs --record-acceptance --tag <tag> --phase 2` signs the drive and the judgment. This is not an oracle and not a scenario, and it is not advisory either: it is the acceptance axis, and the phase does not exit without it.

- **The report and the verdict** — findings group by root cause. A group takes the position of the first scenario it was observed in, in the `scenarioIdsByPhase[2]` order of EPIC 115, and a finding inside a group takes observation order. Blockers number `B1` upward and suggestions number `S1` upward, each from `1`, in that one order; an id is never renumbered and never reused. Each row is `<B1/S1> - action:<YES/NO> - <name> - <description>`, and **every blocker row ends with one more field, ` - fix: .agents/plan/epics/<number>-<slug>.md`**, because free-form prose carries no identifier a command can check. A suggestion row carries no `fix` field. The blocker check of the Proof reads each named path, and phase 2 stays open while the file exists and its status is not `PASS`. The outcome is not asserted in prose: `node scripts/e2e/run.mjs --verdict <tag> --phase 2` checks both axes against the declared phase-2 id set and returns the exit status, and the report records that command and its exit status. EPIC 115 owns the phase-scoped id set the verdict reads. The scenario axis needs a bundle per declared scenario, all `passed`, a verify record with exit status zero, and one commit across every record. The acceptance axis needs a signed record on that same commit. Closure is three artifacts and nothing else: the signed report at `.agents/acceptance/<tag>/report.md` with outcome `passed`, the zero exit status of `--verdict <tag> --phase 2`, and the P2-E4 bundle it references. This epic file records no marker, because `docs/proposal/README.md` gives closure to the evidence and not to the repository.

## Verification Gate

Gates: `npm run verify`

Proof: this epic ships no code, so the Proof is the run and the report it produced. The exit run is part of it, because the epic exists to produce the exit verdict.

Each deterministic scenario runs on its own line, and a failing line does not stop the next one. The
cost gate reads exactly the three deterministic bundles, and P2-E4 chains behind it.

```bash
TAG=$(node scripts/e2e/run.mjs --mint-tag)
node scripts/e2e/run.mjs P2-E1 --tag "$TAG"
node scripts/e2e/run.mjs P2-E2 --tag "$TAG"
node scripts/e2e/run.mjs P2-E3 --tag "$TAG"
node scripts/e2e/run.mjs --record-verify --tag "$TAG"
node --input-type=module --eval '
import { readFile } from "node:fs/promises";
const tag = process.argv[1];
const ids = ["P2-E1", "P2-E2", "P2-E3"];
const rows = [];
for (const id of ids) {
  const path = `.data/acceptance-${tag}/${id}/bundle.json`;
  rows.push(`${id}=${JSON.parse(await readFile(path, "utf8")).outcome}`);
}
process.stdout.write(`cost-gate ${rows.join(" ")}\n`);
process.exit(rows.every((row) => row.endsWith("=passed")) ? 0 : 1);
' -- "$TAG" \
  && KANTHORD_E2E_LIVE=1 node scripts/e2e/run.mjs P2-E4 --tag "$TAG"
node scripts/e2e/run.mjs --verdict "$TAG" --phase 2 --scenarios-only
# the human gate, after the scenario axis is green
node scripts/e2e/run.mjs --record-acceptance --tag "$TAG" --phase 2 --by Ulrich \
  --drive confirmed --judgment accepted --note-file "$NOTE"
node scripts/e2e/run.mjs --verdict "$TAG" --phase 2 \
  && node --input-type=module --eval '
import { readFile } from "node:fs/promises";
const report = await readFile(process.argv[1], "utf8");
const rows = [...report.matchAll(/^- B\d+ - action:(?:YES|NO) - .+ - fix: (\S+\.md)$/gm)];
for (const row of rows) {
  if ((await readFile(row[1], "utf8")).includes("Status: **PASS**")) process.exit(1);
}
process.stdout.write(`open blockers ${rows.length}\n`);
' -- ".agents/acceptance/$TAG/report.md" \
  && echo "PASS EPIC-116"
```

Coverage required beyond the Proof:

- The report names every bundle by directory path and by the `hashFixtures` manifest of that directory,
  and it modifies no bundle.
- The report records the `--verdict` command and its exit status, and the outcome it states agrees with
  the canonical classification of `.claude/commands/e2e.md`, which is the only source of that mapping.
- A missing P2-E4 prerequisite reports unavailable and writes no passing bundle.
- The three operator prerequisites of the disposable repository appear as the three exact confirmation
  lines, named as operator prerequisites and never as assertions.
- A failing deterministic scenario does not stop the deterministic scenarios after it, and each one
  still writes a bundle.
- The cost gate exits non-zero when any of the three deterministic bundles reports other than `passed`,
  and when one of the three bundles is absent, so P2-E4 never starts and the report states the gate as
  the reason.
- P2-E4 starts `run.start` exactly once, which EPIC 115 asserts over the recorded command list of the
  scenario, and the report cites that bundle rather than the absence of a second invocation.
- Every bundle, the verify record and the acceptance record name one commit under test.
- The acceptance record is written under `--phase 2`. `--verdict <tag> --phase 2` accepts it, and
  `--record-acceptance --tag <tag> --phase 1` over that same tag reports `unavailable`, so the record is
  phase-2 scoped and not phase-1 scoped by default.
- The rehearsal reports three bundle outcomes, the verify exit status and the cost gate exit status, and
  it invokes no verdict.
- Every blocker row carries a `fix` path, the blocker check finds each named file, and no named file
  holds `Status: **PASS**` while phase 2 stays open.
- The report holds none of the values the secret registry of `scripts/e2e/lib/redact.ts` holds, and each
  referenced bundle reports its `assertNoDisclosure` result passed, which EPIC 115 asserts byte for byte
  over the bundles and their attached documents.
- `.claude/commands/e2e.md` lists the phase-2 ids, carries `--phase` on every verdict and acceptance
  invocation, and carries the cost gate block.
