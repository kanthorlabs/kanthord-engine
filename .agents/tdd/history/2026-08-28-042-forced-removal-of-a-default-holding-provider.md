---
epic: .agents/plan/epics/042-forced-removal-of-a-default-holding-provider.md
opened: 2026-08-28
opener: test-engineer
base-ref: 7391bb9076c8343e7498dbe42faac5b50e1bb287
---

# Implementation cycle — 042-forced-removal-of-a-default-holding-provider

Pulled from EPIC: `.agents/plan/epics/042-forced-removal-of-a-default-holding-provider.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/commands/provider/remove-provider.test.ts \
>   src/http/contract/credential.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/server/credential/remove-provider.test.ts \
>   src/http/server/credential/refusals.test.ts \
>   src/main.test.ts \
>   && echo "PASS EPIC-042"
> ```

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — command-force-flag · Task 042/story-1

**Cycle.** RED for Task `042/story-1` (`src/commands/provider/remove-provider.test.ts`).
**Test written.**

- file: `src/commands/provider/remove-provider.test.ts` (edited) — suite: `src/commands/provider/remove-provider.test` — methods: `a stamped provider with no other blocker refuses with default-chain when force is false`, `a stamped provider with no other blocker is removed when force is true`, `a forced removal of a stamped provider appends provider.removed and not provider.defaultUnset`, `a stamped provider blocked by all four causes refuses with three blockers when force is true`, `an unstamped provider removed with force true and force false produces identical rows`, `after forced removal of the stamped llm provider a new llm registration auto-stamps`
- asserts: A boolean force input suppresses only the default-chain blocker, preserves referential refusals, records one removal event, and permits a later llm auto-stamp.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failures: `✖ a stamped provider with no other blocker is removed when force is true (11.838709ms)`; `✖ a forced removal of a stamped provider appends provider.removed and not provider.defaultUnset (16.053333ms)`; `✖ a stamped provider blocked by all four causes refuses with three blockers when force is true (16.739209ms)`; `✖ after forced removal of the stamped llm provider a new llm registration auto-stamps (11.409458ms)`
- result: `ℹ tests 5468`, `ℹ pass 5464`, `ℹ fail 4`
  **Open to Software Engineer.**
- `src/commands/provider/remove-provider.ts`: exported `RemoveProviderInput` includes required `force: boolean`; exported `removeProvider(dependencies: RemoveProviderDependencies, input: RemoveProviderInput): Readonly<{ id: string }>` is the tested seam.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — command-force-flag · Task 042/story-1

**Cycle.** GREEN+REFACTOR for `src/commands/provider/remove-provider.test.ts`.
**Files changed.**

- `src/commands/provider/remove-provider.ts` (edited) — required `force` input and default-chain guard.
  **Seam (GREEN).** `force: true` suppresses only the `default-chain` blocker; all referential blockers remain collected.
  **Refactor.** None named; applied no additional change.
  **Build check.**
- typecheck: exit 2 — `src/http/server/credential/remove-provider.ts:19` omits required `force` from the dependent Story 3 call.
  **Assumptions.**
- VERIFIED: Story 1 names only `src/commands/provider/remove-provider.ts` for production changes.

OPEN: `src/http/server/credential/remove-provider.ts` — the coupled Story 3 handler must pass `force` before the whole-repository typecheck can pass, but that path is outside Task 042/story-1.
ATTEMPT-FAILED: 042/story-1 — the mandatory whole-repository typecheck remains red on the dependent handler call.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed
**Verification result.**

```text

> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

src/http/server/credential/remove-provider.ts(19,51): error TS2345: Argument of type '{ id: string; actor: string; }' is not assignable to parameter of type 'Readonly<{ id: string; actor: string; force: boolean; }>'.
  Property 'force' is missing in type '{ id: string; actor: string; }' but required in type 'Readonly<{ id: string; actor: string; force: boolean; }>'.
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** SE must fix the build, re-run with log output, verify, and resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — command-force-flag · Task 042/story-1

**Cycle.** GREEN+REFACTOR continuation for `src/commands/provider/remove-provider.test.ts`.
**Files changed.**

- `src/http/server/credential/remove-provider.ts` (edited) — supplies the required `force: false` value on the existing no-query path.
  **Seam (GREEN).** The existing handler call now satisfies `RemoveProviderInput` while absent `force` remains false.
  **Refactor.** None named; restored the coupled handler call required by Story 1's input change.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `removeProviderHandler` still maps an absent query to the unforced command path; Story 3 owns query parsing.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — contract-query-param · Task 042/story-2

**Cycle.** RED for Task `042/story-2` (`src/http/contract/credential.test.ts`).
**Test written.**

- file: `src/http/contract/credential.test.ts` (edited) — suite: `src/http/contract/credential.test` — methods: `providerRemoveRequest parses valid force values and rejects invalid ones`, `the remove examples carry the exact story values`, `every example parses against its own strict schema and envelope`
- asserts: The provider removal contract accepts only optional `force` values `"true"` and `"false"`, rejects invalid or unknown query values, and validates its query example.
  **RED proof.**
- handoff gate: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean` before this RED change
- command: `npm test -- src/http/contract/credential.test.ts`
- exit: non-zero — failure: `SyntaxError: The requested module './credential.ts' does not provide an export named 'providerRemoveRequest'`
- typecheck probe: `npm run typecheck` — only the expected missing-export error remains: `TS2724: '"./credential.ts"' has no exported member named 'providerRemoveRequest'.`
  **Open to Software Engineer.**
