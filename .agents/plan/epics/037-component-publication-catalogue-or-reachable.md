# EPIC 037 — Component publication: catalogue or reachable

Status: **draft**. It is the eighth epic of the phase 1b band, after EPIC 036 and before EPIC 038. It
amends `docs/proposal/api/README.md:13-21`. EPIC 038 and EPIC 039 both depend on it, so it lands
before either one opens.

## Goal

State what `components.schemas` means in a published document, and encode the answer in the builder.

Today the answer is an accident. `buildOpenApiDocument` seeds `Error` and all 37 event payload
schemas into every document it builds, and the path objects reach 105 of the 142 emitted schemas. The
37 unreached schemas are exactly the event payload catalogue. No document states that this is
deliberate, so EPIC 039 cannot decide what a shared component file holds.

This epic gives every document one rule: a document holds the transitive closure of its own
references. It makes the event payload catalogue reachable by construction, through a root-level
OpenAPI extension that names every event type and references its component.

| Artifact                | Extension | Contents                                                  |
| ----------------------- | --------- | --------------------------------------------------------- |
| `openapi.yaml`          | yes       | the closure of `paths` and the catalogue, so all 142      |
| `features/event.yaml`   | yes       | the closure of `event` paths, plus the 37 payload schemas |
| every other `features/` | no        | the closure of that slice's paths, and nothing else       |

## Non-goals

- **No external `$ref`.** Every emitted document stays self-contained. EPIC 039 owns the modular
  source tree.
- **No new validation of a slice.** EPIC 038 owns the validation of every emitted document. This epic
  adds only the tests its own Verification Gate names.
- **No change to an operation, a path, or an emitted schema.** The registry is untouched, and no zod
  schema that reaches a document changes. The deleted `eventPayload` union reaches no document.
- **No change to `eventView.payload`.** It stays `z.unknown()`. The wire shape and the `event.list`
  response schema do not change.
- **No move to OpenAPI 3.1.** The version stays `3.0.3`.

## Decisions

- **The catalogue is normative, so no document deletes it.** `docs/proposal/database/event.md:13`
  describes an event payload as the fields of that event type, small and fixed in shape. A consumer
  generates its event handlers from these 37 named schemas. The seeding at `openapi.ts:53` and
  `openapi.ts:57` is correct, and this epic promotes it from an accident to a stated rule.

- **`eventPayload` is deleted.** `src/http/contract/event-payload.ts:267` exports a `z.union` over all
  37 payload schemas. No production module and no test imports it. It never correlated a type to its
  payload: it accepted any of the 37 shapes. Delete the export. Keep `eventPayloads` at
  `event-payload.ts:71`, which is the catalogue the builder reads.

- **`eventView.payload` stays `z.unknown()`, and the published response guarantees no payload shape.**
  A consumer that reads `event.list` receives an unconstrained payload. The catalogue is advisory to
  that consumer until the enforcement work lands. The proposal document says this in those words. It
  does not claim that the document and the code agree.

- **A root-level extension carries the catalogue, and every entry is a real internal `$ref`.** The
  document holds one key `x-kanthord-event-payloads`, after `components`. Each entry maps an event
  type to the component of that type.

  ```yaml
  x-kanthord-event-payloads:
    node.created:
      $ref: "#/components/schemas/node.created"
  ```

  The key set equals `eventTypes`. The keys sort bytewise, as `components.schemas` does.

- **The document that holds `event.list` holds the extension.** `buildOpenApiDocument` emits the
  extension when its entry set holds the operation id `event.list`. That operation is the only route
  that delivers an event payload. The master holds it, `features/event.yaml` holds it, and no other
  slice holds it. The publication script names no feature, so the by-name exception is gone.

- **One traversal serves every document, so there is no build mode.** The extension makes the 37
  schemas reachable in the master and in `features/event.yaml`, and they stay unreachable everywhere
  else. A `catalog` mode and a `reachable` mode therefore produce the same bytes for every artifact
  this product emits. `buildOpenApiDocument` and `renderOpenApiYaml` keep their single parameter.

- **Reachability is transitive, and it is precise.** The collector seeds from every root key of the
  document except `components`, so it reads `paths` and `x-kanthord-event-payloads` by the same rule.
  It reads every `$ref` value that starts with `#/components/schemas/`, and it follows each named
  schema into its own body. It follows a nested `$ref`, and it follows every value of a
  `discriminator.mapping` object. It decodes the JSON Pointer escapes `~1` to `/` and `~0` to `~`, and
  it decodes `~1` first. A cycle terminates, because a name already collected is never traversed
  twice.

- **The master's `paths` and `components.schemas` do not change, and its bytes do.** The extension is
  a new root key, so the byte-identical gate is void. A stored pre-epic output does not replace it: a
  captured document is a generated document, and `AGENTS.md` never commits one. The replacement is the
  existing contract suite, which must pass unmodified, plus two new assertions: the root key list is
  exactly the five pre-epic keys followed by `x-kanthord-event-payloads`, and the pruning filter is the
  identity on the master. Pruning removes nothing from the master, because the 37 unreached schemas are
  exactly the catalogue and the extension reaches all 37. The Verification Gate states what the suite
  pins.

