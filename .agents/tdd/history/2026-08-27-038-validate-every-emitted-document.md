---
epic: .agents/plan/epics/038-validate-every-emitted-document.md
opened: 2026-08-27
opener: test-engineer
base-ref: 3878e49775a3e070c9c3294a4a2afd26d4572eb7
---

# Implementation cycle — 038-validate-every-emitted-document

Pulled from EPIC: `.agents/plan/epics/038-validate-every-emitted-document.md`.

Verification gate (binding, from the EPIC's "## Verification Gate" section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/contract/openapi.test.ts \
>   src/http/contract/example.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/contract/coverage.test.ts \
>   src/http/contract/parity.test.ts \
>   src/http/contract/path.test.ts \
>   src/http/contract/event-payload.test.ts \
>   scripts/publish-contract.test.ts \
>   scripts/release-gate.test.ts \
>   scripts/release-facts.test.ts \
>   && echo "PASS EPIC-038"
> ```
>
> `npm run contract:publish -- "$(mktemp -d)"` exits 0. It is not in the Proof command because it
> writes outside the repository.
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `format`, `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
> - **`SwaggerParser.validate` passes for the master and for each of the 19 slices**, and a deliberately
>   broken slice is rejected. Both directions are asserted, as the master tests at `openapi.test.ts:558`
>   and `:579` assert them. The rejected slice loses `info.version` in one test and holds a dangling
>   `$ref` in the other.
> - **No emitted document holds a `$ref` outside `#/`.** The walk covers all 20 emitted files, and it
>   asserts a non-zero ref count so an empty walk cannot pass.
> - **Two emissions produce identical bytes for every emitted file.** Each slice is compared by exact
>   bytes through `Buffer.compare`. The existing two-directory publish comparison stays green.
> - **`manifest.json` names exactly the features and operations that were written.** The 19 feature
>   names map one to one onto the emitted `features/*.yaml` files, and the 43 operation ids map one to
>   one onto the emitted `examples/*.json` files. The equality is asserted in both directions.
> - **Every test uses its own `mkdtemp` directory and removes it.** No shared temporary directory, no
>   network, no wall clock, no ambient git configuration. `openapi.test.ts` keeps one directory and one
>   `after` hook.
> - **No production source names `@apidevtools/swagger-parser`.** The guard at `openapi.test.ts:582`
>   stays green, and no epic edit lands outside a `.test.ts` file.
> - **The master's bytes are unchanged.** `renderOpenApiYaml()` returns the same string as before the
>   epic, and the emitted `openapi.yaml` still equals it.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — every slice is emitted and validated beside the master · 038/story-1

**Cycle.** Completed test-only Task `038/story-1`; Story 1 has no product RED phase.
**Test written.**

- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi` — methods: `validates the master document and every feature slice`
- asserts: The temporary publication contains one master and 19 feature slices, and validation accepts all 20 files.
  **Proof.**
- command: `npm test` — exit: 0 — `ℹ tests 5363`, `ℹ suites 507`, `ℹ pass 5363`, `ℹ fail 0`
- command: `node --test src/http/contract/openapi.test.ts` — exit: 0 — `ℹ tests 28`, `ℹ pass 28`, `ℹ fail 0`
- command: `node --test --test-name-pattern='validates the master document and every feature slice' src/http/contract/openapi.test.ts` — exit: 0 — `ℹ tests 1`, `ℹ pass 1`, `ℹ fail 0`
- sensitivity probes rejected `20` as `21` with `20 !== 21`, `19` as `18` with `19 !== 18`, and a malformed slice with `SyntaxError: Unsupported OpenAPI version: undefined`.
- command: `npm run verify` — exit: 0
- hermetic checks: one `mkdtempSync(` call; scoped status names only `src/http/contract/openapi.test.ts`.
  **No handoff.** Story 1 changes only the test lane; no production seam exists.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 038-validate-every-emitted-document · no SE-lane work

**Cycle.** Response to the latest TEST-ENGINEER turn for `038/story-1`; Story 1 is test-only and has no production implementation.
**Files changed.**

- None — the Story permits only `src/http/contract/openapi.test.ts`, which is the test-engineer lane.
  **Seam (GREEN).** No production seam exists; the latest TEST-ENGINEER turn reports the Story 1 test green.
  **Refactor.** None — Story 1 has no GREEN or REFACTOR production action.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The next implementation opportunity remains with the test-engineer, which must dispatch Story 2 after this test-only Story.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — a broken slice is rejected · 038/story-2

**Cycle.** Completed test-only Task `038/story-2`; Story 2 has no product RED phase.
**Test written.**

- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi` — methods: `rejects a feature slice missing info.version`, `rejects a feature slice with a dangling schema reference`
- asserts: The `system` feature slice is rejected when it loses `info.version` or holds a dangling schema reference.
  **RED proof.**
- initial command: `npm test` — exit: 0 — `ℹ tests 5365`, `ℹ pass 5365`, `ℹ fail 0`
- isolation command: `node --test --test-name-pattern='rejects a feature slice' src/http/contract/openapi.test.ts` — exit: 0 — `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`
- sensitivity probe without `delete info.version` — exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: Missing expected rejection.`
- sensitivity probe with `#/components/schemas/system.health.response` instead of the missing ref — exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: Missing expected rejection.`
- command: `npm run verify` — exit: 0 — `kanthord: verify db status ok`
- `npm run verify:handoff` before this turn — `VERIFY: PASS — npm run typecheck is clean`
- hermetic check: one existing `mkdtempSync` call; scoped status names only `src/http/contract/openapi.test.ts`

The planned `Error` mutation does not fail because reachability prunes `Error` from the `system` slice; the valid in-slice response reference proves the same sensitivity.
**No handoff.** Story 2 changes only the test lane; no production seam exists.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 038-validate-every-emitted-document · no SE-lane work

**Cycle.** Response to the latest TEST-ENGINEER turn for `038/story-2`; Story 2 is test-only and green.
**Files changed.**

- None — the Story permits only `src/http/contract/openapi.test.ts`, which is the test-engineer lane.
  **Seam (GREEN).** No production seam exists; the latest TEST-ENGINEER turn reports both slice rejection tests green.
  **Refactor.** None — Story 2 has no GREEN or REFACTOR production action.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The test-engineer must dispatch Story 3 next; the scoped diff contains only `src/http/contract/openapi.test.ts`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — no emitted document holds an external ref · 038/story-3

**Cycle.** Completed test-only Task `038/story-3`; Story 3 has no product RED phase.
**Test written.**

- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi` — methods: `emits no $ref outside the document`
- asserts: Every emitted master and feature document has references, and every reference starts `#/components/schemas/`.
  **RED proof.**
- characterization command: `npm test` — exit: 0 — `ℹ tests 5366`, `ℹ pass 5366`, `ℹ fail 0`
- isolation command: `node --test --test-name-pattern='emits no \$ref outside the document' src/http/contract/openapi.test.ts` — exit: 0 — `ℹ tests 1`, `ℹ pass 1`, `ℹ fail 0`
- external-reference sensitivity probe — exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: external or malformed $ref ./common.yaml#/Error in /var/folders/fj/n4pgnws569zc7rthtns4851m0000gn/T/kanthord-openapi-NeqfQk/features/agent.yaml`
- sibling-reference sensitivity probe — exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: external or malformed $ref #/paths/~1v1~1health in /var/folders/fj/n4pgnws569zc7rthtns4851m0000gn/T/kanthord-openapi-yVnaj9/features/agent.yaml`
- empty-walk sensitivity probe — exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: /var/folders/fj/n4pgnws569zc7rthtns4851m0000gn/T/kanthord-openapi-14yCmt/openapi.yaml carries no $ref at all`
- command: `npm run verify` — exit: 0 — `kanthord: verify db status ok`
- handoff re-verification: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`
- hermetic check: `mkdtempSync(` count is `1`; scoped status names only `src/http/contract/openapi.test.ts`

**No handoff.** Story 3 changes only the test lane; no production seam exists.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 038-validate-every-emitted-document · no SE-lane work

**Cycle.** Response to the latest TEST-ENGINEER turn for `038/story-3`; Story 3 is test-only and green.
**Files changed.**

- None — the Story permits only `src/http/contract/openapi.test.ts`, which is the test-engineer lane.
  **Seam (GREEN).** No production seam exists; the latest TEST-ENGINEER turn reports the emitted-document reference walk green.
  **Refactor.** None — Story 3 has no GREEN or REFACTOR production action.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The next implementation opportunity remains with the test-engineer, which must dispatch Story 4 after this test-only Story.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Stories 1–4 are complete. Only the two planned test files changed.

- handoff: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0 — `ℹ tests 5368`, `ℹ pass 5368`, `ℹ fail 0`
- Gates (`npm run verify`) → exit 0 — typecheck, unit tests, lint and database status passed

**Proof.** The EPIC Proof command → exit 0 and printed `PASS EPIC-038`.

**Publication check.** The CLI command returned `dirty-tree` with exit 2 because this tree is local-uncommitted. The in-process publisher tests passed.

**Tasks closed.** 4 across 4 Stories — no Story remains outstanding or unexpanded.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/openapi.test.ts src/http/contract/example.test.ts src/http/contract/registry.test.ts src/http/contract/coverage.test.ts src/http/contract/parity.test.ts src/http/contract/path.test.ts src/http/contract/event-payload.test.ts scripts/publish-contract.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts && echo "PASS EPIC-038") — "PASS EPIC-038"
- stories: 4/4 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 — `.agents/tdd/memory/software-engineer/2026-08-28.md:1` replaces the existing EPIC 037 record; restore the deleted EPIC 037 entries, then append the EPIC 038 entries.
BLOCKER: B2 — `.agents/tdd/memory/test-engineer/2026-08-28.md:1` replaces the existing EPIC 037 record; restore the deleted EPIC 037 entries, then append the EPIC 038 entries.

## TEST-ENGINEER — implementation ready for review

**Review blockers.**

- B1 - status:FIXED - action:YES - software-engineer memory - restored the EPIC 037 entries before the EPIC 038 entries - fix:preserve both epic records in the daily journal - why:the review requires append-only history across epic boundaries.
- B2 - status:FIXED - action:YES - test-engineer memory - restored the EPIC 037 entries before the EPIC 038 entries - fix:preserve both epic records in the daily journal - why:the review requires append-only history across epic boundaries.

**EPIC verification gate.** Stories 1–4 are complete. The review blockers are fixed.

- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0 — `ℹ tests 5368`, `ℹ pass 5368`, `ℹ fail 0`
- Gates (`npm run verify`) → exit 0

**Proof.** The EPIC Proof command → exit 0 and printed `PASS EPIC-038`.

**Tasks closed.** 4 across 4 Stories — no Story remains outstanding or unexpanded.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/openapi.test.ts src/http/contract/example.test.ts src/http/contract/registry.test.ts src/http/contract/coverage.test.ts src/http/contract/parity.test.ts src/http/contract/path.test.ts src/http/contract/event-payload.test.ts scripts/publish-contract.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts && echo "PASS EPIC-038") — "PASS EPIC-038"
- stories: 4/4 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
