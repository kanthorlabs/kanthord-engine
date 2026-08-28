---
epic: .agents/plan/epics/039-the-modular-source-ref-tree.md
opened: 2026-08-28
opener: test-engineer
base-ref: 44e6f739be6721f49afb593a2376e2614bdf2da3
---

# Implementation cycle — 039-the-modular-source-ref-tree

Pulled from EPIC: `.agents/plan/epics/039-the-modular-source-ref-tree.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/contract/openapi-source.test.ts \
>   src/http/contract/openapi.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/contract/parity.test.ts \
>   src/http/contract/coverage.test.ts \
>   src/http/contract/example.test.ts \
>   scripts/publish-contract.test.ts \
>   scripts/publish-contract.source.test.ts \
>   scripts/release-gate.test.ts \
>   scripts/release-facts.test.ts \
>   && echo "PASS EPIC-039"
> ```
>
> `npm run contract:publish -- "$(mktemp -d)"` exits `0` and writes both forms. It is not in the Proof
> command because it writes outside the repository.
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
> - **`openapi.yaml` is byte-identical to its output before this epic.** The test compares the published
>   `openapi.yaml` against `renderOpenApiYaml()` with `Buffer.compare`, and each `features/*.yaml` slice
>   against `renderOpenApiYaml(feature.operations)` the same way. A held literal is refused: the master
>   is a 142-schema document, and `docs/proposal/api/README.md` forbids a committed generated document,
>   so an inline copy would be that same artifact under another name. What closes the remaining gap is
>   the change set: **no story of this epic edits `src/http/contract/openapi.ts`, any module it reads,
>   or `src/domain/version.ts`**, and each story asserts that with
>   `git diff --quiet HEAD -- src/domain $(git ls-files 'src/http/contract/*.ts' | grep -v '\.test\.ts$')`
>   over its own change set. The renderer cannot move, so its output cannot move.
> - **`SwaggerParser.validate` passes on `source/openapi.yaml`** with every external reference
>   resolved from disk.
> - **`SwaggerParser.bundle` on `source/openapi.yaml` agrees with the canonical master** under the
>   normalisation the Decisions state. The bundle reports `$refs.circular === false` and holds no
>   external reference.
> - **No `$ref` in any emitted file resolves outside the publication directory.** The test resolves
>   every reference and names the offending file in the failure message. The 37 references under the
>   root key `x-kanthord-event-payloads` of `source/openapi.yaml` are inside that set.
> - **`source/openapi.yaml` carries `x-kanthord-event-payloads` with 37 external references.** Each
>   value is `./components/<prefix>.yaml#/schemas/<type>`, and the dereference-equivalence assertion
>   above compares the resolved catalogue against the catalogue of the canonical master.
> - **The component file count is 15.** The 37 event payload schemas add no file, because each event
>   type prefix already names a component file.
> - **Two emissions produce identical bytes for every file under `source/`.** The two output
>   directories differ in name, so the emission depends on no absolute path.
> - **`manifest.json` names the modular form**, and the manifest agreement test asserts the value
>   `"source/openapi.yaml"` and the key order `version`, `commit`, `tag`, `source`, `features`,
>   `operations`.
> - **A component file name collision is refused.** Two schema prefixes that differ only by letter
>   case produce a named failure rather than a lost file.
> - **Every test uses its own `mkdtemp` directory and removes it.** No shared temporary directory, no
>   network, no wall clock, no ambient git configuration.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — the-proposal-states-two-forms-and-the-component-files · 039/story-1

**Cycle.** RED for Task `039/story-1` (`src/http/contract/openapi-source.test.ts`).
**Test written.**

