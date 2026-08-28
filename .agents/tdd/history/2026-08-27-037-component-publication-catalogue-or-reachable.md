---
epic: .agents/plan/epics/037-component-publication-catalogue-or-reachable.md
opened: 2026-08-27
opener: test-engineer
base-ref: 2d528fbc3dbc967f8b4feee7c5477711be4f4f1c
---

# Implementation cycle — 037-component-publication-catalogue-or-reachable

Pulled from EPIC: `.agents/plan/epics/037-component-publication-catalogue-or-reachable.md`.

Verification gate (binding, from the EPIC's "## Verification Gate" section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/contract/schema-reachability.test.ts \
>   src/http/contract/openapi.test.ts \
>   src/http/contract/event-payload.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/contract/parity.test.ts \
>   src/http/contract/coverage.test.ts \
>   src/http/contract/example.test.ts \
>   src/http/contract/path.test.ts \
>   scripts/publish-contract.test.ts \
>   && echo "PASS EPIC-037"
> ```
>
> `npm run contract:publish -- "$(mktemp -d)"` exits 0. It is not in the Proof command because it writes
> outside the repository.
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
> - **The master changes by exactly one root key, and no committed fixture proves it.** A stored
>   pre-epic `buildOpenApiDocument()` output is refused: it is a generated document, and `AGENTS.md`
>   never commits one. The existing contract suite is the baseline instead, and it must pass unmodified.
>   It pins `openapi` and `info`, the `security` root, `components.securitySchemes.bearerAuth`, the path
>   count and bytewise path order, the method order inside every path, every `operationId`, every
>   parameter, every response and success status, and the exact ordered list of all 142
>   `components.schemas` keys. `parity.test.ts` pins the path set itself against the committed table in
>   `docs/proposal/api/`, which is authored and not generated. On top of that baseline the epic asserts
>   two new things: the root key list is exactly the five pre-epic keys followed by
>   `x-kanthord-event-payloads`, and the pruning filter is the identity on the master, because
>   `reachableSchemaNames` over the master equals the full 142-key set. Together those two make the
>   added key the only difference. A test that asserts `components.securitySchemes` holds the single
>   key `bearerAuth` closes the last gap in the baseline.
> - **The catalogue key set equals `eventTypes`.** `Object.keys(document["x-kanthord-event-payloads"])`
>   deep-equals the bytewise sort of `Object.keys(eventPayloads)`, asserted by value. The count is 37.
> - **Every catalogue entry resolves.** Each entry holds exactly one key `$ref`, and the referenced name
>   is a key of `components.schemas` in the same document.
> - **The master holds all 37 event payload schemas after pruning.** Every key of `eventPayloads` is a
>   key of the master's `components.schemas`.
> - **`features/event.yaml` holds the catalogue, and no other slice does.** The extension key exists in
>   `openapi.yaml` and in `features/event.yaml`. It exists in no other emitted document.
>   `features/node.yaml` holds no key of `eventPayloads`.
> - **Every emitted document holds the transitive closure of its own references.** For every document,
>   `reachableSchemaNames` over that document equals the key set of its `components.schemas`. The
>   closure is asserted for a fixture with a nested `$ref` and for a fixture with a `discriminator`
>   mapping.
> - **Every emitted document is byte-reproducible.** Two `publishContract` runs into two separate
>   temporary directories produce equal bytes for every written file, compared with `Buffer.compare`.
> - **No emitted document holds a `$ref` whose value does not begin with `#/`.** The assertion runs over
>   the master, over every feature slice, and over the whole document, not over `paths` alone.
> - **A pointer escape round-trips.** A schema name that contains `/` and a schema name that contains
>   `~` are each reached through their encoded `$ref`, asserted by exact set membership.
> - **`eventPayload` is gone.** `src/http/contract/event-payload.ts` exports no `eventPayload`, and a
>   repository search finds no importer.
> - **The master validates.** `SwaggerParser` accepts the master with the root extension present.
> - **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
>   Each test that writes uses its own `mktemp` directory and removes it.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — delete-the-unused-payload-union · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task `037/story-1`.
**Story file.** `.agents/plan/stories/037-component-publication-catalogue-or-reachable/01-delete-the-unused-payload-union.md`
**Tasks forwarded to Software Engineer.**

- `037/story-1`: `src/http/contract/event-payload.ts` — delete the unused `eventPayload` union and narrow the orphaned import, without changing `eventPayloads`.

**No RED phase.** The Story deletes production dead code and names no test; coverage is owned by its typecheck, lint, focused event-payload suite, and repository search.
**Open to Software Engineer.**

- Implement GREEN+REFACTOR per Story 1's Change and Constraints sections.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — delete-the-unused-payload-union · Delete the unused payload union

**Cycle.** GREEN-ONLY implementation for Tasks: `037/story-1`.
**Files changed.**

- `src/http/contract/event-payload.ts` (edited) — removed `eventPayload` and narrowed the orphaned import.
  **Seam (GREEN).** `eventPayloads` remains the unchanged catalogue while the unused union no longer exports.
  **Refactor.** Applied the Story's import narrowing with the union deletion.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-builder-emits-the-catalogue-extension · 037/story-2

**Cycle.** RED for Task `037/story-2` (`src/http/contract/openapi.test.ts`).
**Test written.**

- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi.test` — methods: `carries the event payload catalogue in bytewise key order`, `resolves every catalogue entry to a component of the same document`, `omits the event payload catalogue from a document without event.list`, `adds the catalogue as the only root key beyond the document core`
- asserts: The master exposes the sorted 37-type catalogue, every entry resolves internally, event-free slices omit it, and the extension is the only added root key.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `SyntaxError: The requested module './openapi.ts' does not provide an export named 'eventPayloadCatalogueKey'`
  **Open to Software Engineer.**
- `src/http/contract/openapi.ts`: export `eventPayloadCatalogueKey` as a string and provide `buildOpenApiDocument(entries?: readonly Operation[]): Readonly<Record<string, unknown>>` with the asserted catalogue-extension behavior.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-builder-emits-the-catalogue-extension · Emit the event payload catalogue

**Cycle.** GREEN+REFACTOR for `src/http/contract/openapi.test.ts`.
**Files changed.**

- `src/http/contract/openapi.ts` (edited) — exported the catalogue key, built the sorted catalogue, and emitted it after `components` for documents containing `event.list`.
  **Seam (GREEN).** The builder exposes internally resolving catalogue references only when the document includes `event.list`.
  **Refactor.** Applied the Story 2 catalogue helper and post-`components` insertion.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `eventPayloads` remains the source catalogue, per Story 2 and the existing import.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — transitive-reachability-applied-to-every-document · 037/story-3

**Cycle.** RED for Task `037/story-3` (`src/http/contract/schema-reachability.test.ts`).
**Test written.**

- file: `src/http/contract/schema-reachability.test.ts` (new) — suite: `src/http/contract/schema-reachability` — methods: `follows a nested schema reference chain of depth three`, `follows every discriminator mapping target`, `decodes a schema name that contains an escaped slash`, `decodes escaped tildes without corrupting pointer order`, `terminates when two schemas refer to each other`, `seeds from root extensions but not from components`
- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi` — methods: `the master holds exactly the transitive closure of its own references`, `a slice holds exactly the transitive closure of its own references`
- asserts: Reachability follows nested and discriminator references, decodes pointer escapes, terminates cycles, and prunes an event-free slice without changing the master.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/contract/schema-reachability.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/contract/openapi.test.ts`
- stub probe: `src/http/contract/schema-reachability.ts` — clean
  **Open to Software Engineer.**
- `src/http/contract/schema-reachability.ts`: export `reachableSchemaNames(document: Readonly<Record<string, unknown>>): ReadonlySet<string>`; return the exact transitive schema closure from document roots other than `components`, including internal references, pointer escapes, discriminator mappings, and cycles.
- `src/http/contract/openapi.ts`: `buildOpenApiDocument(entries?: readonly Operation[]): Readonly<Record<string, unknown>>` must return documents whose schema keys equal their reachable set, preserving all master schemas and excluding unreachable event payload schemas from node-only documents.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — transitive-reachability-applied-to-every-document · Compute and apply schema closure

**Cycle.** GREEN+REFACTOR for `src/http/contract/schema-reachability.test.ts`.
**Files changed.**

- `src/http/contract/schema-reachability.ts` (new) — exported `reachableSchemaNames` traversal.
- `src/http/contract/openapi.ts` (edited) — pruned each complete document to its reachable schemas.
  **Seam (GREEN).** The builder traverses the complete document, follows internal references and discriminator mappings, then filters schemas.
  **Refactor.** Applied the Story 3 complete-document traversal and preserved bytewise schema ordering.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 2 catalogue extension remains the root seed for event payload schemas.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the-publication-proves-the-slice-contents · Story 4

**Cycle.** Confirmed GREEN for Task `037/story-3`, then completed test-only Task `037/story-4`. No RED phase applies because Story 4 extends coverage for the already implemented publication behavior.
**Handoff verification gate.**

- The last Software Engineer turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0.
- Prior GREEN confirmation: `npm test` → exit 0 — `ℹ tests 5359`, `ℹ pass 5359`, `ℹ fail 0`.
  **Test written.**
- file: `scripts/publish-contract.test.ts` (edited) — suite: `scripts/publish-contract` — methods: `every emitted document holds the closure of its own refs`, `only the master and the event slice carry the catalogue`, `the node slice drops every event payload schema`, `no emitted document holds a $ref outside its own components`
- asserts: All 20 emitted documents equal their transitive schema closures; only the master and event slice carry the catalogue; node drops all payload schemas while event keeps all 37; every document reference is an internal schema reference.
- changed the existing reproducibility comparison to assert `Buffer.compare(a, b) === 0`.
  **Proof.**
- command: `node --test scripts/publish-contract.test.ts`
- exit 0 — `ℹ tests 21`, `ℹ pass 21`, `ℹ fail 0`, first run.
- formatting: `npx prettier --write scripts/publish-contract.test.ts` completed; `npx eslint scripts/publish-contract.test.ts` exited 0.
- typecheck: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
  **Sensitivity proof.**
- A hermetic probe published into its own temporary directory, removed it, and applied the five guards to mutated in-memory documents.
- Output: `sensitivity probes: 5/5 guards rejected mutated output` for missing catalogue, extra node payload, missing event payload, orphan schema and external reference.
  **No handoff.** Story 4 changes only the test lane. Story 5 follows as a GREEN-only documentation task.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the-proposal-states-the-rule · Record the publication rule

GREEN-ONLY implementation for Tasks: `037/story-5`.
**Files changed.**

- `docs/proposal/api/README.md` (edited) — documented schema closure, the event payload catalogue extension, payload advisory status, and the OpenAPI version decision.
  **Seam (GREEN).** The proposal now states the same closure and catalogue rules that the builder implements.
  **Refactor.** Applied Story 5's required proposal wording and YAML example.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Stories 1–5 are complete. Every Story verification command passed, including publication, proposal, and repository checks.

- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0
- Gates (`npm run verify`) → exit 0

**Proof.** The EPIC Proof command → exit 0 and printed `"PASS EPIC-037"`.

**Tasks closed.** 5 across 5 Stories — no Story remains outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/schema-reachability.test.ts src/http/contract/openapi.test.ts src/http/contract/event-payload.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/path.test.ts scripts/publish-contract.test.ts && echo "PASS EPIC-037") — "PASS EPIC-037"
- stories: 5/5 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
