---
epic: .agents/plan/epics/011-end-to-end-scenarios.md
opened: 2026-08-08
opener: test-engineer
base-ref: 336dceed4cb3d2967932b12481983230b0a272c1
---

# Implementation cycle — 011-end-to-end-scenarios

Pulled from EPIC: `.agents/plan/epics/011-end-to-end-scenarios.md`.

This is the follow-up cycle to `.agents/tdd/history/2026-08-07-011-end-to-end-scenarios.md`.
That cycle closed its 13 `action:YES` reviewer findings and left six `action:NO` findings
recorded as `INFO:`. Five of the six were re-decided as `action:YES` by the human on
2026-08-08 and specified into the Story files. This cycle implements exactly those five, and
nothing else:

- **Story 10** — the anti-vacuity guard. `assertNoDisclosure` refuses on an empty secret
  registry before the seven surfaces; `redact` is declared only in `redact.ts`; the
  `p1-e4.test.ts` argv sweep asserts a non-empty registry before it iterates.
- **Story 09** (was INFO B9 + S3) — `reclaimByLabel` returns a typed per-kind
  `ReclaimReport`, verifies absence by re-listing each kind's label, and never throws on a
  removal failure. `p1-e4.ts` fails closed on a surviving stale resource before it creates
  anything. `main.ts` gains a `--reclaim <tag>` mode that claims no bundle directory and
  writes no bundle.
- **Story 02** (was INFO S7) — the scenario teardown guard moves from a forbidden-substring
  test to an `eslint.config.js` `no-restricted-imports` rule on the
  `scripts/e2e/lib/scenario/**` glob, and `resources.ts` gains `takeTemporaryDirectory` and
  `takeDirectory` as the only tree-removing seam.
- **Story 07** (was INFO S8) — `resolveTools` and `Tools` become generic in the requested
  tool names, so a narrowed call returns a narrowed type.
- **Story 04** (was INFO S9, partial) — the four repository-name translation seams raise an
  explicit invariant error instead of falling back to `?? node.repositoryId`. The
  deduplication half of S9 stays deferred, recorded in `docs/proposal/open-items.md`.

Note for the software-engineer: `eslint.config.js` is on the always-forbidden list. The
Story 02 lint rule is therefore an `OPEN:` to the human, not an edit. Implement the helpers
and the scenario-file changes, and raise the config line as `OPEN:`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 \
>   && node scripts/e2e/run.mjs P1-E4 \
>   && echo "PASS EPIC-011"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - P1-E4 leaves no container, no pod, no Podman network and no volume carrying its run id, after a failing run as well as a passing one.
> - `node scripts/e2e/run.mjs --reclaim <tag>` removes every resource labelled with that tag, reports the outcome per kind, and a subsequent P1-E4 run under a fresh tag passes. The reclaim invocation writes no evidence bundle and claims no bundle directory, because it runs no scenario and asserts nothing about the product.
> - A pre-run reclaim that cannot remove a targeted resource fails the run before the run starts, and names the kind and the id it could not remove.
> - The daemon refuses to start when it binds a non-loopback address with no token configured, which is the EPIC 001 rule proved across a real network boundary.
> - An allow list that does not name the daemon alias produces `403 host-forbidden`, so the allow list is proved to be load-bearing rather than incidental.
> - The `podman` and `ssh` drivers expose one interface, asserted by construction. The scenario profile is the other axis, so a driver swap never silently changes what a scenario claims.
> - The token appears in no `podman inspect` output, no printed command, no config dump and no log, asserted over a deliberately failing run as well as a passing one. Every one of those is an **absence** assertion, so each one carries a non-empty secret registry as a precondition and refuses when the registry is empty. An absence asserted over an empty set is a vacuous pass, and this EPIC produced one for a full cycle.
> - A configured token **file** is not a configured token. Every startup refusal that asks whether a token exists reads the resolved value, so a mode-`0600` empty token file refuses a non-loopback bind exactly as an absent token does. The EPIC 001 rule is about the secret, never about the path.
> - Podman absent, stopped, or below the pinned version fails the gate loudly and names the remedy. It never skips.
>
> P1-E3 needs two reachable hosts, a real repository and a real credential. Podman proves the two-host logic and the deployment mechanism, never the environment, so a P1-E4 pass is not evidence for P1-E3. The phase exits by pointing at a P1-E3 bundle.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — Story 10 (secret handling) · the anti-vacuity guard

**Cycle.** RED for the Story 10 anti-vacuity guard (`scripts/e2e/lib/disclosure.ts`,
`scripts/e2e/lib/disclosure.test.ts`, `scripts/e2e/lib/scenario/p1-e4.test.ts`).

**Test written.**

- file: `scripts/e2e/lib/disclosure.test.ts` (edited)
  - new test `with an empty registry, assertNoDisclosure throws assertion-failed and records
no assertion at all` — asserts `assertNoDisclosure(context, execute, topology)` rejects
    with `RunnerError("assertion-failed", "the secret registry is empty; a disclosure
assertion would be vacuous")` when `secrets.forms()` is empty, and that no assertion is
    recorded (`assertions` stays `[]`). Placed before any test in the file holds a value into
    the module-wide `secrets` registry, so the registry is genuinely empty at that point.
  - new test `redact is declared only in redact.ts` — walks `scripts/e2e/lib/**/*.ts`,
    excludes `redact.ts` and this test file itself (which necessarily names the patterns it
    is searching for inside its own regex literal), and asserts no other file matches
    `function redact`, `const redact =` or `let redact =`.
  - fixed `clean outputs produce eight passing assertions with the exact eight names` — it
    used to build a throwaway local `createSecretRegistry()` that `assertNoDisclosure` never
    reads, so the eight "clean" assertions passed only because the real module-wide
    `secrets` registry happened to be empty at that point (the exact vacuity the guard now
    forbids). It now calls `secrets.hold("clean-run-token-1")` on the module singleton that
    `disclosure.ts` actually consults.
- file: `scripts/e2e/lib/scenario/p1-e4.test.ts` (edited)
  - the argv-sweep test now asserts `secrets.forms().length !== 0` immediately before the
    loop that checks no recorded argv or printed line contains any form, so the sweep can no
    longer pass vacuously against an empty registry.
- asserts: an absence assertion over the secret registry never runs against an empty
  registry — `assertNoDisclosure` refuses closed instead of reporting eight vacuous passes,
  and the one `redact` implementation cannot be shadowed by a second declaration anywhere
  under `scripts/e2e/lib/**`.

**RED proof.**

- command: `node --test scripts/e2e/lib/disclosure.test.ts`
- exit: non-zero — failure:
  ```
  ✖ with an empty registry, assertNoDisclosure throws assertion-failed and records no assertion at all (1.140125ms)
    AssertionError [ERR_ASSERTION]: Missing expected rejection.
        at async TestContext.<anonymous> (file:///Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/scripts/e2e/lib/disclosure.test.ts:127:3)
    ... actual: undefined, operator: 'rejects'
  ```
  9 pass, 1 fail — the failing one is the new empty-registry refusal; `redact is declared
only in redact.ts` already passes today (see stub-probe note below) and the fixed "clean
  outputs" test still passes because it now holds a secret the function actually reads.
- `node --test scripts/e2e/lib/scenario/p1-e4.test.ts`: 5/5 pass — the new non-empty
  precondition is satisfied by the existing fake run, which already holds secrets on every
  path per the Story 10 "hold at creation" rule; this is a hardening assertion, not a new
  seam.
- stub probe: `redact is declared only in redact.ts` passes on the current tree, since no
  second `redact` declaration exists today. Proved sensitivity by temporarily writing a
  scratch file `scripts/e2e/lib/.probe-redact.ts` containing `export const redact = (s:
string) => s;`, re-running the test (it failed, naming `.probe-redact.ts` as the
  offender), then deleting the scratch file and re-running (back to green). No production or
  test file other than `disclosure.test.ts` and `p1-e4.test.ts` was touched by the probe or
  left behind.
- `npm run typecheck`: clean.

**Open to Software Engineer.**

- `scripts/e2e/lib/disclosure.ts` — `assertNoDisclosure(context: ScenarioContext, execute:
PodmanExecutor, topology: Topology): Promise<void>` refuses before touching any of the
  seven surfaces: when `secrets.forms()` (from `scripts/e2e/lib/redact.ts`) is empty, it
  throws `RunnerError("assertion-failed", "the secret registry is empty; a disclosure
assertion would be vacuous")` and calls `context.assert` zero times.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 10 (secret handling) · the anti-vacuity guard

**Cycle.** GREEN for `scripts/e2e/lib/disclosure.test.ts`.
**Files changed.**

- `scripts/e2e/lib/disclosure.ts` (edited) — `assertNoDisclosure` now imports `RunnerError`
  from `./errors.ts` and refuses before touching any of the seven surfaces: when
  `secrets.forms().length === 0` it throws `RunnerError("assertion-failed", "the secret
registry is empty; a disclosure assertion would be vacuous")` without ever calling
  `context.assert`.
  **Seam (GREEN).** The guard sits as the first statement in `assertNoDisclosure`, before the
  `httpLogs` read and every subsequent `context.assert` call, so an empty registry rejects with
  the exact `RunnerError` the test matches and records zero assertions (`assertions` stays
  `[]`).
  **Refactor.** None named for this Task; no other change needed — `redact` is already
  declared only in `redact.ts` and the fixed "clean outputs" test already reads the
  module-wide `secrets` singleton.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `scripts/e2e/lib/errors.ts` already exports `RunnerError` with an
  `"assertion-failed"` code, matching every other refusal site in `scripts/e2e/lib/*.ts`
  (e.g. `bundle.ts`, `redact.ts`).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — Story 09 (P1-E4 hermeticity) · the reclaim contract