- file: `src/http/contract/openapi-source.test.ts` (new) — suite: `src/http/contract/openapi-source` — methods: `emits fifteen component files`, `names each component file after the schema-name prefix`, `places an event payload schema by its event-type prefix`, `holds the exact bytes of the security component file`, `leaves no internal component pointer in a component file`, `refuses two component file names that differ only by letter case`
- asserts: The source tree groups schemas by prefix, preserves event payload placement, emits exact security bytes, rewrites component references, and refuses case-folded filename collisions.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/contract/openapi-source.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/contract/openapi-source.test.ts`
- stub probe: `src/http/contract/openapi-source.ts` — clean
  **Open to Software Engineer.**
- `src/http/contract/openapi-source.ts` — exported `buildOpenApiSourceTree(entries?: readonly Operation[]): ReadonlyMap<string, string>`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-proposal-states-two-forms-and-the-component-files · 039/story-1

**Cycle.** GREEN+REFACTOR for `src/http/contract/openapi-source.test.ts`.
**Files changed.**

- `src/http/contract/openapi-source.ts` (new) — `buildOpenApiSourceTree`, private prefix, rewrite, collision, and bytewise helpers.
- `docs/proposal/api/new-decisions.md` (edited) — documents the additional modular publication form.
- `docs/proposal/api/README.md` (edited) — documents the two-form publication layout and source references.
  **Seam (GREEN).** The builder groups the generated schemas into bytewise-ordered component files and rewrites component references without mutating the master document.
  **Refactor.** Applied the story's shared private helpers and single-document build; no separate refactor was named.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `YAML.stringify(value, { lineWidth: 0 })` supplies the required trailing newline, as specified by Story 1.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-proposal-states-two-forms-and-the-component-files · confirm GREEN

**Cycle.** Confirm GREEN for Task `039/story-1` (`src/http/contract/openapi-source.test.ts`).
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **GREEN proof.**
- command: `npm test`
- exit: non-zero — failures:
  - `✖ places an event payload schema by its event-type prefix (275.670541ms)`
  - `✖ yaml is imported only in openapi.ts and document/yaml.ts (14.218084ms)`
- result: 5372 passed, 2 failed.
  **Open to Software Engineer.**
- `src/http/contract/openapi-source.ts` — exported `buildOpenApiSourceTree(entries?: readonly Operation[]): ReadonlyMap<string, string>`; the component tree must satisfy the named event-payload placement assertion.

ATTEMPT-FAILED: 039/story-1 — confirm-GREEN found two failing tests after the software-engineer's handoff

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-proposal-states-two-forms-and-the-component-files · 039/story-1

**Cycle.** Blocked GREEN for `src/http/contract/openapi-source.test.ts`.
**Files changed.**

- none — the active test contract conflicts with the Story constraints.
  **OPEN:**
- `src/http/contract/openapi-source.test.ts:65` requires `node.state.changed`, but `buildOpenApiDocument()` and `eventPayloads` expose no such schema. Adding it would change the canonical contract, which Story 1 forbids.
- `src/services/document/yaml.test.ts:145-158` permits `yaml` imports only in `openapi.ts` and `document/yaml.ts`, while Story 1 requires `openapi-source.ts` to import `yaml`. The test is outside this lane.
  **Build check.**
- typecheck: exit 0

ATTEMPT-FAILED: 039/story-1 — the event schema and YAML import requirements cannot both be satisfied within the permitted production file.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-proposal-states-two-forms-and-the-component-files · human blocker

**Cycle.** Blocked on Task `039/story-1` after the software-engineer handoff.
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/services/document/yaml.test.ts` (edited) — suite: `src/services/document/yaml.test` — method: `yaml is imported only in the allow-listed modules`
- asserts: The required `openapi-source.ts` YAML import is included in the allowlist.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ places an event payload schema by its event-type prefix (268.646875ms)`; `false !== true`
  **Open to Human.**
- B1 - status:OPEN - action:YES - undeclared event payload assertion - Story 039 requires `node.state.changed`, but EPIC 037 Story 5 states that it is not a declared event type and the current 37-key contract omits it - fix:Amend the locked assertion to a declared event type, preferably `node.created`, or amend the contract consistently - why:The test cannot pass without contradicting the binding contract or changing the canonical schema set.

ATTEMPT-FAILED: 039/story-1 — the binding Story 039 assertion conflicts with the declared event-type contract

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-proposal-states-two-forms-and-the-component-files · 039/story-1

**Cycle.** GREEN+REFACTOR for `src/http/contract/openapi-source.test.ts`.
**Files changed.**

- none — the existing builder satisfies the amended `node.created` assertion and Story 1 seam.
  **Seam (GREEN).** `buildOpenApiSourceTree` groups the declared schemas, including `node.created`, under `components/node.yaml`.
  **Refactor.** No further refactor was required; the existing private helpers match the Story 1 design.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the on-disk Story 1 and test use the declared `node.created` event schema.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-feature-operation-fragments · 039/story-2

**Cycle.** Confirm GREEN for Task `039/story-1`, then RED for Task `039/story-2` (`src/http/contract/openapi-source.test.ts`).
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/http/contract/openapi-source.test.ts` (edited) — suite: `src/http/contract/openapi-source` — methods: `emits nineteen feature fragments`, `keys a fragment by operationId in bytewise order`, `holds the exact reference line of actor.list`, `leaves no internal component pointer in a feature fragment`
- asserts: Feature fragments cover all features, preserve operation order, rewrite actor references, and contain no internal component pointers.
  **GREEN proof for prior Task.**
