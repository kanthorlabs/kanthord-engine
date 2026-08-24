# Story 07 — the coverage assertion widens to schema, example and error coverage

Epic: `.agents/plan/epics/009.5-contract-schemas.md`
Depends on: Story 06.

The assertion walks the registry, never a hand-written list, so a `routed` operation added later without a
schema or an example set fails the build.

## Change

All additions go in `src/http/contract/coverage.test.ts`, created by Story 02 and extended by Stories 03 and 05.
Reuse its `describe` title and its `objectNodes` helper. Add the shared scope filter from `src/http/contract/example.test.ts`:

```ts
const scoped = registry.filter(
  (entry) =>
    entry.status === "routed" &&
    entry.introducedIn === "phase-1" &&
    entry.operationId !== "blob.show",
);
```

### 1. Response coverage

`"every phase-1 routed operation but blob.show carries a response schema"` — walk `scoped` and assert
`entry.response !== undefined`, naming the `operationId`. Assert `scoped.length === 22`.

### 2. `blob.show` is the one exemption, and it is deliberate

`"blob.show is the only routed operation with no response schema"` — walk `registry` for
`entry.status === "routed" && entry.response === undefined`, and assert the resulting `operationId` list
deep-equals `["blob.show"]`. `src/http/contract/system.ts:94` is the entry. EPIC 010 owns its media contract.

### 3. Example coverage

`"every phase-1 routed operation but blob.show carries an example set"` — walk `scoped` and assert
`entry.examples !== undefined`, naming the `operationId`.

### 4. A `stubbed` operation carries nothing, and adding one is a fault

`"a stubbed operation declares no schema and no example"` — walk `registry` for `entry.status === "stubbed"`
and assert all four of `entry.query`, `entry.request`, `entry.response` and `entry.examples` are `undefined`.
Assert the stubbed count is 30, matching `src/http/contract/registry.test.ts:29`.

`docs/proposal/api/README.md` makes an operation with no schema correct until the phase that implements it, and
dispatch answers `501` before the body parser runs, so a schema on a stubbed entry is dead weight that a
consumer would generate against.

### 5. Error coverage, and the dead `outside-writer` branch

`"every phase-1 routed operation declares errors"` — walk `scoped` **plus `blob.show`** and assert
`entry.errors !== undefined`. `blob.show` carries no response schema but it still answers errors, so it is **not**
exempt here — this is the one assertion where the `blob.show` exemption does not apply.

`"no stubbed operation declares errors"` — already covered by step 4's four-field check; extend that check to
`entry.errors`.

`"the outside-writer refusal stays unreachable"` — read every non-test `.ts` file under `src/commands/` and
`src/http/server/` and assert none constructs a `RegisterRepositoryError` with `"outside-writer"`. Match
`/new RegisterRepositoryError\(\s*\n?\s*"outside-writer"/`. `src/commands/repository/register-repository.ts:52`
declares it in the refusal union and `src/http/server/repository/refusals.ts:43-47` maps it, and Story 05 records
that as a finding. This assertion pins the status quo so the finding cannot rot silently: the day someone wires it,
this test fails and forces the `details` shape decision.

### 6. The cursor shape is one declaration

Two assertions, because a field-name grep alone is a weak proxy.

`"after and limit are declared exactly once"` — read every non-test `.ts` file under `src/http/contract/`,
bytewise sorted by name. Assert that exactly one file matches `/^\s*after:/m` and that the same one file matches
`/^\s*limit:/m`, and that the file is `cursor.ts`.

`"every paging schema derives from cursorRequest"` — the structural half. For every registry entry with a
`query`, convert it and assert that when the emitted JSON Schema declares an `after` or a `limit` property, both
are present and each deep-equals the corresponding property of
`z.toJSONSchema(cursorRequest, { target: "openapi-3.0", io: "input" })`. A second cursor declared by copy rather
than by `.extend(cursorRequest)` then fails on any drift in `minimum`, `maximum` or `default`, which the grep
would not catch.