**Cycle.** Confirmed GREEN for the Story 10 anti-vacuity guard, then RED for the Story 09
reclaim contract (`scripts/e2e/lib/podman/reclaim.ts`, its `p1-e4.ts` fail-closed caller, and
`main.ts`'s `--reclaim <tag>` mode).

**Confirm GREEN — Story 10.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- command: `node --test scripts/e2e/lib/disclosure.test.ts` — 10/10 pass, including the new
  empty-registry refusal and the fixed "clean outputs" test. Story 10 is closed.

**Test written.**

- file: `scripts/e2e/lib/podman/reclaim.test.ts` (edited — full rewrite of the suite against
  the amended contract)
  - `reclaimByLabel issues the six list commands and the six remove commands, in the exact
order, each carrying the label filter, followed by a re-list` — with every kind holding
    one id, asserts 18 calls total (`list, remove, re-list` per kind) and `report.failed` is
    empty when the re-list comes back clear.
  - `an empty list for every kind issues the six list commands and no remove command, and
resolves { reclaimed: [], failed: [] }` — asserts the exact `ReclaimReport` shape, not a
    bare `[]`.
  - `a stale run: the list commands return ids, the re-list returns empty, and reclaimed
holds { kind, id } for each` — asserted as `{ kind, id }` objects.
  - `a remove that fails once and succeeds on the repeat resolves with the id in reclaimed`.
  - `a remove that exits zero while the re-list still returns the id puts it in failed` — the
    verification case named in the Story: a zero exit is not evidence of absence.
  - `two kinds returning the same id string produce two distinct outcomes, one per kind`.
  - `reclaimByLabel itself never throws for a removal failure; the decision belongs to the
caller` — asserts `assert.doesNotReject` over a scenario whose re-list still returns the
    stale id.
  - the fake executor now tracks per-kind list-call count so the second call (the
    verification re-list) can answer differently from the first, via a `survives` option.
- file: `scripts/e2e/lib/scenario/p1-e4.test.ts` (edited)
  - new test `a stale resource surviving reclaim makes run fail closed before it creates
anything` — a fake `execute` makes `podman volume ls`/`rm` always report one surviving id
    and everything else answer the six-kind label-filter sweep empty; `executeHost` throws on
    any call, so a pass through to provisioning would fail the test for the wrong reason.
    Asserts `runP1E4` rejects with `RunnerError("assertion-failed", …)` whose message names
    both `volume` and the surviving id, and that no `podman run` argv was ever issued.
- file: `scripts/e2e/lib/main.test.ts` (edited)
  - `parseArguments refuses --reclaim combined with a scenario id` and `… combined with
--tag` — each asserts a thrown `RunnerError("invalid-argument", …)`, following the
    existing refusals-table pattern already in this file for `parseArguments`.
  - `--reclaim R1 runs assertPodman and reclaimByLabel for R1, and issues no podman run and
no scenario step` — calls `main(["--reclaim", "R1"], { execute })` with a fake
    `PodmanExecutor` and asserts a `podman version` call, a call carrying
    `label=kanthord-e2e-run=R1`, no `podman run` call, and exit code `0`.
  - `--reclaim R1 creates no directory under .data/` — asserts `existsSync(runDirectory(tag))`
    is `false` both before and after the call.
  - `--reclaim R1 with a non-empty failed returns 1, and with an empty one returns 0`.
  - added `buildReclaimExecute`, a local fake `PodmanExecutor` answering `podman
version`/`info` and the six-kind label-filter list/remove sweep, with an optional stale
    container id so the "non-empty failed" case is reachable without a real Podman.
- asserts: `reclaimByLabel` reports a typed `ReclaimReport` (`reclaimed`/`failed` as
  `{ kind, id }` objects) verified by re-listing rather than assumed from a remove's exit
  code, and never throws on a removal failure; `p1-e4.ts`'s pre-run reclaim fails closed on a
  surviving stale resource before provisioning starts; `main.ts` gains an operator
  `--reclaim <tag>` mode that is mutually exclusive with a scenario id and `--tag`, that
  drives the same `assertPodman`/`reclaimByLabel` pair through an injectable executor, and
  that claims no bundle directory.

**RED proof.**

- command: `node --test scripts/e2e/lib/podman/reclaim.test.ts`
- exit: non-zero — failure (first of several, all the same root cause):
  ```
  ✖ an empty list for every kind issues the six list commands and no remove command, and resolves { reclaimed: [], failed: [] }
    AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    + actual - expected
    + []
    - {
    -   failed: [],
    -   reclaimed: []
    - }
  ```
  8 tests, 1 pass / 7 fail — the one pass is the ordering test, which only checks call shape
  and argv, not the return type; every test that reads `.reclaimed`/`.failed` fails because
  `reclaimByLabel` still resolves a flat `readonly string[]`.
- command: `node --test scripts/e2e/lib/scenario/p1-e4.test.ts`
- exit: non-zero — failure:
  ```
  ✖ a stale resource surviving reclaim makes run fail closed before it creates anything
    AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
      assert.ok(error instanceof RunnerError)
  ```
  6 tests, 5 pass / 1 fail — `runP1E4` ignores `reclaimByLabel`'s result today and falls
  through to `provisionImages`, which reaches the `executeHost` fake that throws
  `unexpected host argv…`; that thrown plain `Error` is not a `RunnerError`, so the assertion
  on `error instanceof RunnerError` is the one that fails — proving the current code creates
  resources instead of failing closed.
- command: `node --test scripts/e2e/lib/main.test.ts`
- exit: non-zero — failure (representative of all three new `--reclaim` cases):
  ```
  ✖ --reclaim R1 runs assertPodman and reclaimByLabel for R1, and issues no podman run and no scenario step
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    2 !== 0
  ```
  21 tests, 18 pass / 3 fail — `--reclaim` is rejected today as `unknown option --reclaim`
  (exit code 2), confirmed by the captured stderr lines printed during the run; the two new
  `parseArguments` mutual-exclusion refusals already pass because they assert on the
  existing "unknown option" refusal path, which is coincidentally also `invalid-argument` —
  kept as regression coverage for the exclusivity rule the Story names, not vacuous, because
  the Story explicitly requires this pairing to refuse and it does today for the (currently)
  right surface reason; once `--reclaim` is recognized, the software-engineer's exclusivity
  check must keep both green for the _new_ reason (a real `--reclaim` conflicting with a
  positional/`--tag`), not the old "unknown option" one.
- `npm run typecheck`:
  ```
  scripts/e2e/lib/main.test.ts(210,48): error TS2554: Expected 1 arguments, but got 2.
  scripts/e2e/lib/main.test.ts(230,47): error TS2554: Expected 1 arguments, but got 2.
  scripts/e2e/lib/main.test.ts(238,59): error TS2554: Expected 1 arguments, but got 2.
  scripts/e2e/lib/main.test.ts(241,59): error TS2554: Expected 1 arguments, but got 2.
  scripts/e2e/lib/podman/reclaim.test.ts(133,23): error TS2339: Property 'failed' does not exist on type 'readonly string[]'.
  scripts/e2e/lib/podman/reclaim.test.ts(160,16): error TS2339: Property 'reclaimed' does not exist on type 'readonly string[]'.
  scripts/e2e/lib/podman/reclaim.test.ts(167,27): error TS2339: Property 'failed' does not exist on type 'readonly string[]'.
  scripts/e2e/lib/podman/reclaim.test.ts(178,27): error TS2339: Property 'reclaimed' does not exist on type 'readonly string[]'.
  scripts/e2e/lib/podman/reclaim.test.ts(179,27): error TS2339: Property 'failed' does not exist on type 'readonly string[]'.
  scripts/e2e/lib/podman/reclaim.test.ts(195,27): error TS2339: Property 'failed' does not exist on type 'readonly string[]'.
  scripts/e2e/lib/podman/reclaim.test.ts(196,27): error TS2339: Property 'reclaimed' does not exist on type 'readonly string[]'.
  scripts/e2e/lib/podman/reclaim.test.ts(208,16): error TS2339: Property 'failed' does not exist on type 'readonly string[]'.
  ```
  None of these is `TS2307` (the seams already exist on disk today, only their shapes must
  change), so no stub probe applies — each error already names the exact production file and
  line the software-engineer must change (`reclaim.ts`'s return type, `main.ts`'s second
  parameter), and disappears once those signatures match the Story's amended contract.

**Open to Software Engineer.**

- `scripts/e2e/lib/podman/reclaim.ts` — `reclaimByLabel(execute: PodmanExecutor, runId:
string): Promise<ReclaimReport>` where `ReclaimReport = Readonly<{ reclaimed: readonly
ReclaimOutcome[]; failed: readonly ReclaimOutcome[] }>` and `ReclaimOutcome = Readonly<{
kind: ResourceKind; id: string }>` (`ResourceKind` from `../resources.ts`). Verifies
  removal by re-listing each kind's label after its remove call; never throws on a failed
  removal.
- `scripts/e2e/lib/scenario/p1-e4.ts` — the pre-run reclaim phase reads `reclaimByLabel`'s
  report and, on a non-empty `failed`, throws `RunnerError("assertion-failed", ...)` naming
  the surviving kind and id, before `provisionImages` runs.
- `scripts/e2e/lib/main.ts` — `main(argv: readonly string[], dependencies?: Readonly<{
execute?: PodmanExecutor }>): Promise<number>` recognizes `--reclaim <tag>`, mutually
  exclusive with a scenario id positional and with `--tag` (each combination refuses
  `invalid-argument`), runs `assertPodman` then `reclaimByLabel` against the injected (or
  real) executor, prints the report, returns `0` when `failed` is empty and `1` otherwise,
  claims no bundle directory, and issues no scenario step.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 09 (P1-E4 hermeticity) · the reclaim contract

**Cycle.** GREEN for `scripts/e2e/lib/podman/reclaim.test.ts`,
`scripts/e2e/lib/scenario/p1-e4.test.ts` and `scripts/e2e/lib/main.test.ts`.

**Files changed.**

- `scripts/e2e/lib/podman/reclaim.ts` (edited) — `reclaimByLabel(execute: PodmanExecutor,
runId: string): Promise<ReclaimReport>` where `ReclaimReport = Readonly<{ reclaimed:
readonly ReclaimOutcome[]; failed: readonly ReclaimOutcome[] }>` and `ReclaimOutcome =
Readonly<{ kind: ResourceKind; id: string }>`. Kept the six-kind order and the
  two-attempt remove retry, added a re-list after each kind's remove and classified every
  originally-listed id as `reclaimed` or `failed` by membership in that re-list, and dropped
  the old `failed:<id>`-prefixed-string encoding and its own internal throw. An empty list
  for a kind now issues no remove and no re-list.
- `scripts/e2e/lib/scenario/p1-e4.ts` (edited) — imported `RunnerError` from `../errors.ts`;
  Phase 2 now reads `reclaimByLabel`'s `ReclaimReport` and, on a non-empty `failed`, throws
  `RunnerError("assertion-failed", "a stale resource survived reclaim: <kind> <id>")` before
  `provisionImages` (Phase 3) runs.
- `scripts/e2e/lib/main.ts` (edited) — `Invocation` split into `RunInvocation` (the
  pre-existing four-field shape, unchanged) and `ReclaimInvocation = Readonly<{ reclaimTag:
string }>`; `parseArguments` recognizes `--reclaim <tag>` and throws `invalid-argument`
  when combined with a scenario id positional or with `--tag`. `main` gained a second,
  optional `dependencies: Readonly<{ execute?: PodmanExecutor }>` parameter; when the parsed
  invocation carries `reclaimTag` it runs `assertPodman` then `reclaimByLabel` against the
  injected (or a new host-spawning) executor, prints the report, and returns `0` or `1`
  before ever calling `claimBundleDirectory` or touching `scenarios`.

**Seam (GREEN).**

- `reclaimByLabel`'s per-kind loop now issues `list → remove(s) → re-list` and classifies
  every id from the first list by whether the re-list still names it, matching every
  ordering, empty-list, retry, false-positive-exit-zero, and cross-kind-collision case in
  `reclaim.test.ts`, and it never throws — `assert.doesNotReject` passes because no branch in
  the function raises.
- `runP1E4`'s Phase 2 destructures `reclaimReport.failed[0]` and throws before Phase 3, so
  the new `p1-e4.test.ts` case sees `assertion-failed` naming `volume` and the stale id, and
  no `podman run` argv is ever issued (the fake's `executeHost` throwing on any call proves
  provisioning never starts).
- `main`'s `"reclaimTag" in invocation` branch returns before `claimBundleDirectory`, so the
  `.data/` directory-absence test sees no directory created, and the exclusivity refusals in
  `parseArguments` fire before `main`'s scenario lookup ever runs.
  **Refactor.** None named for this Task beyond the contract change itself; the six-kind
  `plans` table, `parseIds`, and the existing two-attempt remove retry in `reclaim.ts` were
  kept as-is since they already matched the amended spec's ordering and retry rules.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `ResourceKind` in `scripts/e2e/lib/resources.ts` already includes all six kinds
  `reclaim.ts` narrows to (`container`, `pod`, `secret`, `volume`, `network`, `image`), so
  `ReclaimOutcome`'s `kind: ResourceKind` field is satisfied by every `plan.kind` value
  without a cast.
- VERIFIED: `PodmanExecutor` (`scripts/e2e/lib/driver/podman.ts`) and `CommandSink`/
  `runCommand` (`scripts/e2e/lib/command.ts`) already export the shapes `main.ts`'s new
  `createDefaultExecute` composes, matching the pattern `p1-e4.ts`'s own
  `createHostExecutor` already uses for the real (non-test) path.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — Story 09 confirm GREEN, then Story 02 · directory helpers

**Cycle.** Confirmed GREEN for the Story 09 reclaim contract, then RED for the Story 02
directory helpers (`scripts/e2e/lib/resources.ts`'s `takeTemporaryDirectory`/`takeDirectory`),
plus the amended `discipline.test.ts` forbidden-token list.

**Confirm GREEN — Story 09.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- command: `node --test scripts/e2e/lib/podman/reclaim.test.ts scripts/e2e/lib/scenario/p1-e4.test.ts scripts/e2e/lib/main.test.ts` —
  34/34 pass, including the reclaim ordering/report-shape tests, the `p1-e4` fail-closed
  reclaim test, and the three `--reclaim` `main.ts` cases. Story 09 is closed.

**Test written.**

- file: `scripts/e2e/lib/resources.test.ts` (edited)
  - new test `takeTemporaryDirectory creates the directory, takes it with kind directory, and
releaseAll removes it` — asserts the returned path exists, `ledger.taken()` is exactly
    `[{ kind: "directory", id: directory }]`, and after `releaseAll` the path no longer
    exists.
  - new test `takeDirectory takes a caller-created path without creating anything, and
releaseAll removes it` — the test itself `mkdtemp`s the path (proving adoption, not
    creation, is `takeDirectory`'s job), then asserts the same take-shape and post-release
    absence.
  - new test `releasing a directory that was already removed produces no ResourceFailure` —
    takes a path the test then removes out from under the ledger, and asserts
    `releaseAll` resolves `[]`, per the Story's "a scenario that removed nothing must not
    fail a run" rule.
- file: `scripts/e2e/lib/scenario/discipline.test.ts` (edited)
  - narrowed `FORBIDDEN_TOKENS` to the exact five literal argv strings the amended Story 02
    text names — `releaseAll`, `podman rm`, `podman pod rm`, `podman network rm`,
    `podman volume rm` — dropping `rm(` and `kill(`, which were a defeated-by-rename
    substring mechanism the Story explicitly retires in favor of the `eslint`
    `no-restricted-imports` rule on `scripts/e2e/lib/scenario/**` (see Open item below). The
    two existing assertions in this file (no forbidden token; `ScenarioContext` carries no
    `releaseAll` key) are unchanged in shape, only the token list is amended.
- asserts: `takeTemporaryDirectory` mkdtemps and takes in one call; `takeDirectory` adopts a
  path the caller already owns without creating anything; both register kind `"directory"`
  and are released (removed) by the ledger; a directory missing at release time is not a
  `ResourceFailure`.

**RED proof.**

- command: `node --test scripts/e2e/lib/resources.test.ts`
- exit: non-zero — failure:
  ```
  file:///Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/scripts/e2e/lib/resources.test.ts:12
    takeDirectory,
    ^^^^^^^^^^^^^
  SyntaxError: The requested module './resources.ts' does not provide an export named 'takeDirectory'
  ```
  0 pass / 1 fail (module fails to load at all, so no test in the file ran) — confirms
  neither `takeTemporaryDirectory` nor `takeDirectory` exists on `resources.ts` today.
- command: `node --test scripts/e2e/lib/scenario/discipline.test.ts`
- exit: 0 — 2/2 pass. This file's two existing assertions were already true before the
  token-list narrowing (no scenario file contains `releaseAll`, `podman rm`, etc., and no
  extra `rm(`/`kill(` occurrence mattered because the aliased `rm as removeTree` import in
  `p1-e2.ts`/`p1-e4.ts` never matched the unaliased `rm(`/`kill(` substrings in the first
  place — exactly the defeated-by-rename gap the Story's Constraints section names as the
  reason the real mechanism must be `eslint`, not this scan). Narrowing the list is a
  no-regression edit to match the Story's amended text, not a new failing assertion; the
  Story's own text supplies the reason the two dropped tokens were never load-bearing.
- `npm run typecheck`:
  ```
  scripts/e2e/lib/resources.test.ts(11,3): error TS2305: Module '"./resources.ts"' has no exported member 'takeTemporaryDirectory'.
  scripts/e2e/lib/resources.test.ts(12,3): error TS2305: Module '"./resources.ts"' has no exported member 'takeDirectory'.
  ```
  Both errors are `TS2305` (missing named export from a module that exists on disk), not
  `TS2307` (missing module) — `resources.ts` already exists, so `tsc` keeps checking the rest
  of the file; no other error is reported, so no stub probe applies. stub probe: not
  applicable — clean apart from the two named-export errors the new imports name.

**Open to Software Engineer.**

- `scripts/e2e/lib/resources.ts` — add
  `takeTemporaryDirectory(context: Pick<ScenarioContext, "take">, prefix: string):
Promise<string>` and `takeDirectory(context: Pick<ScenarioContext, "take">, path: string):
void`, both registering a `Resource` of kind `"directory"` whose `release()` a missing
  directory does not fail.

**Escalation — eslint rule out of lane.**

- OPEN: Story 02's Constraints section requires an `eslint.config.js`
  `no-restricted-imports` entry on the `scripts/e2e/lib/scenario/**` glob forbidding
  `node:fs`, `node:fs/promises` and `node:child_process` imports, enforced by `npm run
lint`. `eslint.config.js` is on the always-forbidden-to-edit list for both engineer
  lanes in this run's instructions, so this half of the Story cannot be implemented by
  either lane this cycle. Human decision needed: either lift `eslint.config.js` off the
  forbidden list for this one Story, or accept the Story's lint gate as unimplemented and
  covered only by the `discipline.test.ts` text-scan (which the Story itself calls
  insufficient against an import rename) until a human applies the rule directly.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 02 (Cleanup is central) · the two directory helpers

**Cycle.** GREEN for `scripts/e2e/lib/resources.test.ts`'s three new directory-helper cases,
then converted `journey.ts`, `p1-e2.ts` and `p1-e4.ts` to use them per the Story's amended
"two directory helpers" section.

**Files changed.**

- `scripts/e2e/lib/resources.ts` (edited) — added `takeTemporaryDirectory(context: Pick<ScenarioContext, "take">, prefix: string): Promise<string>` (mkdtemps under `os.tmpdir()`,
  then delegates to `takeDirectory`, returns the path) and `takeDirectory(context: Pick<ScenarioContext, "take">, path: string): void` (registers a `Resource` of kind
  `"directory"` whose `release()` calls `rm(path, { recursive: true, force: true })`). Both
  import `ScenarioContext` as a type-only import from `./scenario/context.ts` — a circular
  type reference with `context.ts`'s existing `import type { Ledger } from "../resources.ts"`,
  which is erased at compile time and adds no runtime cycle.
- `scripts/e2e/lib/scenario/journey.ts` (edited) — dropped `mkdtemp`/`rm as removeTree`/
  `tmpdir` imports; `workspace` is now `await takeTemporaryDirectory(context, "kanthord-e2e-journey-")`, with the inline `context.take({ kind: "directory", ... })`
  closure removed. `readFile`/`readdir` from `node:fs/promises` stay, unchanged — they back
  `readTree`'s read-only comparison of accepted/exported plan documents, not a removal, and
  the Story's centralization claim ("the only module that removes a directory tree") is about
  removal, which this file no longer performs at all.
- `scripts/e2e/lib/scenario/p1-e2.ts` (edited) — same swap for its `workspace` variable; kept
  `mkdir` (creates the `home` subdirectory inside the already-taken workspace, no separate
  take/release of its own) and dropped `mkdtemp`/`rm as removeTree`/`tmpdir`.
- `scripts/e2e/lib/scenario/p1-e4.ts` (edited) — same swap for `secretsDirectory`; dropped
  `mkdtemp`/`rm as removeTree`/`tmpdir` entirely (this file had no other `node:fs/promises`
  or `node:os` use left).

**Seam (GREEN).** `takeTemporaryDirectory`/`takeDirectory` satisfy the three new
`resources.test.ts` assertions: the created-and-taken case (`existsSync` true, then false
after `releaseAll`), the adopt-without-creating case (the test's own `mkdtemp`, then
`takeDirectory` takes it without a second creation), and the already-removed case (`rm` with
`force: true` does not throw on a missing path, so `releaseAll` reports no `ResourceFailure`).

**Refactor.** The three scenario files' byte-identical `mkdtemp` + inline `context.take({ ...
release: removeTree ... })` blocks — the exact restatement the Story's `.agents/plan/epics/...:26` quote calls out — collapsed to one `takeTemporaryDirectory` call each; no other
change to those files' logic or exports.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: `rm(path, { recursive: true, force: true })` does not throw when `path` does not
  exist — Node's documented `force` behavior for `fs.promises.rm`, and the resulting
  `takeDirectory`/`releaseAll` pairing matches the RED test "releasing a directory that was
  already removed produces no ResourceFailure".
- Scope note: the dispatch text says "no scenario file imports node:fs/promises at all," but
  the Story's amended section and its Constraints only centralize _removal_ into
  `resources.ts` ("the only module in the harness that removes a directory tree"); read-only
  `readFile`/`readdir` in `journey.ts` and the directory-creation `mkdir` in `p1-e2.ts` are
  untouched, since neither is a teardown path and no RED test in this cycle targets them. The
  full `node:fs`/`node:fs/promises`/`node:child_process` ban via `eslint.config.js` remains
  the Constraints-section item already raised `OPEN` by the test-engineer (an `eslint.config.js` edit is out of both engineer lanes this cycle) — unaffected by this turn.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — Story 02 confirm GREEN, then Story 07 · Tools<Name> narrowing

**Cycle.** Confirmed GREEN for the Story 02 directory helpers, then RED-then-self-GREEN
for Story 07's amended `test/helpers/remote/tools.ts` narrowing (entirely inside
`test/helpers/**`, my lane).

**Confirm GREEN — Story 02.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- command: `node --test scripts/e2e/lib/resources.test.ts scripts/e2e/lib/scenario/discipline.test.ts`
  — both suites pass in full, including the three new directory-helper cases
  (`takeTemporaryDirectory`, `takeDirectory`, and the already-removed-directory case).
  Story 02's Task from the prior cycle is closed. The Constraints-section `eslint.config.js`
  item raised `OPEN` last turn is unchanged and still open — `eslint.config.js` remains off
  limits to both engineer lanes this run.

**Test written.**

- file: `test/helpers/remote/tools.test.ts` (edited) — four new cases:
  - `narrows paths to exactly the requested tool names` — `resolveTools({}, ["git"]).paths`
    deep-equals `{ git: <path> }`.
  - `narrows sshVersion to undefined, not the empty-string sentinel, when ssh was not
requested` — asserts `=== undefined`, not `""`.
  - `still resolves all five paths and both versions with no names argument` — the
    zero-args regression guard the Story names.
  - `refuses at the type level to read an unrequested tool's path` — a `// @ts-expect-error`
    line on `tools.paths.ssh` after narrowing to `["git"]`, so `npm run typecheck` is the
    mechanism that proves the narrowing compiles away the unrequested key.
- asserts: a narrowed `resolveTools` call returns a `paths` object holding only the
  requested keys, an unrequested tool's version field is `undefined` (not the old `""`
  sentinel), the zero-argument call site is unaffected, and the unrequested key does not
  compile.

**Consequential test-helper edits (same lane, required to keep the tree green).**

- file: `test/helpers/remote/tools.ts` (edited) — `Tools` and `resolveTools` became generic
  over `Name extends ToolName = ToolName`, per the Story's exact type shape:
  `paths: Readonly<Record<Name, string>>`, `gitVersion: "git" extends Name ? string :
undefined`, `sshVersion: "ssh" extends Name ? string : undefined`. (The Story's prose
  writes the check the other way, `Name extends "git" ? …`; that form distributes over the
  default union `Name = ToolName` and makes every zero-argument call site's `gitVersion` type
  `string | undefined`, which breaks the existing `assert.match(tools.gitVersion, …)` call
  sites — confirmed empirically against this toolchain with a throwaway probe file before
  writing the real edit. The reversed check, `"git" extends Name`, gives `string` for both
  the full-union default and a `Name` literal that includes `"git"`, and `undefined` for a
  `Name` that excludes it, satisfying every case in the Verify block and every existing
  caller with no other edit.) Runtime behavior is unchanged: `gitVersion`/`sshVersion` are
  still probed only when requested, now initialized as `string | undefined` instead of `""`,
  and the return is asserted `as Tools<Name>` at the one boundary the Story calls out.
- file: `test/helpers/remote/seed.ts` and `test/helpers/remote/http.ts` (edited) — both
  already imported `Tools` unparameterized (`= Tools<ToolName>`, the full five-key record) for
  the internal helpers and the exported `seedRepositories`/`startHttpRemote`. Once `Tools`
  became generic, `scripts/e2e/fixture-remote/main.ts`'s `resolveTools(process.env,
["git"])` → `seedRepositories(tools)` / `startHttpRemote(tools, seed, …)` call (the exact
  "first narrowed call site" the Story's prose names) stopped typechecking, because
  `Tools<"git">`'s `paths: Record<"git", string>` is not assignable to `Tools<ToolName>`'s
  `paths: Record<ToolName, string>`. `scripts/e2e/**` is software-engineer lane and
  `test/helpers/**` is mine, so only I can close this gap. Neither file used any `Tools`
  field beyond `execPath`, `httpBackend` and `paths.git`, so I replaced the `Tools` parameter
  type on `invocationEnvironment`, `gitRun`, `initBareRepository`, `seedRepositories`,
  `seedInto` (seed.ts) and `cgiEnvironment`, `handleRequest`, `startHttpRemote` (http.ts)
  with a local, unexported structural type naming exactly those three fields. A narrowed
  `Tools<"git">` and the full `Tools<ToolName>` both satisfy it structurally, so every
  existing caller (which always passes the full `Tools`) is unaffected and no test changed
  its expectation.

**RED proof.**

- command: `git stash push -- test/helpers/remote/tools.ts test/helpers/remote/seed.ts
test/helpers/remote/http.ts` then `node --test test/helpers/remote/tools.test.ts`
- exit: non-zero — failures (three of the four new cases; the fourth, the
  `@ts-expect-error` case, fails only under `tsc`, not at runtime, since the pre-narrowing
  `resolveTools` ignores its second argument entirely):
  ```
  ✖ narrows paths to exactly the requested tool names
    AssertionError: expected { git, ssh, sshd, sshKeyscan, sshKeygen } to equal { git }
  ✖ narrows sshVersion to undefined, not the empty-string sentinel, when ssh was not requested
    AssertionError: expected '10.2p1' to strictly equal undefined
  ✖ refuses at the type level to read an unrequested tool's path
    AssertionError: expected '/usr/bin/ssh' to strictly equal undefined
  ```
  Confirms the old `resolveTools` resolves and validates every tool regardless of the
  `names` argument, and returns an unnarrowed object.
- `git stash pop` restored the implementation.
- typecheck stub probe: not applicable — the seam (`resolveTools`/`Tools`) already exists on
  disk; the RED is a runtime/behavioral one plus one `@ts-expect-error` type-level one, not a
  `TS2307` masking case.

**GREEN proof (self, test-helper lane).**

- command: `node --test test/helpers/remote/tools.test.ts` — 18/18 pass, including all four
  new cases.
- command: `node --test test/helpers/remote/http.test.ts` — 15/15 pass, including the
  pre-existing `startHttpRemote(tools, seed, { bind, port })` third-argument case, unaffected
  by the `GitTools` narrowing.
- command: `npm run typecheck` — exit 0 (was failing on
  `scripts/e2e/fixture-remote/main.ts` with two `TS2345` errors before the `seed.ts`/
  `http.ts` structural-type edits; clean after).
- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- command: `npm test` — `tests 3269`, `pass 3269`, `fail 0` (full suite, no regression).

**Open to Software Engineer.**

- None for this Task. The remaining Story 07 items (`scripts/e2e/podman/*.Containerfile`,
  `scripts/e2e/lib/podman/topology.ts`, `scripts/e2e/lib/driver/podman.ts`,
  `scripts/e2e/fixture-remote/main.ts`) already exist on disk from an earlier cycle and their
  named `Verify` suites (`topology.test.ts`, `image.test.ts`) already pass unchanged by this
  turn — this Task closes Story 07's "Changed — tools.ts" item without requiring a
  software-engineer turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 04 · the four repository-name translation seams

**Cycle.** GREEN-ONLY implementation for Story 04's amended "Changed — the four repository-name
translation seams" section (`.agents/plan/stories/011-end-to-end-scenarios/04-p1-e1-the-onboarding-journey.md`).

**Files changed.**

- `src/queries/plan/export-plan.ts` (edited) — `ExportPlanRefusal` gained `"repository-unknown"`.
  The `repo:` field's `?? node.repositoryId` fallback in the per-node loop is replaced with an
  explicit `repositoryNamesById.get(node.repositoryId)` read, an `undefined` check, and
  `throw new ExportPlanError("repository-unknown", \`repository ${node.repositoryId} is not registered\`)`
  on miss.
- `src/queries/plan/validate-plan.ts` (edited) — `ValidatePlanRefusal` gained
  `"repository-unknown"`. The `storedNodes.map` that rewrites `repositoryId` from id to name
  now checks `repositoryNamesById.get(node.repositoryId)` explicitly and throws
  `ValidatePlanError("repository-unknown", ...)` on miss instead of `?? node.repositoryId`.
- `src/commands/plan/import-plan.ts` (edited) — `ImportPlanRefusal` gained
  `"repository-unknown"`. Both translation sites converted:
  - id → name (the `storedNodes.map` before validation, same shape as `validate-plan.ts`):
    explicit `undefined` check, `throw new ImportPlanError("repository-unknown", ...)`.
  - name → id (the `upsertNode` loop before the write): replaced
    `repositoryIdsByName.get(node.repositoryId) ?? node.repositoryId` with an explicit lookup
    into a local `repositoryId` variable, throwing `ImportPlanError("repository-unknown", ...)`
    on miss, then passing that variable to `upsertNode`.

**Seam (GREEN).** Each of the four sites now raises the file's own existing error class with a
new `"repository-unknown"` refusal and a message naming the unresolved id/name, exactly per the
Story's pinned code block, instead of silently propagating the untranslated value via `??`. No
lookup-helper (`readRepositoryNamesById`/`readRepositoryIdsByName`) moved or deduplicated, per
the Story's explicit deferral to `docs/proposal/open-items.md`.

**Refactor.** None named for this Task beyond the seam itself; no further cleanup applied.

**Build check.**

- typecheck: **not clean** — `src/http/server/plan/refusals.test.ts(19,7): error TS2741:
Property '"repository-unknown"' is missing in type '{ ... }' but required in type
'Readonly<Record<ImportPlanRefusal, true>>'.` This is the sole remaining typecheck failure;
  everything else compiles clean. `src/http/server/plan/refusals.ts` (the production handler,
  my lane) has no case for `"repository-unknown"` in its `switch (error.refusal)`, but that
  switch has no `default`/exhaustiveness assertion, so it compiles regardless — an unmatched
  refusal there simply falls through to the existing `throw error;`, the same treatment the
  file already gives to an unrecognized/未-cased refusal, and matches the Story's own framing
  of a repository-unknown miss as an invariant failure (parallel to this file's existing
  uncaught-`Error` treatment of "blob is missing from the store"). The break is confined to
  `refusals.test.ts`'s exhaustive `Readonly<Record<ImportPlanRefusal, true>>` literal, which
  must list every member of the union and therefore needs `"repository-unknown": true` added —
  a test file, outside my lane per the Role Boundary and the "test-target mocks you cannot
  edit" anti-pattern.

**Open to Test Engineer.**

- `src/http/server/plan/refusals.test.ts:19-30` — the `everyImportPlanRefusal` literal needs
  `"repository-unknown": true` added so it satisfies `Readonly<Record<ImportPlanRefusal, true>>`
  after this turn's `ImportPlanRefusal` addition. The suite's final case ("the codes toHttpError
  can emit beyond the baseline equal plan.import's declared additions") will then exercise
  `toHttpError(new ImportPlanError("repository-unknown", "x"))`; since `refusals.ts` has no case
  for it, `toHttpError` rethrows the raw `ImportPlanError` (caught by that test's `catch {}`), so
  the refusal contributes no HTTP code and needs no `plan.import` registry addition — confirmed
  by tracing `toHttpError`'s control flow, not run (I do not run tests).

**Assumptions.**

- VERIFIED: `src/http/server/plan/export-plan.ts` and `src/http/server/plan/validate-plan.ts`
  (the handler-layer files, distinct from the queries files touched by this Task) have no
  equivalent exhaustive-`Record` test, since `ExportPlanRefusal`/`ValidatePlanRefusal` are not
  referenced by any `.test.ts` outside `export-plan.test.ts`/`validate-plan.test.ts` themselves
  (checked by grep across `src/`) — so adding `"repository-unknown"` to those two unions caused
  no analogous typecheck break.
- UNVERIFIED: whether the test-engineer's next turn also wants a `refusals.ts` case for
  `"repository-unknown"` mapped to a specific HTTP code (e.g. `invalid-request`, matching the
  `choice-duplicate`/`choice-missing`/`choice-extra` treatment) rather than the fall-through-to-
  500 behavior this turn leaves in place; the Story's four-seams section names no HTTP mapping,
  so I left `refusals.ts` unchanged rather than guess at an unrequested contract addition.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — Story 04 · clear the refusals typecheck blocker, prove the four regression cases

**Cycle.** Cleared the SE's `OPEN:` (the exhaustive `everyImportPlanRefusal` literal in
`src/http/server/plan/refusals.test.ts`), then wrote and RED-proved the Story 04 regression
cases named in the amended `## Verify` block of
`.agents/plan/stories/011-end-to-end-scenarios/04-p1-e1-the-onboarding-journey.md`, then ran
the full EPIC Verification Gate end to end.

**Test written.**

- file: `src/http/server/plan/refusals.test.ts` (edited) — `everyImportPlanRefusal` gains
  `"repository-unknown": true`, satisfying `Readonly<Record<ImportPlanRefusal, true>>` after
  the SE's prior turn added that member. This closed the sole remaining typecheck failure.
- file: `src/queries/plan/export-plan.test.ts` (edited) — new case "throws repository-unknown
  naming the id when a node's repository_id names no repository row": seeds
  `seedPlanFixture`, then on a raw `DatabaseSync` connection with `PRAGMA foreign_keys = OFF`
  (the exact pattern the file's existing missing-blob case already uses) points the
  objective's `repository_id` at `"repo_ghost"`, an id no `repository` row holds. Asserts
  `exportPlan` throws with `refusal === "repository-unknown"` and a message containing
  `repo_ghost`.
- file: `src/queries/plan/validate-plan.test.ts` (edited) — `build()` now also returns `path`
  (needed to open the raw connection); `DatabaseSync` imported. Same corruption, same
  assertion, against `validatePlan`.
- file: `src/commands/plan/import-plan.test.ts` (edited) — `ImportFixture`/`build()` now also
  carry `path`; `DatabaseSync` imported. Same corruption against `importPlan`, driven through
  `fromRevision`/`validatedRevision` both set to `fixtureIds.planRevision` so the id → name
  translation is reached before any document/choice content matters; asserts
  `error.refusal === "repository-unknown"` and `error.message` matches `/repo_ghost/`.
  Also added "none of the three repository-name translation files falls back with `??
node.repositoryId`" in "the rest": reads `import-plan.ts`, `../../queries/plan/export-plan.ts`
  and `../../queries/plan/validate-plan.ts` by URL relative to the test module (never the
  cwd) and asserts none of the three source texts contains the literal string
  `?? node.repositoryId`.
- The export-holds-the-name case is the pre-existing "renders repo on the objective and not
  on the task or the initiative" test in `export-plan.test.ts` (uncommitted from an earlier
  turn in this cycle), asserting `repo: "kanthord-verify"` on the exported objective. It was
  never proved sensitive before this turn; the sensitivity proof below covers it too.
- asserts (all five, together): the id → name lookup miss is an explicit, named refusal in
  each of the three files rather than a silent value passthrough; no file reintroduces the
  `??` fallback; and an export of a plan whose objective cites a registered repository
  renders the registered **name**, not the raw id, in `repo`.

**RED proof.**

- `git stash push -- src/queries/plan/export-plan.ts src/queries/plan/validate-plan.ts src/commands/plan/import-plan.ts` reverted the seam to the pre-fix code (raw `node.repositoryId`
  written straight into `repo`/the node row, no `readRepositoryNamesById`/`readRepositoryIdsByName`, no `"repository-unknown"` refusal member).
- command: `node --test src/queries/plan/export-plan.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts`
- exit: non-zero — the four new/newly-proved cases failed for the right reason:
  ```
  ✖ throws repository-unknown naming the id when a node's repository_id names no repository row (export-plan.test.ts:351)
    AssertionError: Missing expected exception.
  ✖ renders repo on the objective and not on the task or the initiative (export-plan.test.ts:126)
    AssertionError: Expected values to be strictly equal: false !== true
  ✖ throws repository-unknown naming the id when a node's repository_id names no repository row (validate-plan.test.ts:615)
    AssertionError: The validation function is expected to return "true". Received false
    Caught error: Error: repairSuggestions exceeded its iteration cap
  ✖ throws repository-unknown naming the id when a stored node's repository_id names no repository row (import-plan.test.ts:1926)
    AssertionError: Expected values to be strictly equal: 'documents-hash-mismatch' !== 'repository-unknown'
  ```
  (many other pre-existing round-trip tests in `import-plan.test.ts`/`validate-plan.test.ts`
  also failed with `FOREIGN KEY constraint failed`, confirming the old code wrote a
  repository _name_ into the `repository_id` FK column — the exact defect the seam fixes —
  but those are not this turn's target cases.)
  The textual-guard case still passed under the reverted code (it asserts an absence of a
  string pattern in source text, independent of runtime behavior; its own sensitivity is to a
  future re-introduction of the fallback line, not to this revert).
- `git stash pop` restored the fixed seam. `grep -c "repository-unknown"` confirmed all three
  files hold the refusal member again.
- typecheck stub probe: not applicable — all seams already exist on disk; `npm run
typecheck` was clean both before writing these tests (after the refusals.test.ts fix) and
  after restoring the seam.

**GREEN proof (post-restore).**

- command: `npm run typecheck` — exit 0.
- command: `node --test src/queries/plan/export-plan.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/refusals.test.ts`
  — `tests 75`, `pass 75`, `fail 0`.

**Open to Software Engineer.**

- None. Story 04's "the four repository-name translation seams" item is closed: production
  fix, typecheck-clean exhaustive test literal, and five RED-proved regression cases.

**EPIC verification gate.**
Both parts of the EPIC's `## Verification Gate` were run for real on the current
working tree.

- `npm run verify` (Gates): exit 0 — `tests 3273`, `suites 340`, `pass 3273`, `fail 0`,
  `cancelled 0`, `skipped 0`; `eslint` clean; `db status ok` after the migration-application
  self-check.
- Proof — run as one command exactly as the EPIC writes it:
  ```bash
  node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 \
    && node scripts/e2e/run.mjs P1-E4 \
    && echo "PASS EPIC-011"
  ```
  exit 0, real Podman (`podman version 6.0.2`, confirmed present), printed exactly
  `PASS EPIC-011` as the final line.

**Tasks closed.** All five items this follow-up cycle was scoped to are green: Story 10 (the
anti-vacuity guard), Story 09 (the reclaim contract), Story 02 (the two directory helpers —
`takeTemporaryDirectory`/`takeDirectory`; the `eslint.config.js` `no-restricted-imports` rule
itself stays an `OPEN:` for the human, restated below, since `eslint.config.js` is on the
always-forbidden list for both engineer lanes), Story 07 (`Tools<Name>` narrowing), and Story
04 (the four repository-name translation seams, closed this turn). Combined with the twelve
Stories already closed and reviewed at the end of the prior cycle
(`.agents/tdd/history/2026-08-07-011-end-to-end-scenarios.md`), all 12/12 Stories of EPIC 011
are green, with no Story outstanding.

**Restated OPEN item for the human (not resolved this cycle, by design).** Story 02's
Constraints section calls for an `eslint.config.js` `no-restricted-imports` rule on
`scripts/e2e/lib/scenario/**` forbidding `node:fs`/`node:fs/promises`/`node:child_process`
imports outside `resources.ts`, so the teardown-centralization guard is structural rather than
a forbidden-substring test. `eslint.config.js` is on the always-forbidden edit list for both
the test-engineer and the software-engineer lanes this cycle, so this one line needs a human
hand. Everything else Story 02 asks for — `takeTemporaryDirectory`, `takeDirectory`, and the
three scenario files' collapse onto them — is implemented and green.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 && node scripts/e2e/run.mjs P1-E4 && echo "PASS EPIC-011") — "PASS EPIC-011"
- stories: 12/12 complete
- date: 2026-08-08
- state: local-uncommitted

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — routing 4 action:YES finding(s) to the TDD loop; 8 action:NO finding(s) recorded for the human.
BLOCKER: B1 — reclaim.ts remove argv is wrong for five of six kinds. `--filter` is accepted only by `podman rm`; `podman pod rm`, `secret rm`, `volume rm`, `network rm` and `image rm` all fail with `unknown flag: --filter`, exit 125, which runCommand does not throw on, so the failure is discarded and the resource survives. Proved on real podman 6.0.2: a labelled volume survived `run.mjs --reclaim`, which exited 1. Keep `--filter` on `podman rm` only; for the other five kinds pass the ids parsed from that kind's list as the remove command's arguments.
BLOCKER: B2 — reclaim.test.ts:31-38 hard-codes the same five unsupported argv shapes in its `removeArgv` table and the fake answers whatever the table names, so seven cases pass against commands real podman cannot run. That table is what let B1 through a full RED/GREEN cycle. Correct it to the per-kind shapes alongside B1.
BLOCKER: S1 — reclaim.ts:79-86 catches only a thrown executor error, so a non-zero exit resolves normally and the remove's exit code and stderr are discarded. The operator's `failed to reclaim <kind> <id>` line therefore carries no reason. Carry the exit code and stderr onto the failed outcome, or print them beside the failure line.
BLOCKER: S3 — resources.test.ts:177-188 names the case "takes a caller-created path without creating anything" but only passes an already-created path, so nothing asserts takeDirectory creates nothing. Call it on a path that does not exist and assert it is still absent afterwards.
INFO: B3 (action:NO, NEEDS-HUMAN) — a second vacuity remains in disclosure.ts: every surface it reads has already been through `redact` (command.ts records `stdout: redact(stdout)`; p1-e4.ts:226 redacts the attached logs), so `config`, `daemon-logs`, `basic-header`, `podman-inspect`, `diagnostics` and the printed-lines half of `printed-commands` prove redaction ran rather than that the value was never present. This run's own bundle.json holds `Authorization: Bearer [redacted]x` in the very log the bearer-header surface reads. Story 10 requires the raw text AND pins `redact` to exactly three call sites, one of which is stdout/stderr entering a CommandRecord — spec contradicts spec, so it needs a human decision. Options: CommandRecord carries raw and redacted text with raw never serialized; or assertNoDisclosure gets its own unredacted executor and logs are attached raw, redacting only in serializeBundle/writeBundle.
INFO: S4 (action:NO, NEEDS-HUMAN) — the deferred Story 02 eslint rule is not achievable as written. journey.ts (readFile, readdir), p1-e2.ts (mkdir), p1-e3.ts (readFile) and scenario/tools.ts (accessSync) all import node:fs* for legitimate reads, so a blanket module ban on the scenario glob fails lint on four innocent files. The achievable form is no-restricted-imports with `importNames`: forbid rm/rmSync/rmdir from node:fs* and spawn/spawnSync/execFile*/exec from node:child_process. importNames matches the imported binding, so `import { rm as removeTree }` is still caught — the exact rename the story says a text scan misses.
INFO: S2 (action:NO) — the two-attempt retry in reclaim.ts:79-86 is unreachable in production for the same reason as S1; the re-list is the real mechanism. Story 09 Verify names the retry case, so it stays.
INFO: S5 (action:NO) — two `podman image rm --force` release closures still live inside p1-e4.ts:99-112, against Story 02's "every such closure lives in resources.ts or a driver". Moving them needs a new takeImage seam, so it is a design call.
INFO: S6 (action:NO) — provision.ts:270 rmSync(work, ...) is a second module removing a tree, against Story 02's "resources.ts is the only module in the harness that removes a directory tree". Outside this cycle's changed set.
INFO: S7 (action:NO) — the p1-e4 argv sweep covers argv only; Story 10 also asks for "no printed line". The fakes bypass runCommand so printedLines is empty, and a loop over it would itself be vacuous. Either have the fake print a line the sweep can see, or leave the printed-line half to the Proof and say so.
INFO: S8 (action:NO) — assertNoDisclosure throwing from the p1-e4.ts:228-231 finally replaces the in-flight phase-5..10 failure and loses the real cause. Capture and rethrow the original with the disclosure failure attached, as withLedger already does with cleanupFailures.
INFO: S9 (action:NO) — the fourth seam (name → id before the write) has no test of its own; the repo_ghost case rejects at the id → name step first. Story 04 Verify names three cases, so this is within spec.

## TEST-ENGINEER — Story 09 / Story 02 · repair the reclaim RED and close the takeDirectory vacuity (review blockers B2, S3)

**Cycle.** Repair-path turn for the two test-half `BLOCKER:` findings the review routed to this
lane. B1 and S1 are production edits in `scripts/e2e/lib/podman/reclaim.ts` and stay
`Open to Software Engineer`; this turn does not touch that file.

**Test written.**

- file: `scripts/e2e/lib/podman/reclaim.test.ts` (edited) — corrected the per-kind remove argv
  table to the shape Story 09 actually specifies: `--filter label=…` stays on `podman rm`
  (item 1's `podman rm --force --filter label=...`), and the five other kinds (`pod`, `secret`,
  `volume`, `network`, `image`) take the ids parsed from that kind's list as the remove
  command's trailing arguments instead — `removePrefix`/`removeArgvFor` replace the old
  `removeArgv` table that hard-coded `--filter` on all six.
  - `matchesRemoveKind` (replaces the old `matchesKind(argv, removeArgv)` routing for removes)
    now **throws** when a non-container remove argv carries a flag (`--filter` chiefly) among
    what should be its trailing id arguments — the real podman behavior (`unknown flag:
--filter`, exit 125) the fake previously could not distinguish from a valid call. This is
    the requested new sensitivity: any future regression that puts `--filter` back on a
    `pod`/`secret`/`volume`/`network`/`image` remove now breaks the fake's routing instead of
    being silently accepted.
  - "reclaimByLabel issues the six list commands and the six remove commands, in the exact
    order, followed by a re-list" (renamed from "…each carrying the label filter") now asserts
    each remove argv via `removeArgvFor(kind, idsByKind[kind])` — `--filter` baked into the
    container case, ids baked into the other five — instead of a per-kind `removeArgv[kind]`
    table that carried `--filter` for all six.
  - new case: "a non-container remove argv that still carries --filter is rejected, and the
    surviving id is reported as failed rather than falsely reclaimed" — drives `volume` with a
    surviving id; the fake's `matchesRemoveKind` rejection plus `reclaimByLabel`'s own re-list
    verification together make sure a bad-flag remove attempt is never mistaken for a
    successful reclaim.
  - "a remove that fails once and succeeds on the repeat…" updated to route its
    remove-call-count filter through `matchesRemoveKind` instead of the deleted `removeArgv`
    table.
- file: `scripts/e2e/lib/resources.test.ts` (edited) — new case "takeDirectory takes a path
  that does not exist without creating it, and releaseAll leaves it absent". `mkdtemp`s a
  directory, immediately `rm`s it to get a guaranteed-absent-but-unique path, calls
  `takeDirectory` on it, asserts `existsSync` is `false` both right after the call and after
  `releaseAll`. The prior case at this location only exercised an already-created path, so
  nothing forced the "without creating anything" half of its own name.
- asserts: (reclaim) a remove command for any of the five non-`podman rm` kinds is built from
  the ids parsed off that kind's list, never `--filter`, and the suite fails hard if that
  constraint regresses; (resources) `takeDirectory` never creates the path it adopts.

**RED proof.**

- command: `node --test scripts/e2e/lib/podman/reclaim.test.ts`
- exit: non-zero — 7/8 pass, one fails for the intended reason (the unmodified
  `scripts/e2e/lib/podman/reclaim.ts` still builds `--filter` argv for the five non-container
  kinds, so the corrected fake's `matchesRemoveKind` throws on each of those, `reclaim.ts`'s
  two-attempt catch loop swallows both throws, and the call count balloons):
  ```
  ✖ reclaimByLabel issues the six list commands and the six remove commands, in the exact order, followed by a re-list (1.237959ms)
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    23 !== 18
  ```
  This is B1/B2's exact defect surfacing as a failing test again, for the right reason (wrong
  remove argv shape, not a coincidental value mismatch). It will pass once
  `scripts/e2e/lib/podman/reclaim.ts` is corrected to build each of the five non-container
  remove commands from the parsed ids instead of `--filter`.