- Story 1's six tests pass in the full suite.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failures:
  - `✖ emits nineteen feature fragments (88.448666ms)`; `0 !== 19`
  - `✖ keys a fragment by operationId in bytewise order (171.318875ms)`; `AssertionError [ERR_ASSERTION]: no fragment for feature actor`
  - `✖ holds the exact reference line of actor.list (86.413ms)`; `AssertionError [ERR_ASSERTION]: no actor feature fragment`
  - `✖ leaves no internal component pointer in a feature fragment (97.793ms)`; `undefined !== true`
    **Open to Software Engineer.**
- `src/http/contract/openapi-source.ts` — exported `buildOpenApiSourceTree(entries?: readonly Operation[]): ReadonlyMap<string, string>`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-feature-operation-fragments · 039/story-2

**Cycle.** GREEN+REFACTOR for `src/http/contract/openapi-source.test.ts`.
**Files changed.**

- `src/http/contract/openapi-source.ts` (edited) — `buildOpenApiSourceTree` indexes document operations and emits feature fragments.
  **Seam (GREEN).** `openApiFeatures(entries)` supplies bytewise feature and operation order; cloned operations rewrite schema references with `"../"`, and missing IDs throw.
  **Refactor.** Applied the story's shared operation index and feature-fragment construction; no separate refactor was named.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-modular-root-and-the-publish · 039/story-3

**Cycle.** Confirm GREEN for Task `039/story-2`, then RED for Task `039/story-3` (`src/http/contract/openapi-source.test.ts`, `scripts/publish-contract.test.ts`).
**Test written.**

- file: `src/http/contract/openapi-source.test.ts` (edited) — suite: `src/http/contract/openapi-source` — methods: `emits one root, nineteen fragments and fifteen component files`, `keeps the root key order of the master document`, `references a fragment from every path method`, `references a component from every schema and from the security scheme`, `carries the event payload catalogue as thirty-seven external references`, `refuses an unknown root key`
- file: `scripts/publish-contract.test.ts` (edited) — suite: `scripts/publish-contract` — methods: `writes the master document, feature documents and examples`, `clears a stale file from a previous publication`
- asserts: The modular root references every operation and component, carries all 37 event payload references, and publication writes and clears the complete source tree.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failures: `✖ writes the master document, feature documents and examples (492.197ms)`; `✖ clears a stale file from a previous publication (1.503375ms)`; `✖ emits one root, nineteen fragments and fifteen component files (179.335917ms)`; `✖ keeps the root key order of the master document (107.519333ms)`; `✖ references a fragment from every path method (109.994792ms)`; `✖ references a component from every schema and from the security scheme (91.650542ms)`; `✖ carries the event payload catalogue as thirty-seven external references (178.127041ms)`
- typecheck: `npm run typecheck` — exit 0
  **Open to Software Engineer.**
