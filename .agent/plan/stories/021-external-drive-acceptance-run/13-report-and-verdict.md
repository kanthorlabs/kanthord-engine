# Story 13 — The report and the verdict

Epic: `.agent/plan/epics/021-external-drive-acceptance-run.md`
Depends on: Story 12. This story is last.

This is the EPIC bullet at `021-external-drive-acceptance-run.md:145`. It writes the report, records the findings, and takes the verdict that closes the block or opens a fix epic.

## Change

### The report

Author `.agent/acceptance/<tag>/report.md` by hand. **No report writer exists**, and the verdict neither creates nor reads it. `--check-manifest` is the only mechanism that binds it to the run.

Follow the phase-1 report at `.agent/acceptance/20260809215956270-01kzm8ma3e53bm6p04jemtmjr1/report.md` section for section, with the phase-1b additions:

- the tag, the commit under test, and the proposal revision from `git log -1 --format=%H -- docs/proposal`;
- a **Scenario Axis** section naming all seven bundles by path and by digest;
- a **Verify Record** section naming `.data/acceptance-<tag>/verify.json`, its digest, the command and its exit status;
- a **Human Acceptance** section naming `.data/acceptance-<tag>/acceptance.json`, its digest, and the six checklist rows with their answers, labelled as judgment;
- a **Findings** section, grouped by root cause;
- a **Verdict** section recording both commands with their exit status, and one outcome.

Record the `P1B-E3` takeover latency here, as diagnostic prose. Record that every token crossed a private container network in cleartext, and claim no transport security.

### The findings

Each finding is one bullet in this exact format:

```text
<B1/S1> - action:<YES/NO> - <name> - <description>
```

Group them by root cause. Copy every blocker into the manifest `findings` array with its `fixEpic`.

### The fix epic numbering

**A fix epic takes the next unused decimal suffix under the epic that owed the defect, and it names the owner in metadata.** A defect in EPIC 018 opens `.agent/plan/epics/018.<n>-<slug>.md`, where `<n>` is the lowest integer that no file under `.agent/plan/epics/` already uses. The file carries a `Fixes: EPIC 018` line beside `Status:`.

**The filename encodes no convention.** The decimal namespace is a general insertion namespace, and `007.5`, `009.5`, `010.5`, `010.6`, `011.1` and `011.2` are insertions rather than fixes. **The metadata line is the only statement of what a fix epic repairs.** A defect that no epic of the block owed opens `021.<n>-<slug>.md` under the same rule.

A blocker opens one fix epic. A suggestion opens none.

### The verdict

```sh
node scripts/e2e/run.mjs --check-manifest "$TAG"
node scripts/e2e/run.mjs --verdict "$TAG"
```

**The outcome is not asserted in prose.** `--check-manifest` checks the procedure and `--verdict` checks both axes. The report records both commands with their exit status, and the outcome it states agrees with both.

## Constraints

- **This epic never repairs what it finds.** A fix inside an acceptance run destroys the evidence the run exists to produce.
- **A bundle is immutable evidence.** Reference a bundle by path and by digest. Never merge one, never edit one and never move one.
- **The report holds no token, no credential and no secret**, in the commands, the logs and the diagnostics. Each harness actor token is checked absent as well as the configured token.
- Edit no file under `src/` and no file under `docs/proposal/`.
- Commit nothing. `.gitignore:146,148` ignores `.data/acceptance-*/` and `.agent/acceptance/`.
- Set the manifest `outcome` to `failed` when any bundle is not `passed` or any checklist row is `rejected`. `--check-manifest` refuses a `passed` outcome over either.

## Verify

- `.agent/acceptance/<tag>/report.md` exists, is non-empty, and names every one of the seven bundles by path and by digest.
- The manifest `report` object names that path, its digest and its byte count, and `--check-manifest` finds all three correct.
- Every finding whose id starts with `B` names a `fixEpic` in the manifest, and one fix epic file exists per blocker with a `Fixes: EPIC <n>` line.
- `node scripts/e2e/run.mjs --check-manifest "$TAG"` exits 0.
- `node scripts/e2e/run.mjs --verdict "$TAG"` exits 0.
- Grep the report and every bundle for the configured token, the master key and each harness actor token; each is absent.
- A `blocked` outcome exits `2` or `3` and a `failed` outcome exits `1`, per the exit-code table at `.claude/commands/e2e.md:151-157`, so a stopped run never reads as a pass and never reads as a defect.
- **The block closes on** a zero exit status from both commands, a `P1B-E2` bundle, a proposal revision and an implementation commit. Any other outcome keeps the block open.
- `git status --porcelain` names no path under `src/` and no path under `docs/proposal/`.
- Proof: `PASS EPIC-021`, lines `214` to `217` of the run block at `021-external-drive-acceptance-run.md:200-218`.