- command: `node --test scripts/e2e/lib/resources.test.ts` — 13/13 pass, including the new
  case. `takeDirectory`'s production behavior was already correct (it never creates a path);
  the review's finding was purely that the existing test never forced that half of its
  contract. This is a pass-through characterization/regression test, not a RED — the gap was
  in test coverage, not production code, and is stated here explicitly per the review-blocker
  regression-test allowance.
- typecheck stub probe: not applicable — both seams (`reclaimByLabel`, `takeDirectory`)
  already exist on disk. `npm run typecheck` — exit 0, clean, including the two edited test
  files (fixed one `TS2532` batch of "Object is possibly 'undefined'" from an
  over-eager `--filter`-presence loop in my first draft of the reclaim test, by relying on the
  already-exact `deepEqual` assertions instead of a redundant indexed-access loop).

**Open to Software Engineer.**

- `scripts/e2e/lib/podman/reclaim.ts` — B1: the five remove commands for `pod`, `secret`,
  `volume`, `network` and `image` currently build their argv with `--filter label=…`, which
  real podman rejects for those subcommands. Build each from the ids parsed off that kind's
  own list result instead, keeping `--filter` only on the `podman rm` (container) case.
  `scripts/e2e/lib/podman/reclaim.test.ts:148` is the RED test this satisfies.
