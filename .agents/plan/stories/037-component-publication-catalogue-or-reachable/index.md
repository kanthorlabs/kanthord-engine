# EPIC 037 — Component publication: catalogue or reachable — stories

Epic: `.agents/plan/epics/037-component-publication-catalogue-or-reachable.md`
Prereq: EPIC 036 (sequence order).

After this epic, every emitted OpenAPI document holds the transitive closure of
its own references and nothing else, and a root extension
`x-kanthord-event-payloads` makes the 37 event payload schemas reachable in the
master and in `features/event.yaml`.

## Settled before dispatch

Four items were open at authoring time. All four are applied, so no story is
blocked and `/work` may open this epic.

- B1 - status:FIXED - action:YES - the compatibility gate has no legal fixture -
  The gate wanted the pre-epic `buildOpenApiDocument()` output captured as a
  committed fixture, which `AGENTS.md` refuses because it is a generated
  document. - fix:The EPIC gate item and the matching Decisions bullet now name
  the existing contract suite as the baseline and list exactly what it pins, plus
  two new assertions: the root key list, and that the pruning filter is the
  identity on the master. Story 2 test 4 adds the one missing assertion, that
  `components` holds no third key and `securitySchemes` no second scheme. -
  why:No stored artifact is committed, and the three previously unproven things
  are now covered: `paths` by the count, the bytewise order and `parity.test.ts`
  against the authored table in `docs/proposal/api/`; the schema bodies by
  `coverage.test.ts` and `example.test.ts`; `components.securitySchemes` by the
  new assertion.
- B2 - status:FIXED - action:YES - two EPIC statements disagreed with the tree -
  fix:The EPIC now says eight slices lose `Error` and names them, and the YAML
  example uses `node.created`. - why:The EPIC and the stories now agree, so
  `/work` receives one specification.
- S1 - status:FIXED - action:YES - AGENTS.md OpenAPI rule - fix:`AGENTS.md:107`
  now states the closure rule, the `x-kanthord-event-payloads` extension, and
  that the master and `features/event.yaml` carry it because both hold
  `event.list`. - why:The structure contract holds the rule, so a reviewer does
  not have to infer it.
- S2 - status:FIXED - action:YES - EPIC 038 story 01 would not apply -
  fix:`.agents/plan/stories/038-validate-every-emitted-document/01-every-slice-is-emitted-and-validated.md`
  Edit 1 now expects the three-symbol multi-line import this epic leaves, adds
  `openApiFeatures` in alphabetical position, and stops if it finds the old
  one-line form. - why:037 lands before 038, and the stale instruction would have
  produced a duplicate import block.

## Dispatch order

Strictly sequential, 1 through 5. Each story is one commit.

Story 1 removes dead code and stands alone. Story 2 adds the extension and leaves
the seeding untouched, so the suite is green with the master and every slice still
holding all 37 payload schemas. Story 3 adds the closure rule; it needs story 2's
extension to exist first, because without it the pruning would delete the 37
schemas from the master and break `event-payload.test.ts:564`. Story 4 is
test-only and proves the emitted artifacts. Story 5 records the rule in the
proposal.

Stories 2 and 3 are a coupled pair in one respect: story 3 moves the
`const catalogue = eventPayloadCatalogue(entries);` line that story 2 places
inside the return block up above the pruning. Story 3 names that move.

No story is safe to reorder. Story 3 before story 2 leaves the tree red.

## Stories

- 1 — Delete the unused `eventPayload` union from the contract → `01-delete-the-unused-payload-union.md`
- 2 — `buildOpenApiDocument` emits `x-kanthord-event-payloads` when the entry set holds `event.list` → `02-the-builder-emits-the-catalogue-extension.md`
- 3 — `reachableSchemaNames` computes the closure, and the builder prunes every document to it → `03-transitive-reachability-applied-to-every-document.md`
- 4 — `publish-contract.test.ts` proves the master, the 19 slices and byte reproducibility → `04-the-publication-proves-the-slice-contents.md`
- 5 — `docs/proposal/api/README.md` states the closure rule and the extension → `05-the-proposal-states-the-rule.md`

## Lanes

`scripts/lane-check.sh` splits the work, so a story names its lane.

| Story | Lane                                       |
| ----- | ------------------------------------------ |
| 1     | software-engineer                          |
| 2     | software-engineer + test-engineer          |
| 3     | software-engineer + test-engineer          |
| 4     | test-engineer only                         |
| 5     | software-engineer only (`docs/proposal/*`) |

`scripts/publish-contract.test.ts` is a test file under `scripts/`, so
`lane-check.sh:87-93` gives it to the test-engineer and denies it to the
software-engineer. `docs/proposal/*` is the reverse, by `lane-check.sh:99-101`.