### 7. The `501` of a stubbed route is unchanged by this epic

This owns the EPIC's last hermetic-coverage bullet, which otherwise has no story and would rest on `npm test`
alone.

`"a stubbed route still answers 501 and writes nothing"` — do **not** write a new sweep. The EPIC 004 sweep
already exists in `src/http/server/dispatch.test.ts`. This story:

- names it, and asserts it is unmodified by this epic — `git diff --stat` over
  `src/http/server/dispatch.test.ts` between the epic's base commit and `HEAD` is empty;
- runs it as a regression gate: `node --test src/http/server/dispatch.test.ts` passes;
- adds one assertion to `coverage.test.ts` that the stubbed count is still 30 and that
  `registry.filter((entry) => entry.status === "stubbed").length` equals the number of operations the dispatch
  sweep covers, so a stubbed route added later without a `501` case fails here.

Story 05 rebuilds the envelope, and a `501` body is `{error:{code:"not-implemented",message:...}}`. The
`not-implemented` member of `baselineErrors` carries no `details`, so an existing `501` body still parses
unchanged. Assert that explicitly: `buildErrorEnvelope(baselineErrors).parse({error:{code:"not-implemented",
message:"not implemented"}})` succeeds.

### 8. The generated document resolves a named component for each of the 22

Add to `src/http/contract/openapi.test.ts`:

- `"every phase-1 routed operation but blob.show refers to a response component"` — for each `scoped` entry,
  find its operation object through the existing `operationObjects()` helper (`openapi.test.ts:31`), and assert
  `responses["200"].content["application/json"].schema` deep-equals
  `{ $ref: "#/components/schemas/<operationId>.response" }`.
- `"no routed operation but blob.show resolves to an empty response body"` — walk every routed operation object;
  assert `responses["200"].content` is defined for all of them except `blob.show`, and that for `blob.show`
  `responses["200"]` has no `content` key.
- `"every response component resolves"` — every `$ref` collected by the existing `collectRefs()` helper
  (`openapi.test.ts:333`) names a key present in `components.schemas`. This restates the existing `:242`
  assertion over a document that now carries a real schema for every operation in scope, so keep both.

### 9. Leave `parity.ts` and `parity.test.ts` alone

`src/http/contract/parity.ts:30` `compareRouteSets` compares `operationId`, `method`, `path`, `introducedIn` and
`status`. It does not read a schema, and `docs/proposal/api/README.md:11` states the two artifacts do not
overlap: the proposal tables never restate a field schema. Widening `ParityRow` with a schema column would put
schema facts in a document that refuses to hold them. The coverage assertion therefore lives in
`coverage.test.ts` beside the registry it walks, and `parity.test.ts` keeps asserting the operation set only.

## Constraints

- Every assertion in this story derives its subject from `registry`. Write no list of operation ids, with the
  single exception of the `["blob.show"]` exemption in step 2, which is the assertion's whole point.
- Add no operation, change no `status`, and change no schema.
- Do not change `src/http/contract/parity.ts`.

## Verify

- `node --test src/http/contract/coverage.test.ts` — every assertion passes. Then, one at a time, and restoring
  after each: remove `response:` from `src/http/contract/project.ts`'s `project.list` entry and confirm step 1
  fails naming `project.list`; remove its `examples:` binding and confirm step 3 fails; add
  `response: projectListResponse` to a stubbed entry such as `binding.worker.project` and confirm step 4 fails;
  declare `limit: z.number()` in `src/http/contract/graph.ts` and confirm step 6 fails; remove `errors:` from `blob.show` and confirm step 5 fails.
- `node --test src/http/contract/openapi.test.ts` — the three new tests pass alongside `:205` the 30-component
  list, `:242` internal refs, `:261` the byte-identical render and `:269` `SwaggerParser.validate`.
- `node --test src/http/contract/parity.test.ts` — passes unchanged, all 12 tests.
- `npm test` — the whole suite passes.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`.