- `scripts/e2e/lib/podman/reclaim.ts` — S1: the two-attempt retry at lines 79-86 only catches a
  thrown executor error, so a resolved non-zero exit (the shape `runCommand` actually returns)
  is discarded with no reason carried to the operator's `failed to reclaim <kind> <id>` line.
  Carry the exit code and stderr onto the failed outcome, or print them beside the failure
  line, as the review's `S1` finding names. No test in this turn pins that message text; the
  review left it to the software-engineer's judgment and I am not inventing one.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 09 · reclaim.ts remove argv + failure reason (review blockers B1, S1)

**Cycle.** GREEN for `scripts/e2e/lib/podman/reclaim.test.ts` (the test-engineer's corrected
`removePrefix`/`removeArgvFor`/`matchesRemoveKind` fixtures), fixing the review's B1 and S1
findings.

**Review blockers addressed.**

- `BLOCKER: B1 — reclaim.ts remove argv is wrong for five of six kinds. ... Keep --filter on podman rm only; for the other five kinds pass the ids parsed from that kind's list as the remove command's arguments.`
- `BLOCKER: S1 — reclaim.ts:79-86 catches only a thrown executor error, so a non-zero exit resolves normally and the remove's exit code and stderr are discarded. ... Carry the exit code and stderr onto the failed outcome, or print them beside the failure line.`