## Facts (needed for implementation)

Measured against the tree at this commit, not quoted from the EPIC.

- **142 / 105 / 37.** The master's `components.schemas` holds 142 keys.
  A walk of `paths` alone reaches 105. The 37 unreached names are exactly
  `Object.keys(eventPayloads)`. Confirmed by running the builder.
- **`eventTypes.length` is 37**, and `Object.keys(eventPayloads).length` is 37.
  `retiredEventTypes` is empty. `src/domain/event-type.ts:1-41`.
- **19 feature slices**, so the publication writes 20 documents plus examples and
  a manifest: `actor`, `agent`, `attempt`, `binding`, `blob`, `edge`, `event`,
  `gitOperation`, `instructions`, `node`, `plan`, `profile`, `project`,
  `provider`, `repository`, `run`, `system`, `template`, `worker`.
- **Eight slices lose `Error`, not eleven.** The eight whose every operation
  declares its own `errors` are `actor`, `blob`, `edge`, `event`, `plan`,
  `project`, `provider` and `system`. The other eleven keep `Error`. The EPIC's
  Decisions section carries the same eight since B2 was applied.
- **`operationObject` mutates the schema map.** `src/http/contract/openapi.ts:113`
  calls `schemas.set` for each `.request`, `.response` and `.error` component
  while the paths loop at `:77-87` runs. Pruning must therefore happen after that
  loop, at the `sortedSchemas` block at `:89-93`.
- **The traversal runs over the emitted document, not over a synthetic probe.**
  Build the complete unpruned document, including the extension, call
  `reachableSchemaNames` on that object, then replace `components.schemas` with
  the filtered map. A probe such as `{ paths, components: { schemas: allSchemas } }`
  omits the roots `openapi`, `info` and `security`, so it contradicts the stated
  rule "seed from every root key except `components`". Both forms emit the same
  bytes today, because those three roots carry no `$ref`; only the document form
  stays correct when EPIC 039 puts a `$ref` under a new root key.
- **`Object.keys(allSchemas)` is already bytewise sorted** by the loop at
  `openapi.ts:90`, so filtering it preserves the canonical key order.
- **Every existing caller of `buildOpenApiDocument` uses the master default.**
  All 19 call sites are in `src/http/contract/openapi.test.ts` and one in
  `src/http/contract/event-payload.test.ts:565`. The only slice builder in the
  product is `renderOpenApiYaml(feature.operations)` at
  `scripts/publish-contract.ts:75`. Pruning therefore breaks no existing test.
- **Two existing tests are the strongest regression guards, and neither may be
  edited.** `src/http/contract/openapi.test.ts:211` pins the exact ordered list of
  the master's 142 component keys. `src/http/contract/event-payload.test.ts:564`
  asserts every one of the 37 types is a named component of the master. Their
  passing unmodified is the proof that the master's `components.schemas` did not
  change.
- **`openapi.test.ts:512`** walks the whole document with `collectRefs` at
  `:603-620` and requires every `$ref` to start with `#/components/schemas/` and
  to resolve. It covers the new extension for free.
- **Byte reproducibility already exists** at `scripts/publish-contract.test.ts:284`,
  with two `mkdtemp` directories. Story 4 changes its comparison at `:303` from
  `assert.deepEqual` on Buffers to `Buffer.compare(...) === 0`, to match the gate
  wording.
- **No `discriminator` and no nested `$ref` exists in the tree today.** Story 3's
  traversal for both is covered by hand-written fixtures. EPIC 039 introduces the
  first real case.
- **No OpenAPI extension key exists in the tree today.** `x-kanthord-client` at
  `src/http/server/preflight.ts:7` is a CORS request header, unrelated.
- **`SwaggerParser.validate(filePath)` is the only validator call form** used, in
  `src/http/contract/openapi.test.ts:542` and `scripts/publish-contract.test.ts:99`.
  It always takes a path to a YAML file on disk.
- **Pointer escape order.** `replaceAll("~1", "/")` must run before
  `replaceAll("~0", "~")`. The fixture that separates the two orders is the key
  `~1` referenced as `#/components/schemas/~01`: the correct order yields `~1`,
  the wrong order yields `/`.
- **`docs/proposal/api/README.md`** holds the target section at `:13-21`. Line 13
  is the heading, 15 is the self-contained rule and the external-`$ref` refusal,
  17 is the feature-slice paragraph, 19 is the not-committed reason, 21 is the
  verify and publish paragraph. Lines 14, 16, 18 and 20 are blank.