- `src/http/contract/openapi-source.ts` — exported `buildOpenApiSourceTree(entries?: readonly Operation[]): ReadonlyMap<string, string>`.
- `scripts/publish-contract.ts` — exported `publishContract(input: PublishInput): readonly string[]`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-modular-root-and-the-publish · 039/story-3

**Cycle.** GREEN+REFACTOR for `src/http/contract/openapi-source.test.ts` and `scripts/publish-contract.test.ts`.
**Files changed.**

- `src/http/contract/openapi-source.ts` (edited) — modular root construction for paths, components and the event catalogue.
- `scripts/publish-contract.ts` (edited) — source tree cleanup, creation and publication.
  **Seam (GREEN).** The builder emits `source/openapi.yaml` with external references, and publication writes every source entry under `source/`.
  **Refactor.** Applied the story's root-key dispatch and kept publication limited to writing builder output.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `npm run typecheck` completed with exit 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-bundle-equivalence-test · 039/story-4

**Cycle.** Completed test-only Task `039/story-4`; Story 4 declares no production RED phase.
**Test written.**

- file: `scripts/publish-contract.source.test.ts` (new) — suite: `scripts/publish-contract.source` — methods: `bundles the modular root with no external reference left`, `reports no circular reference in the modular root`, `dereferences to the same document as the canonical master`, `validates the modular root from disk`
- file: `src/domain/layout.test.ts` (edited) — suite: `src/domain/layout.test` — updated the default-runner allow-list for the new script test
- asserts: The modular tree bundles without external references, opens every source file, matches the canonical master after the stated normalisation, preserves all 37 catalogue entries, and validates from disk.
  **Proof.**
- handoff: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- targeted: `node --test scripts/publish-contract.source.test.ts` — exit 0 — `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`
- typecheck: `npm run typecheck` — exit 0
- full suite: `npm test` — exit 0 — `ℹ tests 5388`, `ℹ pass 5388`, `ℹ fail 0`
- initial full-suite failure exposed the missing `publish-contract.source.test.ts` entry in the existing runner-fence assertion; the test-owned allow-list update fixed it.
  **No handoff.** Story 4 changes tests only; no software-engineer seam exists.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-containment-and-reproducibility-tests · 039/story-5

**Cycle.** Blocked: Story 5 is test-only and has no production GREEN seam.
**Files changed.**

- none — the next Task permits edits only to `scripts/publish-contract.source.test.ts`, which is the test-engineer lane.
  **OPEN:**
- `scripts/publish-contract.source.test.ts` — the test-engineer must add `classifyRef` and the containment, reproducibility, and self-contained-form tests; the software-engineer must not edit this test-only file.
  **Build check.**
- typecheck: exit 0

ATTEMPT-FAILED: 039/story-5 — the active story permits no production edit and provides no software-engineer seam

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-containment-and-reproducibility-tests · 039/story-5

**Cycle.** RED then completed test-only Task `039/story-5` (`scripts/publish-contract.source.test.ts`).
**Test written.**

- file: `scripts/publish-contract.source.test.ts` (edited) — suite: `scripts/publish-contract.source` — methods: `classifies a reference against the publication boundary`, `resolves every emitted reference inside the publication directory`, `emits identical bytes for every source file across two publications`, `keeps the self-contained forms self-contained`
- asserts: Every reference stays inside the publication directory, source bytes reproduce, and self-contained forms retain canonical bytes and internal references.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `ReferenceError: classifyRef is not defined`
  **GREEN proof.**