**Files changed.**

- `scripts/e2e/lib/podman/reclaim.ts` (edited):
  - `Plan.remove` now takes `(filterFlag, ids)`. `container` keeps
    `["podman", "rm", "--force", "--filter", filterFlag]`. `pod`, `secret`, `volume`,
    `network`, `image` now build `[...fixed-prefix, ...ids]` with no `--filter` — `pod`/`volume`/
    `network`/`image` keep `--force`, `secret` does not (`podman secret rm` has no `--force`
    flag), matching the Story's pinned shapes and the test's `removePrefix` table exactly.
  - The two-attempt remove loop no longer assumes failure is only ever a thrown executor
    error. It now inspects the resolved `CommandRecord.exitCode`: `0` clears the last-failure
    state and breaks; non-zero records `{ exitCode, stderr }` and lets the loop retry once. A
    thrown error (still possible from a real spawn failure) is also captured as
    `{ exitCode: null, stderr: error.message }` — this keeps the fake's `failRemoveOnce`
    (throw-based) case green while also handling the resolved-non-zero-exit case B1's real
    podman produces, which the old bare `catch {}` could never see because `runCommand`
    resolves rather than rejects on a non-zero exit.
  - New optional third parameter `onRemoveFailure?: ReclaimFailureReporter` (new exported
    types `ReclaimFailureDetail`, `ReclaimFailureReporter`). After the re-list, if any id for
    the kind survived and the last remove attempt recorded a failure, `reclaimByLabel` calls
    it once with `(kind, { exitCode, stderr })`. `ReclaimOutcome`/`ReclaimReport` are left
    exactly as `reclaim.test.ts` asserts them via `assert.deepEqual` (both `report` as a whole
    and `report.failed`/`report.reclaimed` individually) — no field was added to either, since
    an extra own-enumerable property would break the test's `deepEqual` (loose-deepEqual still
    requires the same key set), and the third parameter is optional so every existing call
    site (including all of `reclaim.test.ts`'s two-argument calls) is unaffected.
- `scripts/e2e/lib/main.ts` (edited) — the sole non-test caller of `reclaimByLabel`. Imports
  `ReclaimFailureDetail`. `main`'s `--reclaim` branch now passes a reporter that fills a
  `Map<string, ReclaimFailureDetail>` keyed by kind. `printReclaimReport` takes that map as a
  second parameter and, for each failed outcome, appends `" (exit <code>: <stderr>)"` (omitting
  the parenthetical when no diagnostic was recorded, e.g. the remove call itself resolved
  `exitCode: 0` but the resource still survived) to the existing
  `e2e: failed to reclaim <kind> <id>` stderr line. `main.test.ts`'s reclaim fixtures never
  drive a non-empty id list for anything but `container`, so the argv-shape change is inert
  there and no existing assertion on `printReclaimReport`'s call shape changes.

**Seam (GREEN).** `reclaim.test.ts`'s `removeArgvFor`/`matchesRemoveKind` now match
`reclaim.ts`'s actual remove argv for all six kinds, so `reclaimByLabel` no longer builds a
`--filter`-carrying remove command for `pod`/`secret`/`volume`/`network`/`image` (B1). A
non-zero-exit remove response is now captured as a `{ exitCode, stderr }` detail and surfaced
through the reporter to `main.ts`'s failure line rather than silently discarded (S1).

**Refactor.** None named beyond the seam; no further cleanup applied.

**Build check.**

- typecheck: exit 0.

**Assumptions.**

- VERIFIED: `runCommand` (`scripts/e2e/lib/command.ts`) resolves `CommandRecord` with whatever
  `exitCode` the child process exits with — it only rejects on a `child.on("error", ...)`
  spawn failure — confirming B1's premise that the old bare `catch {}` could never see a
  resolved non-zero exit, and justifying the `removeRecord.exitCode === 0` check added here.
- VERIFIED: `assert.deepEqual`/`assert.equal`-style loose-deepEqual in `node:assert/strict`
  fails when the actual value carries an extra own-enumerable property the expected literal
  does not — checked empirically — which is why the failure diagnostic is carried via an
  optional callback parameter to `reclaimByLabel` rather than as a new field on
  `ReclaimOutcome`/`ReclaimReport`, both of which `reclaim.test.ts` asserts by exact
  `deepEqual`.
- UNVERIFIED: the exact wording/format of the `main.ts` failure line
  (`e2e: failed to reclaim <kind> <id> (exit <code>: <stderr>)`) is not pinned by any test;
  the review's S1 finding leaves the presentation to engineering judgment ("print them beside
  the failure line").

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — Story 09 · confirm GREEN on B1/B2/S1/S3, real-podman B1 probe, full gate

**Cycle.** Confirm-GREEN for the four routed review blockers (B1, B2, S1, S3), fixed by the
software-engineer's last turn (`scripts/e2e/lib/podman/reclaim.ts`, `scripts/e2e/lib/main.ts`).
No new test written this turn.

**Confirm-GREEN proof.**

- command: `node --test scripts/e2e/lib/podman/reclaim.test.ts scripts/e2e/lib/resources.test.ts scripts/e2e/lib/main.test.ts`
- result: `tests 42`, `pass 42`, `fail 0`, `cancelled 0`, `skipped 0`. The B2-corrected
  `removePrefix`/`removeArgvFor`/`matchesRemoveKind` table in `reclaim.test.ts` now matches
  the SE's per-kind remove argv exactly (B1), the S3 `takeDirectory`-does-not-create case in
  `resources.test.ts` passes, and `main.test.ts`'s reclaim-argument and reporting cases pass
  unchanged.

**Real-podman B1 empirical proof (not against the fake).** Reproduced the reviewer's exact
finding by hand against real podman 6.0.2 on this machine:

1. Created a labelled volume and a labelled network by hand:
   `podman volume create --label kanthord-e2e-run=<tag> kanthord-probe-vol-<tag>` and
   `podman network create --label kanthord-e2e-run=<tag> kanthord-probe-net-<tag>`.
2. Confirmed both listed under `podman volume ls --filter label=kanthord-e2e-run=<tag>` /
   `podman network ls --filter label=kanthord-e2e-run=<tag>`.
3. Ran `node scripts/e2e/run.mjs --reclaim <tag>`.
   - Before the SE's fix this is exactly the reviewer's finding: the volume/network remove
     commands carried `--filter`, which `podman volume rm`/`podman network rm` reject
     (`unknown flag: --filter`, exit 125), so the resource survives and the command exits 1.
   - After the fix: printed `e2e: reclaimed volume kanthord-probe-vol-<tag>` and
     `e2e: reclaimed network kanthord-probe-net-<tag>`, **exit 0**.
4. Re-listed both filters after the run: `podman volume ls --filter label=...` and
   `podman network ls --filter label=...` each returned no rows — the resources are gone.
5. Extended the probe with a labelled pod and a labelled secret
   (`podman pod create --label ...`, `podman secret create --label ...`) to cover the other
   two non-container kinds B1 named. The pod was correctly removed by `podman pod rm --force
<id>` (no `--filter`) and confirmed absent from `podman pod ps --filter label=...`
   afterward.
   - This wider probe surfaced one thing outside B1/B2/S1/S3's scope, reported here for
     visibility rather than silently absorbed: `reclaimByLabel` processes the `container` kind
     before the `pod` kind, and a pod's auto-created infra container inherits the pod's label.
     The container-step remove attempt on that still-alive infra container fails with
     podman's own `... is the infra container of pod ... and cannot be removed without
removing the pod`, which the run reports as `failed to reclaim container <id>` and an
     overall exit of 1 — even though the subsequent `pod` step's `podman pod rm --force`
     removes the pod and its infra container together, so **nothing is actually left
     behind** (verified: `podman ps -a --filter label=...` and `podman pod ps --filter
label=...` were both empty afterward). This is a false-failure/ordering quirk distinct
     from B1 (no resource survives), not one of the four routed findings, and not something I
     fix or reopen this turn — noted for the human/reviewer.
   - Also observed: `podman secret ls --filter label=...` returned empty even though the
     secret's own `podman secret inspect` showed the label present — confirmed this is a
     podman-6.0.2-level limitation (the identical filter run manually against `podman secret
ls` also returns nothing), not a `reclaim.ts` argv defect; `reclaim.ts`'s secret list
     command is unchanged and matches the container/volume/network/pod/image list commands
     byte-for-byte in shape. Cleaned the secret up by hand afterward
     (`podman secret rm kanthord-probe-secret-<tag>`).
6. Re-ran the minimal volume+network probe a second time end-to-end (fresh tag) to nail down
   the primary claim cleanly: before `--reclaim`, both listed; after, `exit 0` and both
   `ls --filter` queries returned nothing.
7. Confirmed no probe artifact of any kind survives anywhere on the host:
   `podman volume ls`, `network ls`, `pod ps`, `ps -a`, `secret ls` all show zero `probe*`
   entries after cleanup.

**Full EPIC verification gate — both parts run for real this turn.**

- Gates — `npm run verify`: exit 0. `tests 3275`, `suites 340`, `pass 3275`, `fail 0`,
  `cancelled 0`, `skipped 0`. `eslint .` clean. Migrations `0001`-`0004` applied, `db status
ok`.
- Proof — run exactly as the EPIC's `## Verification gate` writes it:
  ```bash
  node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 \
    && node scripts/e2e/run.mjs P1-E4 \
    && echo "PASS EPIC-011"
  ```
  exit 0, final line printed exactly `PASS EPIC-011`. Confirmed post-run that P1-E4's own
  teardown (the resource ledger, not `reclaimByLabel`) leaves nothing behind:
  `podman ps -a`, `pod ps`, `volume ls`, `network ls` filtered by
  `label=kanthord-e2e-run` all empty, and `podman images` shows no leftover
  `kanthord-e2e-*` image after the run's own `podman image rm --force` calls. This
  independently confirms P1-E4's own cleanup path (which removes containers before the pod,
  unlike `reclaimByLabel`'s fixed kind order) does not hit the ordering quirk noted above.

**Restated OPEN items for the human (unchanged from the prior turn, not resolved here).**

- Story 02's `eslint.config.js` `no-restricted-imports` rule is still an `OPEN:` for the
  human: `eslint.config.js` is on the always-forbidden edit list for both engineer lanes.
  Per the reviewer's S4 finding, a blanket module ban on the scenario glob fails lint on
  `journey.ts`, `p1-e2.ts`, `p1-e3.ts` and `scenario/tools.ts`, which import `node:fs*` for
  legitimate reads. The achievable rule uses `importNames`, restricting only `rm`/`rmSync`/
  `rmdir` from `node:fs*` and `spawn`/`spawnSync`/`execFile*`/`exec` from
  `node:child_process` — `importNames` matches the imported binding, so a rename such as
  `import { rm as removeTree }` is still caught.
- B3 (disclosure.ts vacuity — redaction runs before every surface `assertNoDisclosure` reads)
  and S2/S5/S6/S7/S8/S9 remain `action:NO`/`NEEDS-HUMAN` per the prior review-routing turn;
  none was routed to this lane and none is touched this turn.

**Tasks closed.** All 12/12 Stories of EPIC 011 remain green; this turn is confirm-GREEN plus
independent re-verification only, with no new Task opened.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 && node scripts/e2e/run.mjs P1-E4 && echo "PASS EPIC-011") — "PASS EPIC-011"
- stories: 12/12 complete
- date: 2026-08-08
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: FAIL — recorded by the orchestrator on Ulrich's instruction of 2026-08-09, after he reviewed the eight action:NO findings and selected four to fix. B3 and S4 were fixed by hand before this verdict and are NOT routed here: redaction moved to the egress points, the transport oracle stopped formatting the bearer value into its log, and the eslint no-restricted-imports rule landed in the importNames form. S2 is WITHDRAWN — the S1 fix made the retry reachable and load-bearing, so the "unreachable retry" premise no longer holds. S7 is documentation only and is already amended in Story 10.
BLOCKER: S5 — the two `podman image rm --force` release closures in p1-e4.ts are the last teardown written inside a scenario file. Add `takeImage(context, execute, id)` to resources.ts per the amended Story 02 section and call it twice; p1-e4.ts then contains no `release(` at all.
BLOCKER: S6 — provision.ts:270 removes its scratch directory with `rmSync`, so Story 02's "resources.ts is the only module in the harness that removes a directory tree" is false. Export `removeTree(path)` from resources.ts and have provision.ts call it in the same `finally`. Keep the prompt deletion: that directory holds a tarball and two node_modules trees, so ledger ownership would hold hundreds of megabytes for the length of a run.
BLOCKER: S8 — assertNoDisclosure throws from p1-e4.ts's `finally`, so a disclosure failure discards the phase-5..10 error already in flight. Implement the three-case contract in the amended Story 10 section: attach `disclosureFailure` to the original error and rethrow that same object when both fail.
BLOCKER: S9 — the fourth repository-name seam (name → id, before the write in import-plan.ts) has no case of its own; all three existing cases reject at an id → name lookup first. Add the case the amended Story 04 Verify block names, seeding the missing repository row after the document is accepted and before the write, so the refusal names the unresolved NAME.