- `src/http/contract/credential.ts`: exported `providerRemoveRequest` schema accepting `{ force?: "true" | "false" }`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — contract-query-param · Task 042/story-2

**Cycle.** GREEN+REFACTOR for `src/http/contract/credential.test.ts`.
**Files changed.**

- `src/http/contract/credential.ts` (edited) — `providerRemoveRequest`, registry query schema, and query example.
  **Seam (GREEN).** `provider.remove` now accepts only optional `force` values of `"true"` or `"false"` through its strict query schema.
  **Refactor.** None named; applied the requested contract additions only.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `providerRemoveExamples.query` uses `force: "false"`, matching the unforced blocker example and the Story 2 contract.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — handler-force-param · Task 042/story-3

**Cycle.** RED for Task `042/story-3` (`src/http/server/credential/remove-provider.test.ts`).
**Test written.**

- file: `src/http/server/credential/remove-provider.test.ts` (edited) — suite: `src/http/server/credential/remove-provider.test` — methods: `force=true passes force true to the command`, `force=false passes force false to the command`, `an absent force parameter passes force false to the command`, `force=1 answers 400 invalid-request without calling the command`, `force=yes answers 400 invalid-request without calling the command`, `force=TRUE answers 400 invalid-request without calling the command`, `an empty force value answers 400 invalid-request without calling the command`, `two force values answer 400 invalid-request without calling the command`
- asserts: The handler converts valid query values to a boolean and refuses invalid or repeated force values before calling the command.
  **RED proof.**
- handoff gate: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- command: `npm test -- src/http/server/credential/remove-provider.test.ts`
- exit: non-zero — failures: `✖ force=true passes force true to the command (13.27275ms)`; `✖ force=1 answers 400 invalid-request without calling the command (0.622458ms)`; `✖ force=yes answers 400 invalid-request without calling the command (0.487708ms)`; `✖ force=TRUE answers 400 invalid-request without calling the command (3.76175ms)`; `✖ an empty force value answers 400 invalid-request without calling the command (0.517833ms)`; `✖ two force values answer 400 invalid-request without calling the command (0.493375ms)`
  **Open to Software Engineer.**
- `src/http/server/credential/remove-provider.ts`: exported `removeProviderHandler(dependencies: RemoveProviderHandlerDependencies): Handler`; its `removeProvider` dependency accepts `RemoveProviderInput` with `force: boolean`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — handler-force-param · Task 042/story-3

**Cycle.** GREEN+REFACTOR for `src/http/server/credential/remove-provider.test.ts`.
**Files changed.**

- `src/http/server/credential/remove-provider.ts` (edited) — parses the force query and passes a boolean.
  **Seam (GREEN).** The handler rejects invalid or repeated force values before calling the command.
  **Refactor.** None named; applied the specified query parsing and boolean conversion.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `singleValued` runs before `providerRemoveRequest`, as specified by Story 3.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — proposal-amend · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: `042/story-4`.
**Build proof.**

- handoff gate: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- build-only check: `npm run typecheck` — exit 0
  **Story file.** `.agents/plan/stories/042-forced-removal-of-a-default-holding-provider/04-proposal-amend.md`
  **Tasks forwarded to Software Engineer.**
- `042/story-4`: `docs/proposal/api/credential.md` — record the force override asymmetry required by the Story.
  **No RED phase.** Coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR per the Story file's Action sections for `docs/proposal/api/credential.md`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — proposal-amend · Task 042/story-4

**Cycle.** GREEN+REFACTOR for `docs/proposal/api/credential.md`.
**Files changed.**

- `docs/proposal/api/credential.md` (edited) — documented the force override asymmetry.
  **Seam (GREEN).** The proposal states that `force=true` suppresses only `default-chain` and preserves the three referential blockers.
  **Refactor.** None named; applied no additional change.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The inserted paragraph matches the Story's required force semantics and leaves the existing blocker list and follow-up prose unchanged.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation verification blocked

**Cycle.** Confirm GREEN for Tasks `042/story-1` through `042/story-4` is blocked by the EPIC verification gate.
**Test written.**

