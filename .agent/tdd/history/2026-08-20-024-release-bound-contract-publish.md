---
epic: .agent/plan/epics/024-release-bound-contract-publish.md
opened: 2026-08-20
opener: test-engineer
base-ref: 22fc7984c6ae0e998c777beda728f7218a24962f
---

# Implementation cycle — 024-release-bound-contract-publish

Pulled from EPIC: `.agent/plan/epics/024-release-bound-contract-publish.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/version.test.ts \
>   scripts/release-gate.test.ts \
>   scripts/publish-contract.test.ts \
>   && echo "PASS EPIC-024"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - **Every gate verdict, against a fact object.** Clean tree with a matching tag returns
>   `{ ok: true, tag: "v27.8.1" }`. Clean tree with no tag returns `untagged-commit`. Clean tree with a
>   tag that does not match the version returns `untagged-commit`. Dirty tree with a matching tag
>   returns `dirty-tree`. Dirty tree with `unreleased: true` still returns `dirty-tree`, which is D4's
>   asymmetry asserted. Clean tree, no tag, `unreleased: true` returns `{ ok: true, tag: null }`.
> - **The dirty refusal wins over the tag refusal.** A dirty and untagged tree returns `dirty-tree`, so
>   the message a human reads names the state they can fix first. Asserted by name, not by truthiness.
> - **A commit carrying several tags.** Facts with `tags: ["nightly", "v27.8.1"]` pass, and facts with
>   `tags: ["v27.8.0", "nightly"]` against version `27.8.1` refuse. The tag set is searched, never
>   indexed at zero.
> - **The refusal reaches the process.** The CLI subprocess test asserts exit code `2` and a stderr
>   message naming `dirty-tree`, driven by pointing the script at a temporary directory from a tree the
>   test makes dirty by writing one file into it. The file is removed in an `after` hook, following the
>   `mkdtempSync` plus `rmSync` pattern of `publish-contract.test.ts:46-49`.
> - **The manifest key order.** The five keys are `["version","commit","tag","features","operations"]`,
>   asserted on the parsed object's `Object.keys` and on the raw JSON text, so a serializer that emits
>   the right values in the wrong order fails.
> - **`dirty` is gone.** The raw manifest text contains no `dirty`, asserted the way `:130-135` already
>   asserts the absence of `generatedAt`.
> - **Determinism survives.** Two publishes with the same `commit` and the same `tag` produce
>   byte-identical output, which is the assertion `publish-contract.test.ts:184-209` already makes with
>   `dirty` and which now runs with `tag`.
> - **A development artifact is self-identifying.** A publish with `--unreleased` writes `tag: null`,
>   and its manifest differs in bytes from a release publish of the same commit. This is the shape of
>   the assertion at `:212-231`, retargeted from `dirty` to `tag`.
> - **The gate compares the tag against `KANTHORD_VERSION`.** Asserted by name, so the existing parity
>   test at `src/domain/version.test.ts:12-14` carries the `package.json` half and a version bump in one
>   file alone still fails `npm run verify`. This epic adds no second parity assertion.
> - **The emitted documents are unchanged.** The example count assertion at `publish-contract.test.ts:92`
>   and the per-feature operation set assertions at `:71-88` pass unedited, proving the epic changed the
>   manifest and nothing else.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — the release gate as a pure function · 01-release-gate-pure-function

**Cycle.** RED for Task `01-release-gate-pure-function` (`scripts/release-gate.test.ts`).
**Test written.**

- file: `scripts/release-gate.test.ts` (new) — suite: `scripts/release-gate` — methods: `accepts a clean tree with the matching release tag`, `refuses a clean tree with no release tag`, `refuses a clean tree with a tag for another version`, `accepts no tag for an explicitly unreleased clean tree`, `refuses a dirty tree with the matching release tag`, `refuses a dirty tree in unreleased mode`, `names dirty-tree when a dirty tree is also untagged`, `accepts the matching tag among several tags`, `refuses several tags without the matching release tag`
- file: `src/domain/layout.test.ts` (edited) — suite: `src/domain/layout.test` — method: `no file under scripts/ is collected by the default test runner, except the daemon-backed verify step, the contract-publish script and the EPIC 011 e2e runner's own unit tests`
- asserts: every release verdict case returns the exact whole verdict object, including dirty-tree precedence and unreleased null tagging
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/scripts/release-gate.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/scripts/release-gate.test.ts`
- stub probe: `scripts/release-gate.ts` — clean
  **Open to Software Engineer.**
- `scripts/release-gate.ts`: exports `ReleaseFacts`, `ReleaseRefusal`, `ReleaseVerdict`, and `releaseVerdict(facts: ReleaseFacts, version: string, unreleased: boolean): ReleaseVerdict`

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — release-bound-contract-publish · The release gate as a pure function

**Cycle.** GREEN+REFACTOR for `scripts/release-gate.test.ts`.
**Files changed.**

- `scripts/release-gate.ts` (new) — `ReleaseFacts`, `ReleaseRefusal`, `ReleaseVerdict`, and `releaseVerdict`
  **Seam (GREEN).** The pure function checks dirty state first, then unreleased mode, then the exact version tag.
  **Refactor.** No named refactor; the implementation matches the story directly.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the story requires no imports, subprocesses, file reads, default export, class, or mutable state.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — release-bound-contract-publish · blocked before next dispatch

**Cycle.** Confirmed GREEN for Task `01-release-gate-pure-function`; blocked before the combined next unit (`02-facts-reader` + `03-manifest-record` + `04-cli-entry-point`).
**Prior GREEN.**

- handoff gate: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- test command: `npm test` — exit 0 — `ℹ tests 4868`, `ℹ pass 4868`, `ℹ fail 0`
  **Open to Human.**
- B1 - status:OPEN - action:YES - EPIC 024 planning amendments - fix: amend D4, D5 and the hermetic process-refusal requirement named by Story 4 before dispatch - why: Story 4 is marked BLOCKED, and Stories 2, 3 and 4 must dispatch as one unit while the current EPIC still contradicts Story 4.

ATTEMPT-FAILED: 02-facts-reader — the required Stories 2–4 dispatch unit remains blocked by Story 4's unresolved EPIC amendments

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — release-bound-contract-publish · blocked combined dispatch

**Cycle.** Blocked for Task `02-facts-reader`.
**Files changed.**

- None — Story 4 blocks the Stories 2–4 dispatch unit.
  **Blocker.**
- B1 - status:OPEN - action:YES - EPIC 024 planning amendments - Story 4 contradicts the EPIC - fix: amend D4, D5 and the hermetic process-refusal requirement before dispatch - why: production work must follow one coherent specification.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- OPEN: Human action is required before the next production implementation turn.

ATTEMPT-FAILED: 02-facts-reader — the required Stories 2–4 dispatch unit remains blocked by Story 4's unresolved EPIC amendments

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — release-bound-contract-publish · blocked before next dispatch

**Cycle.** Blocked before Task `02-facts-reader`; Stories 2–4 remain one dispatch unit.
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- None. Story 4 remains blocked by its unresolved EPIC amendments.
  **Open to Human.**
- B1 - status:OPEN - action:YES - EPIC 024 planning amendments - description: Story 4 still requires amendments to D4, D5 and the hermetic process-refusal requirement - fix: amend EPIC 024 before dispatching Stories 2–4 - why: the locked dispatch order requires one coherent specification before the next Task can start

ATTEMPT-FAILED: 02-facts-reader — Stories 2–4 remain blocked by unresolved EPIC amendments

END: TEST-ENGINEER

## HUMAN — 024-release-bound-contract-publish · the EPIC amendments are applied

**Cycle.** Resolve B1, which failed Task `02-facts-reader` three times. No production file changed.
**Root cause.** A planning contradiction, not a code defect. The EPIC ordered
`publish-contract.test.ts:55-62` to keep its subprocess invocation and to require a clean working
tree. The dirty check applies in both modes, so that test can never pass on a developer tree. Story 4
named the contradiction and both engineers correctly refused to implement two specifications.
**B1 — EPIC 024 planning amendments — RESOLVED by amendment.**

- `.agent/plan/epics/024-release-bound-contract-publish.md` D4, last paragraph — the instruction that the invocation gains `--unreleased` and that the real tree must be clean is deleted. The invocation becomes a direct `publishContract` call with `tag: null`. The paragraph now states the rule: no test in `npm run verify` requires a clean checkout.
- `.agent/plan/epics/024-release-bound-contract-publish.md` D5 — the reader is `readReleaseFacts(repositoryRoot: string)`. The three git reads pass `{ cwd: repositoryRoot, encoding: "utf8" }`, and the caller resolves `repositoryRoot` from `import.meta.url`, never from `process.cwd()`. The paragraph names the provenance hole a `process.cwd()` binding opens.
- `.agent/plan/epics/024-release-bound-contract-publish.md` hermetic coverage — "The refusal reaches the process" is replaced by "The refusal is a pure decision". `cliDecision(argv, facts, version)` is asserted per case against a fact object, exit code and stderr are one `switch`, and one subprocess test covers the unknown-flag usage path on any working tree.
- `.agent/plan/epics/024-release-bound-contract-publish.md` Stories, the CLI entry point bullet — it now names `cliDecision`, the hoisted self-publish guard and the direct library call, in place of the `--unreleased` subprocess edit it ordered before.
- `.agent/plan/stories/024-release-bound-contract-publish/04-cli-entry-point.md` — the `BLOCKED` banner is removed, and the Verify section cites the new bullet name.
- `.agent/plan/stories/024-release-bound-contract-publish/index.md` — the "Dispatch is blocked" paragraph is removed.
- Story 2 needed no edit. It already carries the `readReleaseFacts(repositoryRoot: string)` signature and the `cwd` constraint that D5 now states.
  **Verification.**
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Open.**
- The `index.md` fact that D6 cites the wrong file is pre-existing and is not one of the three amendments. It stays open and blocks nothing.

RESOLVED: 02-facts-reader — the EPIC is coherent; the Stories 2–4 dispatch unit is unblocked.

END: HUMAN

## TEST-ENGINEER — release-bound-contract-publish · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task: `02-facts-reader`.
**Story file.** `.agent/plan/stories/024-release-bound-contract-publish/02-facts-reader.md`
**Tasks forwarded to Software Engineer.**

- `02-facts-reader`: `scripts/release-facts.ts` and `scripts/publish-contract.ts` — implement the facts-reader change as part of the Stories 2–4 dispatch unit.
  **No RED phase.** Coverage owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR per the Story file's Action sections.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — release-bound-contract-publish · Stories 2–4 release-bound publish

**Cycle.** GREEN+REFACTOR for Tasks: `02-facts-reader`, `03-manifest-record`, `04-cli-entry-point`.
**Files changed.**

- `scripts/release-facts.ts` (new) — `readReleaseFacts(repositoryRoot: string)` with three repository-bound git reads.
- `scripts/release-gate.ts` (edited) — pure `CliDecision` and `cliDecision(argv, facts, version)`.
- `scripts/publish-contract.ts` (edited) — `tag` manifest input, hoisted self-publish guard and gated direct publish call.
  **Seam (GREEN).** The CLI reads source-tree facts, applies the pure gate, then publishes only an accepted tag decision.
  **Refactor.** Hoisted `refusesSelfPublish`, moved git reads into `readReleaseFacts`, and centralized CLI outcomes in `cliDecision`.
  **Build check.**
- typecheck: FAIL — `scripts/publish-contract.test.ts` still passes `dirty`; the Story 3 `tag` input requires test-engineer updates.
  **Open.**
- OPEN: `scripts/publish-contract.test.ts` — replace the five `dirty` publish inputs with the Story 3 `tag` inputs; this lane cannot edit tests.

ATTEMPT-FAILED: 02-facts-reader — typecheck is blocked by stale `PublishInput` calls in `scripts/publish-contract.test.ts`

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — release-bound-contract-publish · Stories 2–4 confirmation and Story 5 GREEN-only Tasks

**Cycle.** Confirmed GREEN for Tasks `02-facts-reader`, `03-manifest-record`, and `04-cli-entry-point`; GREEN-ONLY pass-through for Task `05-proposal-records-the-release-rule`.
**Test written.**

- file: `scripts/publish-contract.test.ts` (edited) — suite: `scripts/publish-contract` — methods: `writes the master document, feature documents and examples`, `the manifest carries publication metadata and the operation list`, `the manifest carries no timestamp`, `generation is byte-identical across two runs`, `the manifest records an unreleased artifact`, `a released manifest and an unreleased manifest of the same commit differ`, `clears a stale file from a previous publication`, `refuses an unknown flag`
- file: `scripts/release-gate.test.ts` (edited) — suite: `scripts/release-gate` — methods: `chooses a released publish`, `chooses an unreleased publish with the flag first`, `chooses an unreleased publish with the flag last`, `refuses a dirty released publish`, `refuses a dirty unreleased publish`, `refuses an untagged released publish`, `returns usage for no arguments`, `returns usage for an unreleased flag without a directory`, `returns usage for an empty output directory`, `returns usage for an unknown flag`, `returns usage for two output directories`
- asserts: publication tests use `tag`, direct library calls, ordered manifest keys, null and release tags, unchanged non-manifest bytes, and exact unknown-flag usage; CLI tests assert every `cliDecision` result
  **Verification.**
- handoff: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- test command: `npm test` — exit 0 — `ℹ tests 4881`, `ℹ pass 4881`, `ℹ fail 0`
  **Story file.** `.agent/plan/stories/024-release-bound-contract-publish/05-proposal-records-the-release-rule.md`
  **Tasks forwarded to Software Engineer.**
- `05-proposal-records-the-release-rule`: `docs/proposal/api/README.md` and `docs/proposal/api/new-decisions.md` — record the release tag, refusal, manifest pin, and manual release rules
  **No RED phase.** Coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- `docs/proposal/api/README.md` and `docs/proposal/api/new-decisions.md` — implement GREEN+REFACTOR per the Story file's Action sections

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — release-bound-contract-publish · proposal records the release rule

**Cycle.** Blocked for Task `05-proposal-records-the-release-rule`.
**Files changed.**

- None — the forwarded inputs are locked `docs/proposal` planning files outside this lane.
  **Blocker.**
- B1 - status:OPEN - action:YES - proposal release-rule records - edit `docs/proposal/api/README.md` and `docs/proposal/api/new-decisions.md` per Story 5 - fix: have the test-engineer or human apply the required proposal text - why: the software-engineer lane cannot edit `docs/proposal/**`.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- OPEN: No production implementation is possible for Story 5 because both required input files are locked planning files.

ATTEMPT-FAILED: 05-proposal-records-the-release-rule — forwarded docs/proposal files are locked planning files outside the software-engineer lane

END: SOFTWARE-ENGINEER

## HUMAN — 024-release-bound-contract-publish · review findings applied

**Cycle.** Apply every finding of the epic review: B1, B2, S1, S2 and S3. Story 5 is implemented in
the human lane, because `docs/proposal/**` is a locked planning file.
**B1 — Story 5 was never implemented — FIXED.**

- `docs/proposal/api/README.md` — a new `### The release gate` section follows the publication paragraph and precedes `## Domains`. It states the `v<version>` tag convention, the two refusals with their exit code, the dirty-first precedence, the five manifest keys, the `--unreleased` asymmetry, the client pin rule and the manual release step.
- `docs/proposal/api/new-decisions.md:11` — the `openapi.yaml` bullet now ends with the refusals, the manifest tag and the `--unreleased` rule, and it links `README.md`.
- `.agent/plan/stories/024-release-bound-contract-publish/05-proposal-records-the-release-rule.md` — a banner records that the human lane applies this story, so the next dispatch does not forward it to the software-engineer lane again.
  **B2 — the client closure condition — FIXED in `kanthord-apps`.**
- `docs/api/blockers.md` — the `### E4` section is deleted, an `E4` row joins the "Decided, delivered, and removed" table in ID order, and the closing line reads `E11` alone.
- `docs/api/README.md` — the provenance rule is now "pin an artifact whose `tag` is not `null`" in place of the `dirty: false` rule, and it records that the snapshot in that commit predates the release gate. The refresh section names both refusals, their exit code and the `--unreleased` artifact the client must not pin. The document table row names the release tag.
  **S1 — usage required a git read — FIXED.**
- `scripts/release-gate.ts` — the argument parse is extracted into the pure `parseArguments(argv): CliArguments`, and `cliDecision` calls it. No behaviour of `cliDecision` changed.
- `scripts/publish-contract.ts` — the CLI calls `parseArguments` first and exits `2` with the usage line before it reads a release fact. A tree with no `.git` now reports usage rather than a stack trace.
- `scripts/release-gate.test.ts` — three `parseArguments` subtests: the plain output directory, both `--unreleased` positions, and every usage case, each asserted whole with no fact object in the call.
- `.agent/plan/epics/024-release-bound-contract-publish.md` D5 and the hermetic bullet, and Story 4 — both record the parse-before-read order and the new function.
  **S2 — the same path resolved twice — FIXED.**
- `scripts/publish-contract.ts` — `refusesSelfPublish` takes an already resolved path. `publishContract` and the CLI each resolve once and pass the result. Story 4 carries the amended signature.
  **S3 — D6 cited the wrong file — FIXED.**
- `.agent/plan/epics/024-release-bound-contract-publish.md` D6 — `publish-contract.test.ts:71-88` validates the feature slices, and `src/http/contract/openapi.test.ts:457-460` validates the master. The conclusion is unchanged.
  **Verification.**
- command: `npm run verify` — exit 0 — `ℹ tests 4884`, `ℹ pass 4884`, `ℹ fail 0`, run on a dirty working tree.
- command: `node --test test/helpers/proposal.test.ts` — exit 0 — 4 pass. The new README heading does not break the proposal parse.
- command: the EPIC Proof block — exit 0.
- CLI, real dirty tree: `--unreleased <dir>` writes `dirty-tree` and exits `2`; no arguments, an unknown flag and two directories each write the usage line and exit `2`; `.` writes the repository refusal and exits `2`. A refused run leaves the output directory empty.
- CLI, clean tagged copy of the tree: a release publish exits `0`, writes nothing to stdout and records `"tag": "v27.8.1"`; `--unreleased` exits `0`, writes the notice to stderr and records `"tag": null`; the same tree with the tag deleted writes `untagged-commit` and exits `2`.
- CLI, copy of the tree with no `.git`: no arguments writes the usage line and exits `2`.
  **Open.**
- None in this repository. The `kanthord-apps` edits are uncommitted in the submodule working tree, and the contract snapshot at `docs/api/contract/manifest.json` is deliberately unchanged: it is refreshed by a release publish, not by hand.

IMPLEMENTATION_READY_FOR_REVIEW: 024-release-bound-contract-publish — Stories 1 to 5 are implemented and every review finding is applied.

END: HUMAN

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- `npm run verify` → exit 0; `ℹ tests 4884`, `ℹ pass 4884`, `ℹ fail 0`.
- `npm run typecheck` → exit 0.
- `npm test` → exit 0; `ℹ tests 4884`, `ℹ pass 4884`, `ℹ fail 0`.
  **Proof.**
- command: `node --test src/domain/version.test.ts scripts/release-gate.test.ts scripts/publish-contract.test.ts && echo "PASS EPIC-024"` → exit 0
- real output:
  ```
  ℹ tests 43
  ℹ suites 1
  ℹ pass 43
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  PASS EPIC-024
  ```
- exact success string: "PASS EPIC-024"
  **Tasks closed.** 5 across 5 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/version.test.ts scripts/release-gate.test.ts scripts/publish-contract.test.ts && echo "PASS EPIC-024") — "PASS EPIC-024"
- stories: 5/5 complete
- date: 2026-08-20
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