- handoff: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- targeted: `node --test scripts/publish-contract.source.test.ts` — exit 0 — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`
- typecheck: `npm run typecheck` — exit 0
- full suite: `npm test` — exit 0 — `ℹ tests 5392`, `ℹ pass 5392`, `ℹ fail 0`
  **No handoff.** Story 5 changes one test file and has no software-engineer seam.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-containment-and-reproducibility-tests · 039/story-5

**Cycle.** No implementation for the latest TEST-ENGINEER turn; Story 5 is test-only and has no production seam.
**Files changed.**

- None — the latest TEST-ENGINEER turn names no production file or failing assertion for this lane.
  **Seam (GREEN).** No production seam exists; the latest TEST-ENGINEER turn reports all Story 5 tests green.
  **Refactor.** None — Story 5 permits changes only to `scripts/publish-contract.source.test.ts`.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The test-engineer must dispatch Story 6 before software-engineer implementation; the latest turn explicitly states no handoff.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-manifest-names-the-modular-form · 039/story-6

**Cycle.** RED for Task `039/story-6` (`scripts/publish-contract.test.ts`).
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `scripts/publish-contract.test.ts` (edited) — suite: `scripts/publish-contract` — methods: `the manifest carries publication metadata and the operation list`, `the manifest source and lists match returned files`
- asserts: The manifest names `source/openapi.yaml` in the required key order, resolves that file, and agrees with returned feature, example, and source entries.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failures:
  - `✖ the manifest carries publication metadata and the operation list (0.869292ms)`; `actual: [ 'version', 'commit', 'tag', 'features', 'operations' ]`
  - `✖ the manifest source and lists match returned files (496.4965ms)`; `TypeError: Cannot read properties of undefined (reading 'slice')`
    **Open to Software Engineer.**
- `scripts/publish-contract.ts` — exported `publishContract(input: PublishInput): readonly string[]`; the published manifest exposes the modular-root path and preserves the specified metadata key order.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-manifest-names-the-modular-form · 039/story-6

**Cycle.** GREEN+REFACTOR for `scripts/publish-contract.test.ts`.
**Files changed.**

- `scripts/publish-contract.ts` (edited) — manifest `source` field.
- `docs/proposal/api/README.md` (edited) — documents the manifest field and modular-root path.
  **Seam (GREEN).** The manifest emits `source/openapi.yaml` after `tag`, matching the published modular root and required key order.
  **Refactor.** No separate refactor was named.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 3 already publishes `source/openapi.yaml`, so the manifest value resolves to an emitted file.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** All six Stories and all 039 Tasks are complete.

- Story verification: source tree `16/16`, publication and release suites `51/51`, source publication suite `8/8`.
- Gates: `npm run verify` — exit 0; full suite `5393/5393`, lint and database status pass.
- Handoff verification: `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**Per-gate lines.**

- `typecheck` (`npm run typecheck`) → exit 0.
- `unit` (`npm test`) → exit 0 — `ℹ tests 5393`, `ℹ pass 5393`, `ℹ fail 0`.

**Proof.**

- command: `node --test src/http/contract/openapi-source.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts scripts/publish-contract.test.ts scripts/publish-contract.source.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts && echo "PASS EPIC-039"` → exit 0 — `"PASS EPIC-039"`.

**Tasks closed.** 6 across 6 Stories — no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/openapi-source.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts scripts/publish-contract.test.ts scripts/publish-contract.source.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts && echo "PASS EPIC-039") — "PASS EPIC-039"
- stories: 6/6 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: reserved security filename collision — src/http/contract/openapi-source.ts:38-63 permits a schema prefix named security to overwrite components/security.yaml; reject every schema prefix whose case-folded name equals the reserved security filename.
BLOCKER: contradictory external-reference documentation — docs/proposal/api/README.md:15 says external $ref files are refused while the later section documents the modular external-reference tree; scope the refusal to the canonical master and self-contained slices.

## TEST-ENGINEER — review blocker regression · reserved security filename