- file: `src/http/contract/registry.test.ts` (edited) — suite: `src/http/contract/registry.test` — methods: `event.list, node.list, provider.catalog and provider.remove are the only operations with a query schema`
- file: `src/http/contract/example.test.ts` (edited) — suite: `src/http/contract/example.test` — methods: `every example parses against its declared schema`
- file: `src/http/contract/coverage.test.ts` (edited) — suite: `src/http/contract/coverage.test` — methods: `every z.enum argument in src/http/contract/ traces to a domain/ import, and no restated literal or blob-hash pattern exists`, `every field in the registry answers required, nullability and enum, matching the reviewed fixture`
- asserts: The contract tests include the `provider.remove` query while preserving the required transport enum and exact field-decision coverage.
  **Verification result.**
- handoff gate: `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- Story 1 gate: `npm test -- src/commands/provider/remove-provider.test.ts` → exit 0 — `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`
- Story 2 gate: `npm test -- src/http/contract/credential.test.ts src/http/contract/registry.test.ts` → exit 0 — `ℹ tests 83`, `ℹ pass 83`, `ℹ fail 0`
- Story 3 gate: `npm test -- src/http/server/credential/remove-provider.test.ts src/http/server/credential/refusals.test.ts src/main.test.ts` → exit 0 — `ℹ tests 37`, `ℹ pass 37`, `ℹ fail 0`
- field-decision probe: `node scripts/field-decisions-probe.mjs` → exit 1 — `walked 658 rows, fixture has 657`; missing `provider.remove.query#/properties/force required=false nullable=false enum=true,false`
- EPIC Gates: `npm run verify` → exit 1 — `ℹ tests 5477`, `ℹ pass 5476`, `ℹ fail 1`; failure: `✖ every field in the registry answers required, nullability and enum, matching the reviewed fixture (18.894417ms)`
  **Open to Software Engineer.**
- `src/http/contract/field-decisions.fixture.ts`: exported `fieldDecisions` is missing `provider.remove.query#/properties/force required=false nullable=false enum=true,false`.

ATTEMPT-FAILED: 042/story-2 — `npm run verify` remains red because the field-decision fixture lacks the provider.remove force query row.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — contract-query-param · Task 042/story-2

**Cycle.** GREEN+REFACTOR continuation for `src/http/contract/coverage.test.ts`.
**Files changed.**

- `src/http/contract/field-decisions.fixture.ts` (edited) — added the provider.remove force query field-decision row.
  **Seam (GREEN).** The reviewed fixture now records the strict optional force query field and its true,false enum.
  **Refactor.** None named; applied only the missing fixture row.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The added row matches the field-decision probe output reported by the test-engineer.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** All four Stories are implemented. Independent handoff verification passed, all Story gates passed, and `npm run verify` passed.

- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0
- Gates (`npm run verify`) → exit 0
  **Proof.** `node --test src/commands/provider/remove-provider.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/remove-provider.test.ts src/http/server/credential/refusals.test.ts src/main.test.ts && echo "PASS EPIC-042"` → exit 0; printed `PASS EPIC-042`.
  **Tasks closed.** 4 across 4 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/commands/provider/remove-provider.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/remove-provider.test.ts src/http/server/credential/refusals.test.ts src/main.test.ts && echo "PASS EPIC-042") — "PASS EPIC-042"
- stories: 4/4 complete
- date: 2026-08-29
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 3 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 Missing response-body equivalence assertion — src/http/server/credential/remove-provider.test.ts:72-116 must deep-equal the absent-force and force=false response bodies.
BLOCKER: B2 Missing persisted-row assertions for invalid values — src/http/server/credential/remove-provider.test.ts:118-196 must assert the provider row remains after force=, force=1, force=yes, and force=TRUE.
BLOCKER: B3 Refusal key assertion uses a weaker joined-string proxy — src/commands/provider/remove-provider.test.ts:416-419 must deep-equal Object.keys(error).sort() against ["blockers", "name", "refusal"].

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Review-blocker regression coverage is complete. All four Stories remain implemented.

- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0 — `ℹ tests 5478`, `ℹ pass 5478`, `ℹ fail 0`
- Gates (`npm run verify`) → exit 0
  **Proof.** `node --test src/commands/provider/remove-provider.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/remove-provider.test.ts src/http/server/credential/refusals.test.ts src/main.test.ts && echo "PASS EPIC-042"` → exit 0; printed `PASS EPIC-042`.
  **Tasks closed.** 4 across 4 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/commands/provider/remove-provider.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/remove-provider.test.ts src/http/server/credential/refusals.test.ts src/main.test.ts && echo "PASS EPIC-042") — "PASS EPIC-042"
- stories: 4/4 complete
- date: 2026-08-29
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