- **A slice drops `Error` when its paths do not reach it.** Eight slices declare an error envelope on
  every operation, so `#/components/schemas/Error` is unreferenced there and the closure rule removes
  it. The eight are `actor`, `blob`, `edge`, `event`, `plan`, `project`, `provider` and `system`. The
  other eleven slices keep `Error`. That is the rule working, not a regression.

- **The gate asserts reachability, not mention.** A test that greps a document for a schema name
  passes on a name that appears in prose. The Verification Gate asserts that a document holds the
  transitive closure of its own references, computed by the same traversal rule and asserted for a
  nested `$ref` and for a `discriminator` mapping.

- **OpenAPI stays 3.0.3 by decision.** `z.toJSONSchema(..., { target: "openapi-3.0" })` is the mapping
  every contract test pins today. A move to 3.1 costs a fresh parity pass over `nullable`,
  `exclusiveMinimum` and `examples`, because 3.1 changes all three. The version, the artifact topology
  and the self-contained rule are three independent decisions. Settling this epic settles the second
  and the third alone.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **Delete the unused payload union.** In `src/http/contract/event-payload.ts`, delete the
   `export const eventPayload = z.union(...)` block at `:267` to the end of the file. Delete the
   `eventTypes` import and the `ZodType` import only if the deletion orphans them. No test covers
   `eventPayload`, so no test is deleted. Run `npm run typecheck` and `eslint .` to prove no consumer
   remains.

2. **The builder emits the catalogue extension.** In `src/http/contract/openapi.ts`, add
   `export const eventPayloadCatalogueKey = "x-kanthord-event-payloads";`. In
   `buildOpenApiDocument`, after the `components` key, add that key when
   `entries.some((entry) => entry.operationId === "event.list")` is true. The value is an object whose
   keys are `Object.keys(eventPayloads)` sorted bytewise, and whose each value is
   `{ $ref: "#/components/schemas/<type>" }`. The document omits the key when the condition is false.
   In `src/http/contract/openapi.test.ts`, assert that the extension key set deep-equals the bytewise
   sort of `Object.keys(eventPayloads)`, that every entry references a key of
   `components.schemas` in the same document, and that `buildOpenApiDocument` for the `node`
   operations holds no `x-kanthord-event-payloads` key.

3. **Transitive reachability collection, applied to every document.** Add
   `src/http/contract/schema-reachability.ts` with
   `export function reachableSchemaNames(document: Readonly<Record<string, unknown>>): ReadonlySet<string>`.
   It seeds from every root key except `components`, reads a `$ref` whose value starts with
   `#/components/schemas/`, decodes the pointer escapes, and follows each named schema body, a nested
   `$ref` and every `discriminator.mapping` value. In `buildOpenApiDocument`, build the full schema
   map and the extension first, then drop each schema key the set does not hold, and keep the bytewise
   key order. `src/http/contract/schema-reachability.test.ts` covers a nested `$ref` chain of depth
   three, a `discriminator.mapping` with two entries, a name that contains an escaped `/`, a name that
   contains an escaped `~`, a two-schema cycle, and a `$ref` that sits under a root extension key.

4. **The publication proves the slice contents.** `scripts/publish-contract.ts` needs no code change,
   because the builder decides both the extension and the pruning. Extend
   `scripts/publish-contract.test.ts` with the assertions the Verification Gate names: the closure of
   every emitted document, the catalogue in `openapi.yaml` and `features/event.yaml`, no payload key
   in `features/node.yaml`, and byte reproducibility across two runs.

5. **The proposal states the rule.** Rewrite `docs/proposal/api/README.md:13-21`. Keep the
   self-contained rule and the no-external-`$ref` refusal unchanged. Add the closure rule, the
   `x-kanthord-event-payloads` extension and its shape, the statement that the extension makes the
   catalogue reachable in the master and in the `event` slice only, the statement that `event.list`
   returns an unconstrained payload and that the catalogue is advisory to a consumer, and the
   statement that 3.0.3 is a decision. No code.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/schema-reachability.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/event-payload.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/path.test.ts \
  scripts/publish-contract.test.ts \
  && echo "PASS EPIC-037"