## TEST-ENGINEER — Story 02/04/10 review blockers · S5, S6, S8 (tests), S9 (test + fix, entirely mine)

**Cycle.** RED for the review-routed blockers S5, S6, S8 (test half only — each needs a
production edit the software-engineer owns) and S9 (test-engineer-owned end to end, per the
routing message: "the fourth-seam case in `src/commands/plan/import-plan.test.ts`").

**Test written.**

- file: `scripts/e2e/lib/resources.test.ts` (edited) — suite: `scripts/e2e/lib/resources.ts` —
  new cases:
  - `"takeImage takes one handle of kind image, and releaseAll issues exactly podman image rm --force <id>"` —
    asserts `ledger.taken()` holds one `{ kind: "image", id: "sha256:abc" }` handle and that
    `releaseAll` drives a recording `PodmanExecutor` with exactly
    `["podman", "image", "rm", "--force", "sha256:abc"]`.
  - `"removeTree removes a populated directory, and resolves without throwing on an absent path"` —
    asserts a populated `mkdtemp` directory is gone after `removeTree`, and a second call on the
    now-absent path (and a never-existed child path) resolves rather than rejecting.
- file: `scripts/e2e/lib/podman/provision.test.ts` (edited) — suite:
  `scripts/e2e/lib/podman/provision.ts` — two new cases asserting no `kanthord-e2e-provision-`
  scratch entry survives in `tmpdir()` after `provisionImages` resolves, and none survives after
  it rejects (the `missingBaseImage` fake). Diffed against a `before` snapshot of `tmpdir()`
  entries so the assertion is sensitive to a genuinely new leftover rather than an
  already-present unrelated directory.
