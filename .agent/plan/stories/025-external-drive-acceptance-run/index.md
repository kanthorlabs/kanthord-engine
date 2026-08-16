# EPIC 025 — External-drive acceptance run — stories

Epic: `.agent/plan/epics/025-external-drive-acceptance-run.md`
Prereq: EPIC 020 (sequence order). EPIC 020 supplies the three `P1B-*` scenario files, the `three-objective` fixture, the widened `ScenarioId`, the widened verdict id set, the proposal declarations and `kanthord event list`. EPIC 016 supplies the amended `journey.ts` ready-frontier oracle. EPIC 019 supplies `attestedObjectId` and `projection` on `node.show`.

A coding agent runs the seven declared scenarios under one tag and writes one machine-readable run manifest; a human then drives the two-client journey, answers six checklist rows and signs one acceptance record; and one verdict, gated by `--check-manifest`, closes the block or opens a fix epic per blocker.

## Dispatch order

Numeric order, `01` to `13`. The epic has three story kinds, and the dispatch splits accordingly.

- **Stories 1 and 2 are a coupled pair.** They are the only code in this epic and they take no verify gate between their members: Story 1 writes the record type and the serializer, Story 2 writes the checker and the runner options, and neither half is independently useful. Story 1 gates on `npx tsc --noEmit` and its own test file; `npm run verify` exits 0 at the close of Story 2.
- **Story 3 is a gate, not work.** It edits no file. It proves the five obligations `025-external-drive-acceptance-run.md:177-183` places on EPIC 013, EPIC 016 and EPIC 020. A false fact stops the epic before six container image builds and one real-forge run are spent against it.
- **Story 4 is independent** of the run and may land beside Stories 1 and 2.
- **Stories 5 to 13 are one run, executed once, in order.** They are not independently repeatable: a re-run after a fix epic lands is a **new tag** and repeats every one of them.

Five ordering facts are load-bearing:

- Story 2 needs Story 1's `declaredScenarioOrder` and `digestOf`.
- Story 3 precedes every run story, because Story 1 does not typecheck until EPIC 020 widens `ScenarioId` at `scripts/e2e/lib/tag.ts:6`, and `P1-E1`, `P1-E4` and `P1-E5` each fail until EPIC 016 amends `journey.ts`.
- Story 6 fixes the order once. Stories 7 to 10 name only their own position in it and restate it nowhere.
- Story 11 precedes Story 12, because the human gate meets a run that already works.
- Story 13 is last. It runs `--check-manifest` and the full `--verdict`.

## Stories

- 1 — the manifest record and its canonical serialization → `01-manifest-record.md`
- 2 — the manifest checker and the runner option pair → `02-manifest-checker-and-options.md`
- 3 — the EPIC 016 and EPIC 020 obligations, verified and not re-landed → `03-precondition-check.md`
- 4 — the `/e2e` command update → `04-e2e-command-update.md`
- 5 — the run frame → `05-run-frame.md`
- 6 — the run order → `06-run-order.md`
- 7 — run the amended phase-1 axis: P1-E1, P1-E2, P1-E4, P1-E5 → `07-phase-1-axis.md`
- 8 — run the single-harness loop: P1B-E1 → `08-run-p1b-e1.md`
- 9 — run the two-client scenario: P1B-E2 → `09-run-p1b-e2.md`
- 10 — run the takeover: P1B-E3 → `10-run-p1b-e3.md`
- 11 — the rehearsal → `11-rehearsal.md`
- 12 — the human gate → `12-human-gate.md`
- 13 — the report and the verdict → `13-report-and-verdict.md`

The EPIC lists eleven Story bullets. Two differences:

- `025-external-drive-acceptance-run.md:125` splits into Story 1 and Story 2, because the record and its serializer are verifiable on their own while the checker and the two runner options are a second, larger surface with its own failure fixtures.
- Story 3 is added. `025-external-drive-acceptance-run.md:177-183` states five obligations on other epics and the epic body depends on all five, but no bullet checks them. The pattern is the one `.agent/plan/stories/019-outcome-report/02-epic-014-precondition-check.md` already uses.

## Settled before this expansion shipped

- **`--record-manifest` refuses a second write for one tag**, with `RunnerError("tag-reused", ...)` and exit `2`. Ulrich decided this on 2026-08-14. It follows `acceptance.ts:96-100`, the only precedent in `scripts/e2e/lib/record/`. The cost is accepted: a corrected checklist row costs a new tag and repeats the whole run. There is no `--force`. Story 2 carries the rule and its tests; no story revisits it.

## Facts (needed for implementation)