```

`npm run contract:publish -- "$(mktemp -d)"` exits 0. It is not in the Proof command because it writes
outside the repository.

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **The master changes by exactly one root key, and no committed fixture proves it.** A stored
  pre-epic `buildOpenApiDocument()` output is refused: it is a generated document, and `AGENTS.md`
  never commits one. The existing contract suite is the baseline instead, and it must pass unmodified.
  It pins `openapi` and `info`, the `security` root, `components.securitySchemes.bearerAuth`, the path
  count and bytewise path order, the method order inside every path, every `operationId`, every
  parameter, every response and success status, and the exact ordered list of all 142
  `components.schemas` keys. `parity.test.ts` pins the path set itself against the committed table in
  `docs/proposal/api/`, which is authored and not generated. On top of that baseline the epic asserts
  two new things: the root key list is exactly the five pre-epic keys followed by
  `x-kanthord-event-payloads`, and the pruning filter is the identity on the master, because
  `reachableSchemaNames` over the master equals the full 142-key set. Together those two make the
  added key the only difference. A test that asserts `components.securitySchemes` holds the single
  key `bearerAuth` closes the last gap in the baseline.
- **The catalogue key set equals `eventTypes`.** `Object.keys(document["x-kanthord-event-payloads"])`
  deep-equals the bytewise sort of `Object.keys(eventPayloads)`, asserted by value. The count is 37.
- **Every catalogue entry resolves.** Each entry holds exactly one key `$ref`, and the referenced name
  is a key of `components.schemas` in the same document.
- **The master holds all 37 event payload schemas after pruning.** Every key of `eventPayloads` is a
  key of the master's `components.schemas`.
- **`features/event.yaml` holds the catalogue, and no other slice does.** The extension key exists in
  `openapi.yaml` and in `features/event.yaml`. It exists in no other emitted document.
  `features/node.yaml` holds no key of `eventPayloads`.
- **Every emitted document holds the transitive closure of its own references.** For every document,
  `reachableSchemaNames` over that document equals the key set of its `components.schemas`. The
  closure is asserted for a fixture with a nested `$ref` and for a fixture with a `discriminator`
  mapping.
- **Every emitted document is byte-reproducible.** Two `publishContract` runs into two separate
  temporary directories produce equal bytes for every written file, compared with `Buffer.compare`.
- **No emitted document holds a `$ref` whose value does not begin with `#/`.** The assertion runs over
  the master, over every feature slice, and over the whole document, not over `paths` alone.
- **A pointer escape round-trips.** A schema name that contains `/` and a schema name that contains
  `~` are each reached through their encoded `$ref`, asserted by exact set membership.
- **`eventPayload` is gone.** `src/http/contract/event-payload.ts` exports no `eventPayload`, and a
  repository search finds no importer.
- **The master validates.** `SwaggerParser` accepts the master with the root extension present.
- **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
  Each test that writes uses its own `mktemp` directory and removes it.

## Open items

- S1 - status:FIXED - action:YES - AGENTS.md OpenAPI rule - `AGENTS.md:105` states that the master and
  each `features/*.yaml` slice are self-contained with internal references only, and it states nothing
  about what a slice holds. - fix:Append three sentences to that bullet: "Every emitted document holds
  the transitive closure of its own references, and nothing else. The root extension
  `x-kanthord-event-payloads` maps each event type to its component, so the event payload catalogue is
  reachable by construction. The master and `features/event.yaml` carry that extension, because both
  hold the operation `event.list`." - why:`AGENTS.md` is locked by `scripts/lane-check.sh:43`, so no
  story edits it, and a reviewer needs the rule in the structure contract. Ulrich applied the three
  sentences directly; they are at `AGENTS.md:107`.
- S2 - status:FIXED - action:YES - the event payload union has no consumer - Ulrich settled this after
  an adversarial debate. The decision is staged: this epic deletes `eventPayload`, keeps
  `eventView.payload` as `z.unknown()`, and replaces the by-name slice exception with the
  `x-kanthord-event-payloads` extension. - fix:See the Decisions section, which records the settled
  answer. - why:The choice changed the reachable set for every slice, so this epic could not make it
  silently. The remainder is the deferred item below.
- **Deferred: append-time payload enforcement. It carries no epic number yet.** Four parts, in order.
  First, move `eventPayloads` from `src/http/contract/` into `src/domain/`. `AGENTS.md` permits a
  service to import `domain/` and a service interface only, so `services/event` cannot reach
  `http/contract/` from where the catalogue sits today. Second, run an audit of every existing `event`
  row against the catalogue, in report-only mode. The audit gates the rest, and enforcement lands only
  after the audit is clean, because append-time validation binds a future write alone. Third, narrow
  `AppendEventInput.type` from `string` to the `EventType` union, and validate the payload against
  `eventPayloads[type]` on append, before the database work and outside the transaction. Fourth,
  decide the payload compatibility and versioning policy. That policy is the open question, and it is
  undecided. Note one constraint on the second and third parts:
  `Readonly<Record<EventType, ZodType>>` erases the per-type inferred payload, so a correlated type or
  a factory is required for compile-time safety.
- **No `discriminator` exists in the tree today.** The emitted document contains no `discriminator`
  key, and no schema holds a nested `$ref`. The traversal of story 3 is therefore covered by fixtures
  rather than by the live document. EPIC 039 introduces the first real case.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