- file: `scripts/e2e/lib/scenario/p1-e4.test.ts` (edited) — suite:
  `scripts/e2e/lib/scenario/p1-e4.ts` — three new cases:
  - `"p1-e4.ts contains no release( at all — the two image handles are taken through takeImage"` —
    reads the sibling source file by `import.meta.dirname`-relative path (never the cwd) and
    asserts the text holds no `release(` substring.
  - `"a fake run that fails in phase 8 and also discloses a secret rejects with the phase-8
error object itself, carrying disclosureFailure"` — a new `discloseSecret` `FakeOptions`
    flag makes the fake's `podman logs` handler echo the held bearer token, forcing
    `no-disclosure-basic-header` to fail in phase 11. Combined with `failJourney: true`
    (phase 8's `credential-registered` assertion fails first). `buildContext` gained an optional
    `onAssertionFailure(error)` callback (test-file-local, invoked from the same `assert()`
    method that already throws `RunnerError("assertion-failed", name)`) so the test can capture
    a reference to the _first_ failing assertion's exact error object without guessing its
    identity. Asserts `caught === capturedThrown` (`assert.equal`, per the Story's identity
    requirement) and that `caught.disclosureFailure` is an `Error` whose `.message` is
    `"no-disclosure-basic-header"`.
  - `"a fake run that succeeds through phase 10 and discloses a secret rejects with the
disclosure error, carrying no disclosureFailure"` — same `discloseSecret` flag alone (no
    `failJourney`). Asserts `caught` is a `RunnerError` with `code: "assertion-failed"` and
    `message: "no-disclosure-basic-header"`, and carries no `disclosureFailure` own property.
- file: `src/commands/plan/import-plan.test.ts` (edited) — suite:
  `src/commands/plan/import-plan.ts` — one new case inside `describe("the repository binding")`,
  reusing the existing `namedRepoDocuments`/`namedRepoChoices` helpers: `"the name → id lookup
gets its own case: a registered repository row removed after the revision is accepted and
before the write is refused naming the unresolved name"`. Seeds a registered repository
  (`seedRegistry`) and a fresh document set naming it by name (`kanthord-verify`), then — on a
  **raw** `DatabaseSync(fixture.path)` connection with `PRAGMA foreign_keys = OFF` — creates a
  SQL trigger, `AFTER INSERT ON plan_revision … DELETE FROM repository WHERE name =
'kanthord-verify'`. `importPlan` mints and inserts the `plan_revision` row (the accepted
  revision) strictly before it reads `repositoryIdsByName` for the write, so the trigger fires
  exactly in that gap — deleting the row after the document is accepted and before the write,
  on the _same_ connection/transaction `importPlan` itself uses, without any change to
  `import-plan.ts`. Asserts `error.refusal === "repository-unknown"` and `error.message` matches
  `/kanthord-verify/` — the unresolved **name**, not an id, distinguishing this from the three
  existing id → name cases.

**RED proof.**

- command: `npm run typecheck` — exit non-zero before the stub probe:
  `scripts/e2e/lib/resources.test.ts(13,3): error TS2305: … no exported member 'takeImage'` and
  the same for `'removeTree'` — the missing seam.
- typecheck stub probe: wrote a throwaway `takeImage`/`removeTree` stub (Story-declared
  signatures, `throw new Error("stub")` bodies) at the end of `scripts/e2e/lib/resources.ts`,
  reran `npm run typecheck` — clean, 0 errors in my own files — then deleted the stub
  (`git diff --stat scripts/e2e/lib/resources.ts` confirms no trace left). Recorded per protocol:
  `stub probe: scripts/e2e/lib/resources.ts — 0 errors found, none to fix`.
- command: `node --test src/commands/plan/import-plan.test.ts scripts/e2e/lib/resources.test.ts scripts/e2e/lib/podman/provision.test.ts scripts/e2e/lib/scenario/p1-e4.test.ts`
- result: `tests 56`, `pass 52`, `fail 4`.
  - `scripts/e2e/lib/resources.test.ts` fails to even load: `SyntaxError: The requested module
'./resources.ts' does not provide an export named 'removeTree'` — RED for S6's
    seam (also covers S5's `takeImage` seam in the same file).
  - `scripts/e2e/lib/scenario/p1-e4.test.ts`:
    - `"p1-e4.ts contains no release( at all …"` — `AssertionError: true !== false` (S5: the
      two `release()` closures are still there).
    - `"a fake run that fails in phase 8 and also discloses a secret rejects with the phase-8
error object itself, carrying disclosureFailure"` — `AssertionError: Expected "actual" to
be reference-equal to "expected"` — `actual: [RunnerError: no-disclosure-basic-header]`,
      `expected: [RunnerError: credential-registered]` — proves the exact defect S8 names: the
      unguarded `finally { await assertNoDisclosure(...) }` in `p1-e4.ts` lets the disclosure
      error silently **replace** the phase-8 error already in flight, rather than attaching it
      as `disclosureFailure`.
    - the "disclosure-only-fails" case passes already (case 1/2 of the Story's three-case
      contract hold today by ordinary JS `finally` semantics — a `finally` that doesn't itself
      throw never disturbs a pending exception, and a `try` that never threw is not disturbed by
      a `finally` that does throw; only the "both fail" case needs the software-engineer's fix).
      Not vacuous: it drives a genuinely new fake path (`discloseSecret`) and pins the exact
      exit shape (`RunnerError`, `code`, `message`, absent `disclosureFailure`) the fix must
      still produce.
    - `provisionImages` scratch-directory absence held on both paths already (`rmSync` already
      removes it) — the Story frames this pair as preserved behaviour, not a S6-sensitive case;
      S6 is proved RED by `resources.test.ts`'s missing `removeTree` export instead.
- S9, proven sensitive by reverting the seam: `git stash push -- src/commands/plan/import-plan.ts src/queries/plan/export-plan.ts src/queries/plan/validate-plan.ts`, then
  `node --test src/commands/plan/import-plan.test.ts` — the new case failed for the right
  reason: `AssertionError [ERR_ASSERTION]: expected an ImportPlanError, got Error: FOREIGN KEY
constraint failed` (the pre-fix code wrote the raw name straight into `node.repository_id`,
  which the FK to `repository(id)` then rejects, instead of the named `repository-unknown`
  refusal). `git stash pop` restored the fix; `node --test src/commands/plan/import-plan.test.ts`
  is 41/41 green again, S9 fully closed this turn.

**Open to Software Engineer.**

- `scripts/e2e/lib/resources.ts` — S5/S6: add `takeImage(context: Pick<ScenarioContext, "take">,
execute: PodmanExecutor, id: string): void` and `removeTree(path: string): Promise<void>`, per
  the amended `.agents/plan/stories/011-end-to-end-scenarios/02-cleanup-is-central.md` "New —
  `takeImage` and `removeTree` in `scripts/e2e/lib/resources.ts`" section. `resources.test.ts`'s
  two new cases are the RED tests these satisfy.
- `scripts/e2e/lib/scenario/p1-e4.ts` — S5: replace the two inline `release()` closures (image
  cleanup) with two `takeImage(context, execute, ...)` calls, per the same Story section. The
  file must then hold no `release(` substring at all — `p1-e4.test.ts`'s new source-text case is
  the RED test.
- `scripts/e2e/lib/podman/provision.ts` — S6: call `removeTree` (from `resources.ts`) instead of
  `rmSync` in the existing `finally`, per the Story's "`provision.ts` calls `removeTree` in the
  same `finally` it uses today." No behavioural test forces this one (the resulting absence is
  already true either way); it is enforced by the harness invariant text and — per the routing
  turn's own note, still `OPEN:` for the human — by an `eslint.config.js` glob widening this
  cycle does not touch.
- `scripts/e2e/lib/scenario/p1-e4.ts` — S8: wrap the phase 11 `finally { await
assertNoDisclosure(...) }` per the amended `.agents/plan/stories/011-end-to-end-scenarios/10-secret-handling.md`
  three-case `WithDisclosureFailure` contract — catch phases 5-10's error, run disclosure inside
  a nested `try`/`catch`, and when both fail attach the disclosure error to the **original**
  object as `disclosureFailure` and rethrow that same original object. `p1-e4.test.ts`'s
  "both fail" case (`assert.equal(caught, thrown)` via the captured first-failing-assertion
  reference) is the RED test this satisfies; the "disclosure-only-fails" case is already green
  and must stay green.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 02/10 review blockers · S5, S6, S8 GREEN

**Cycle.** GREEN for the review-routed blockers S5, S6, S8, closing the three production
seams the test-engineer's RED turn left open for this lane.

**Files changed.**

- `scripts/e2e/lib/resources.ts` (edited) — new `takeImage(context: Pick<ScenarioContext,
"take">, execute: PodmanExecutor, id: string): void`, taking one `image`-kind handle
  released with `podman image rm --force <id>`; new `removeTree(path: string): Promise<void>`,
  exactly `rm(path, { recursive: true, force: true })`. Added a type-only import of
  `PodmanExecutor` from `./driver/podman.ts`.
- `scripts/e2e/lib/scenario/p1-e4.ts` (edited) — phase 3 now calls `takeImage(context, execute,
provision.images.product)` and `takeImage(context, execute, provision.images.fixture)`,
  replacing the two inline `context.take({ ..., release() {...} })` closures; the file now
  contains no `release(` substring. Phase 11 changed from an unconditional `finally` to a
  `catch`-based three-case contract: exported `WithDisclosureFailure = Error & {
disclosureFailure?: Error }`; on success, `assertNoDisclosure` runs after the `try` block and
  any rejection propagates as-is (case 1); on a phase 5-10 failure, disclosure runs inside a
  nested `try`/`catch` — if it succeeds the original `error` is rethrown unchanged (case 2), if
  it also fails the disclosure error is attached to the **same** caught `error` object as
  `.disclosureFailure` before rethrowing that same object (case 3).
- `scripts/e2e/lib/podman/provision.ts` (edited) — removed the `rmSync` import from `node:fs`,
  added `import { removeTree } from "../resources.ts"`, and the scratch-directory `finally`
  now calls `await removeTree(work)` in place of `rmSync(work, { recursive: true, force: true
})`. The prompt-deletion behaviour is unchanged; `provision.ts` still does not join the
  ledger, per the Story's explicit carve-out.

**Seam (GREEN).**

- S5: `resources.test.ts`'s `"takeImage takes one handle of kind image, and releaseAll issues
exactly podman image rm --force <id>"` now finds the export and observes the exact argv;
  `p1-e4.test.ts`'s `"p1-e4.ts contains no release( at all"` source-text scan now finds no
  match, and the existing image-handle case keeps passing because `takeImage`'s handle shape
  (`{ kind: "image", id }`) is identical to the closures it replaced.
- S6: `resources.ts` is now the only module importing a directory-removal function under
  `scripts/e2e/lib/**` outside the eslint-ignored file itself; `provision.ts` calls the
  chokepoint instead of its own `rmSync`.
- S8: `p1-e4.test.ts`'s "both fail" case now sees `assert.equal(caught, capturedThrown)` hold
  (the same object identity is rethrown) with `caught.disclosureFailure` an `Error` whose
  message is `"no-disclosure-basic-header"`; the already-green "disclosure-only-fails" case
  stays green because a `try` that never threw still rejects with the disclosure error alone,
  carrying no `disclosureFailure`.

**Refactor.** None named beyond the GREEN seam; the phase-3 image handles and the phase-11
control flow are the smallest structural change satisfying the three failing assertions.

**Build check.**

- typecheck: exit 0 (`npm run typecheck`)
- lint: `npx eslint scripts/e2e/lib/scenario/p1-e4.ts scripts/e2e/lib/resources.ts
scripts/e2e/lib/podman/provision.ts` — exit 0, no output

**Assumptions.**

- VERIFIED: `WithDisclosureFailure` is not imported anywhere in `p1-e4.test.ts` (`grep` found
  no reference), so it is declared locally in `p1-e4.ts`, mirroring `WithCleanupFailures`'s
  placement in `resources.ts` rather than being re-exported from `disclosure.ts`.
- VERIFIED: `resources.test.ts`'s new `takeImage`/`removeTree` cases and `p1-e4.test.ts`'s new
  source-text and disclosure-identity cases match the implementation's exact behaviour and
  argv shape by direct read of the test file.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — confirm-GREEN for review blockers S5, S6, S8, S9

**Cycle.** Confirm-GREEN for the four routed blockers (S5, S6, S8, S9) after the
software-engineer's `takeImage`/`removeTree`/`p1-e4.ts` three-case `disclosureFailure`
turn, plus independent re-verification of the two human-landed structural invariants.

**Handoff verification gate.**

- SE's last turn cited `npm run typecheck` (exit 0) and a scoped `npx eslint` run over the
  three edited files (exit 0). Independently re-ran `npm run verify:handoff`:
  `VERIFY: PASS — npm run typecheck is clean` — exit 0. Gate holds.

**Test proof — the four named suites.**

- command: `node --test scripts/e2e/lib/resources.test.ts scripts/e2e/lib/podman/provision.test.ts scripts/e2e/lib/scenario/p1-e4.test.ts src/commands/plan/import-plan.test.ts`
- result: `tests 70`, `suites 8`, `pass 70`, `fail 0`, `cancelled 0`, `skipped 0` — every
  case green, including the S5 `takeImage`/no-`release(` cases, the S6 `removeTree` cases,
  both S8 disclosure-identity cases (the previously-red "both fail" case now holds
  `assert.equal(caught, capturedThrown)` with `caught.disclosureFailure.message ===
"no-disclosure-basic-header"`), and S9's fourth-seam `repository-unknown` case.

**Structural invariants — verified independently, not assumed.**

- `grep -n "release(" scripts/e2e/lib/scenario/p1-e4.ts` — no match (exit 1, empty output):
  `p1-e4.ts` contains no `release(` at all; the two image handles now go through
  `takeImage`.
- Read `eslint.config.js` lines 360-393: the `scripts/e2e/lib/**/*.ts` removal-chokepoint
  block ignores exactly `**/*.test.ts`, `resources.ts`, `secret-file.ts`, and
  `driver/**/*.ts`, matching the operator's description. `grep -rn` for `rm`/`rmSync`/
  `rmdir` imports from `node:fs*` under `scripts/e2e/lib/**` found matches only in those
  four exempt classes (test files, `resources.ts` itself, `secret-file.ts`,
  `driver/local.ts`) — `provision.ts` itself now imports `removeTree` from `resources.ts`
  and holds no `rm`-family import.
- `npx eslint scripts/e2e/lib/podman/provision.ts scripts/e2e/lib/scenario/p1-e4.ts scripts/e2e/lib/resources.ts` — exit 0, no output. Confirms the operator's hand-probe
  ("reintroducing `rmSync` into `provision.ts` fails lint") is consistent with the current
  passing state under the real rule.

**Verification gate — both parts, run this turn.**

- Gates: `npm run verify` → `tsc --noEmit` clean, `node --test` → `tests 3286, pass 3286,
fail 0`, `eslint .` clean, `verify-db-status.ts` → `verify db status ok`. Exit 0.
- Proof: `node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 && node scripts/e2e/run.mjs P1-E4 && echo "PASS EPIC-011"` — all three scenarios ran end to end
  (packaged binary install, daemon lifecycle, credential/repository/project/plan round
  trip, the hostile-client cases, and the full three-container P1-E4 topology with
  provisioning, run, assertion and label-scoped cleanup) and the final line printed is
  exactly `PASS EPIC-011`.

**Tasks closed.** All 12/12 Stories of EPIC 011 remain green. This turn closes the four
review-routed blockers (S5, S6, S8, S9) with independent re-verification; no new Task is
opened, and the two structural invariants the human landed by hand are confirmed rather
than assumed.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 && node scripts/e2e/run.mjs P1-E4 && echo "PASS EPIC-011") — "PASS EPIC-011"
- stories: 12/12 complete
- date: 2026-08-09
- state: local-uncommitted

END: TEST-ENGINEER

## OPERATOR — cycle 3 reviewer gate, B1 fixed out of lane

The cycle-3 reviewer returned 2 blockers and 3 suggestions, all tagged `action:NO`, so no
engineer-lane work was routable. Both blockers are answered here rather than through the
loop, because each falls outside both lanes.

**B1 — the removal ban did not apply to `scenario/**`, the one directory it was written for.**
`eslint.config.js` declared `no-restricted-imports` twice over overlapping globs, and flat
config resolves a rule by **last wins per rule name**, never by union. The scenario block
therefore replaced the removal entries with its `node:child_process` entry. The reviewer
disproved the rule with `--print-config` and an `--stdin` probe instead of reading the config
and reasoning about it; the earlier hand-probe had passed only because it tested
`provision.ts`, which the first block covers.

Fixed by the operator: the two globs are now disjoint, the shared entries are hoisted into a
`removalPaths` constant, and the scenario block repeats them rather than adding to them.
Suggestion S2 is folded in at the same time — `"default"` joins each entry's `importNames`.
Probed across the matrix: named `rm`, aliased `rm`, default import and namespace import are
each caught under `scenario/**` and under `podman/**`; `node:child_process` is caught under
`scenario/**` and allowed under `driver/**`, which spawns by definition; `readFile` and
`readdir` stay allowed everywhere.

**B2 — the Proof had not been run by the reviewer**, which is correct: it needs a reachable
Podman and the pinned base image, so the reviewer declined to fake it. The operator ran the
full chain after every cycle-3 edit, the eslint fix included.

- gates: PASS — `npm run verify`, `tests 3286`, `pass 3286`, `fail 0`, eslint clean,
  `kanthord: verify db status ok`
- proof: PASS — `node scripts/e2e/run.mjs P1-E1 && … P1-E2 && … P1-E4 && echo "PASS EPIC-011"`
  printed `PASS EPIC-011`
- no container, pod, volume, network or image carrying `label=kanthord-e2e-run` remained
  afterwards, which is the specific check B2 asked for now that image removal moved from two
  inline closures into `releaseAll`

Three `action:NO` findings stay open and block nothing: S1, the shared-`tmpdir()` listing in
`provision.test.ts`, a flake risk against a parallel P1-E4 run; S2's residue, dynamic
`import("node:fs")`; and S3, phase 7's container-side `podman exec … rm -f`, which is argv
rather than an import and so reaches neither guard.

HUMAN_REVIEW: PASS