- **`serializeAcceptanceRecord`** — `scripts/e2e/lib/record/acceptance.ts:47-61`. Canonicalization is a hand-ordered object literal, then `redact(`${JSON.stringify(ordered, null, 2)}\n`)`. Two-space indent, one trailing newline. This is the template Story 1 mirrors.
- **`redact`** — `scripts/e2e/lib/redact.ts:48-52` is a **module-level singleton over strings**, not injected. `secrets.hold` refuses a secret under eight characters at `:24-32`. There is no object-walking variant.
- **`RunnerErrorCode`** — `scripts/e2e/lib/errors.ts:1-2`: `invalid-argument`, `tag-reused`, `unavailable`, `assertion-failed`. **This epic adds none.**
- **`exitCodeFor`** — `scripts/e2e/lib/main.ts:460-470`, an exhaustive switch with no `default`: `assertion-failed` → 1, `invalid-argument` and `tag-reused` → 2, `unavailable` → 3. A non-`RunnerError` throw returns 4 at `:688,699`.
- **`parseArguments`** — `scripts/e2e/lib/main.ts:87-427`. A manual `while` loop with a flat accumulator, then one guard block per subcommand returning a member of the `Invocation` union at `:79-85`. Boolean flags at `:110-133`; the value-flag allowlist at `:135-147`; the value dispatch at `:154-190`; the orphan-flag sweep at `:345-357`. `tagPattern` is `:55`.
- **`verdict`** — `scripts/e2e/lib/record/verdict.ts:59-204` returns a failure list and never throws. `main.ts:569-584` prints one stderr line per failure and returns `exitCodeFor(failures[0].code)`. Story 2's checker copies both shapes.
- **`RawBundle`** — `scripts/e2e/lib/record/verdict.ts:27` reads `commit` and `outcome` **only**. A bundle copied from another tag or another scenario passes the verdict at the expected path. This is the gap Story 2 closes.
- **`Bundle`** — `scripts/e2e/lib/bundle.ts:39-60` carries `tag` and `scenarioId`, and `serializeBundle` at `:234-259` emits both, so the checker needs no runner change elsewhere.
- **`noteKeys`** — `scripts/e2e/lib/bundle.ts:82-91` is a **closed allowlist of eight names**: `productDigest`, `baseDigest`, `imageId`, `architecture`, `podmanRootless`, `bindAddress`, `daemonNamespace`, `clientNamespace`. `note()` throws `invalid-argument` outside it. **There is no takeover-latency key**, so Story 10 records the latency in the report and not in the bundle.
- **`writeBundle`** — `scripts/e2e/lib/bundle.ts:261-283`. It writes `logs/` only when `bundle.logs` is non-empty at `:272-282`. An absent `logs/` is not a finding.
- **sha256 form** — `scripts/e2e/lib/bundle.ts:299-301` emits **bare lowercase hex**, no `sha256:` prefix. The manifest takes the same form.
- **Tag paths** — `scripts/e2e/lib/tag.ts:15-29`, all relative to `runRoot = ".data"` at `:8`. **There is no `manifest.json` helper and no `bundle.json` helper**; callers hand-build `join(bundleDirectory(tag, id), "bundle.json")` at `acceptance.ts:86` and `verdict.ts:67`. Story 1 puts `manifestRecordPath` in `manifest.ts`, because `025-external-drive-acceptance-run.md:241` fixes the file list and `tag.ts` is not in it.
- **`claimBundleDirectory`** — `scripts/e2e/lib/tag.ts:31-53`. `mkdir(recursive: false)` is the atomic claim; `EEXIST` raises `tag-reused`. It refuses per scenario directory only, so a re-run is a new tag by procedure.
- **A second stale id list** — `scripts/e2e/lib/record/acceptance.ts:63-68` holds its **own** private four-id `knownScenarioIds`, which `020-wiring-and-scenarios.md:77` does not name. It gates only the "tag holds at least one bundle" check at `:83-94`, so a stale list blocks no run in which any phase-1 bundle exists. Story 3 records it as a suggestion and edits it not at all.
- **Test convention under `scripts/e2e/lib/`** — flat `test(...)` from `node:test` with `assert` from `node:assert/strict`. **No `describe` and no `it` anywhere in `scripts/e2e/lib/record/`.** Test names are full sentences.
- **`withTempCwd`** — `scripts/e2e/lib/record/acceptance.test.ts:34-44`. It `mkdtemp`s, `process.chdir`es and restores in `finally`. Because `tag.ts` paths are relative, chdir is what sandboxes them. Story 2 copies it.
- **`walkDigests`** — `scripts/e2e/lib/record/verdict.test.ts:121-148`, an sha256 tree snapshot used by the "modifies no file" tests at `:514` and `:526`. Story 2 copies it.
- **`main.test.ts` is out of scope.** `025-external-drive-acceptance-run.md:241` permits `manifest.ts`, `manifest.test.ts`, `.claude/commands/e2e.md` and the `main.ts` option pair — four things, and `scripts/e2e/lib/main.test.ts` is a fifth. Every parser and exit-status test of Story 2 therefore lives in `manifest.test.ts`, which imports `parseArguments`, `main` and `exitCodeFor` from `../main.ts`.
- **`parseArguments` guard blocks return early.** The `--verdict` block at `scripts/e2e/lib/main.ts:359-380` returns before any block added after it, so a new guard placed at the end is unreachable for `--verdict t --check-manifest t`. Story 2 therefore edits the five **existing** guard blocks to reject the new flags, and its parser tests assert every pair in both argument orders.
- **`JSON.stringify` emits nested keys in construction order.** `serializeAcceptanceRecord` orders a flat record, so a root-only literal was canonical there. The manifest nests, so Story 1's serializer reconstructs `scenarios`, `checklist`, `report` and `findings` element by element. A root-only literal makes two equal manifests digest differently.
- **`npm test` is a bare `node --test`**, so a new `*.test.ts` under `scripts/e2e/lib/` is discovered with no script change. `npm run verify` is `typecheck && test && lint && verify-db-status`.
- **`.claude/commands/e2e.md`** — 190 lines, frontmatter at `1-5`. The EPIC 012 sentence is `:16`; the run lead-in is `:42-44`; the run `sh` block is `:46-54`; the acceptance subjects are `:109-114`; the report checklist is `:128-140`; the exit-code table is `:151-157`. The epic cites `:43-53` and `:151-157`; the exact anchors are these.
- **The phase-1 report precedent** — `.agent/acceptance/20260809215956270-01kzm8ma3e53bm6p04jemtmjr1/report.md`, 67 lines, the section shape Story 13 follows.
- **Ignored paths** — `.gitignore:146` is `.data/acceptance-*/` and `.gitignore:148` is `.agent/acceptance/`. Nothing this epic runs is committed.