**Cycle.** Review-blocker regression for the reserved security component filename.
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Test written.**
- file: `src/http/contract/openapi-source.test.ts` (edited) — suite: `src/http/contract/openapi-source` — method: `refuses a schema prefix reserved for the security component file`
- asserts: The builder rejects every schema prefix whose case-folded name matches the reserved security component filename with a named collision error.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ refuses a schema prefix reserved for the security component file (1.970791ms)`
- assertion: `AssertionError [ERR_ASSERTION]: Missing expected exception: security.list`
  **Open to Software Engineer.**
- B1 - status:OPEN - action:YES - reserved security filename collision - `src/http/contract/openapi-source.ts` exports `buildOpenApiSourceTree(entries?: readonly Operation[]): ReadonlyMap<string, string>` - fix:reject a schema prefix whose case-folded name matches the reserved security component filename with a named collision error - why:the schema file must not overwrite the security component file.
  **Open to Human.**
- B2 - status:OPEN - action:YES - contradictory external-reference documentation - `docs/proposal/api/README.md` says external references are refused before it documents the modular external-reference tree - fix:scope the refusal to the canonical master and self-contained slices - why:the proposal must not contradict the modular publication form.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-modular-source-ref-tree · reserved security filename

**Review blocker addressed.** `BLOCKER: reserved security filename collision — src/http/contract/openapi-source.ts:38-63 permits a schema prefix named security to overwrite components/security.yaml; reject every schema prefix whose case-folded name equals the reserved security filename.`

**Cycle.** Review-blocker fix for `src/http/contract/openapi-source.ts`.
**Files changed.**

- `src/http/contract/openapi-source.ts` (edited) — reserved security-prefix collision check.
  **Seam (GREEN).** The builder rejects every schema prefix that case-folds to the reserved `security` component filename.
  **Refactor.** None — the blocker needs one validation before file emission.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `npm run typecheck` completed with exit 0.

**Remaining review blocker.**

- B2 - status:OPEN - action:NO - contradictory external-reference documentation - `docs/proposal/api/README.md` remains human-owned for this turn - fix:scope the refusal to the canonical master and self-contained slices - why:the proposal must not contradict the modular publication form.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker regression · reserved security filename

**Cycle.** Confirm GREEN for the reserved security filename regression.
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **GREEN proof.**
- command: `npm test`
- exit: 0 — `ℹ tests 5394`, `ℹ pass 5394`, `ℹ fail 0`
  **Open to Human.**
- B2 - status:OPEN - action:YES - contradictory external-reference documentation - `docs/proposal/api/README.md:15` refuses external references before the modular form is documented - fix:scope the refusal to the canonical master and self-contained slices - why:the proposal must not contradict the modular publication form.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-modular-source-ref-tree · contradictory external-reference documentation

**Review blocker addressed.** `BLOCKER: contradictory external-reference documentation — docs/proposal/api/README.md:15 says external $ref files are refused while the later section documents the modular external-reference tree; scope the refusal to the canonical master and self-contained slices.`

**Cycle.** Review-blocker fix for `docs/proposal/api/README.md`.
**Files changed.**

- `docs/proposal/api/README.md` (edited) — scopes the external-reference refusal to self-contained forms.
  **Seam (GREEN).** The proposal now permits external references under `source/` while retaining internal references for canonical forms.
  **Refactor.** None — the blocker required one documentation correction.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 6 assigns `docs/proposal/api/README.md` to the software-engineer lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** All six Stories and all 039 Tasks are complete.
**Handoff verification.** `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**Per-gate lines.**

- `typecheck` (`npm run typecheck`) → exit 0.
- `unit` (`npm test`) → exit 0 — `ℹ tests 5394`, `ℹ pass 5394`, `ℹ fail 0`.
- `npm run verify` → exit 0 — format, typecheck, unit, lint, and database status passed.

**Proof.**

- command: `node --test src/http/contract/openapi-source.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts scripts/publish-contract.test.ts scripts/publish-contract.source.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts && echo "PASS EPIC-039"` → exit 0 — `"PASS EPIC-039"`.

**Tasks closed.** 6 across 6 Stories — no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/openapi-source.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts scripts/publish-contract.test.ts scripts/publish-contract.source.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts && echo "PASS EPIC-039") — "PASS EPIC-039"
- stories: 6/6 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
