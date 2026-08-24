# Story 10 — The three routes move from `stubbed` to `routed`

Epic: `.agents/plan/epics/103-repository-profile-and-templates.md`
Depends on: coupled Stories 7, 8 and 9.

## Change

### The new error code

- In `src/http/contract/errors.ts:26-27`, add `"profile-invalid": 422` immediately after `"credential-rejected": 422` and before `"internal-error": 500`.
- In `docs/proposal/api/README.md:189-190`, add the row below immediately after the `credential-rejected` row, so the code table and `errorStatuses` keep the same row position.

  ```
  | 422    | `profile-invalid`          | the profile document failed validation, and `details` lists every finding |
  ```

### The finding schema and the details schema

- Add `src/http/contract/profile-finding.ts` mirroring `src/http/contract/plan-finding.ts`: `export const profileFinding = z.strictObject({ code: z.enum(profileFindingCodes), locator: z.string().nullable(), message: z.string() })`, importing `profileFindingCodes` from `../../domain/profile-finding.ts`.
- In `src/http/contract/error-details.ts`, add `export const profileInvalidDetails = z.strictObject({ findings: z.array(profileFinding) })` beside `planInvalidDetails` at line 55.

### The request and response schemas

- Add the three schemas to `src/http/contract/instruction.ts`, which currently imports only `./path.ts` and `./operation.ts`.
- Add `export const profileCheckEntry = z.strictObject({ run: z.array(z.string()).min(1), timeout: z.string().min(1) })`, the shape the EPIC names for the request: "`run`, a non-empty array of strings, and `timeout`, a string".
- **Pin the 400/422 boundary explicitly, because the two rules overlap.** The request schema owns _structure_: a `checks` value that is not an object, a third key beside `unit` and `e2e`, a `run` that is not an array, a `run` element that is not a string, an empty `run`, and a `timeout` that is not a string all fail `safeParse` and answer `400 invalid-request`. The command owns _meaning_: an unknown check name is impossible through this schema, and `check-cannot-fail`, `check-timeout-invalid` for a well-formed string that is not a minute token, and `check-missing` when the merged map still lacks `unit` all answer `422 profile-invalid`. A confirmed field therefore reaches the same `validateChecks` rules as an imported one; only the structural subset is refused earlier and more cheaply. `check-run-empty` and `check-run-invalid` are reachable through `profile.import`, whose document is free-form YAML, and not through `profile.instantiate`.
- Add `export const profileInstantiateRequest = z.strictObject({ templateId: z.string().min(1), checks: z.strictObject({ e2e: profileCheckEntry.optional(), unit: profileCheckEntry.optional() }).optional() })`. Declare `checks` as a strict object with two optional keys, not a record, so the key set is closed to `unit` and `e2e` and the emitted JSON pointers are fixed.
- Add `export const profileImportRequest = z.strictObject({ document: z.string().min(1), fromHash: blobHash.nullable() })`, importing `blobHash` from `../../domain/blob.ts`.
- Add `export const profileDocumentResponse = z.strictObject({ document: z.string(), contentHash: blobHash })`, and alias it as `profileInstantiateResponse`, `profileExportResponse` and `profileImportResponse`, so each of the three operations names its own response entry.
- The request carries no template version and no digest. The daemon records the version and the digest it ships, so no client can claim a version.

### The examples

- Add `profileInstantiateExamples`, `profileExportExamples` and `profileImportExamples`, each an `OperationExamples`, using `EXAMPLE_HASH as H` and `EXAMPLE_ULID as U` from `./example-literal.ts`.
- Give the instantiate example the request `{ templateId: "nodejs", checks: { unit: { run: ["npm", "run", "test:ci"], timeout: "5m" } } }`, a success of `{ document: "---\nschema: \"kanthord.profile/v1\"\n", contentHash: H }`, and the error `{ error: { code: "profile-invalid", message: "the profile document is invalid", details: { findings: [{ code: "check-cannot-fail", locator: "unit", message: "check unit declares a command that cannot fail" }] } } }`.
- Give the export example a success with the same two fields and the error `{ error: { code: "not-found", message: \`no profile for repository repo_${U}\` } }`.
- Give the import example the request `{ document: "---\nschema: \"kanthord.profile/v1\"\n", fromHash: H }`, the same success shape, and the same `profile-invalid` error as instantiate.
- Every example must parse against its schema; `src/http/contract/example.test.ts:27-39` parses examples for its scoped set, and a hand-written example that fails its own schema is a defect.

### The operation entries

- In `src/http/contract/instruction.ts:26-34`, set `profile.instantiate` to `status: "routed"`, keep `idempotency: "memory"` and `replayable: [200]` unchanged, and add `request: profileInstantiateRequest`, `response: profileInstantiateResponse`, `errors: { ...baselineErrors, "profile-invalid": profileInvalidDetails, "illegal-transition": illegalTransitionDetails }` and `examples: profileInstantiateExamples`.
- In `src/http/contract/instruction.ts:35-41`, set `profile.export` to `status: "routed"` with `response: profileExportResponse`, `errors: { ...baselineErrors }` and `examples: profileExportExamples`.
- In `src/http/contract/instruction.ts:42-48`, set `profile.import` to `status: "routed"` with `request: profileImportRequest`, `response: profileImportResponse`, `errors: { ...baselineErrors, "profile-invalid": profileInvalidDetails, "stale-revision": staleRevisionDetails }` and `examples: profileImportExamples`.
- Import `baselineErrors` from `./error-baseline.ts` and the details schemas from `./error-details.ts`. Reuse `staleRevisionDetails` at `src/http/contract/error-details.ts:9-12`, whose shape is `{ expected: string | null, current: string | null }`.
- Add `export const illegalTransitionDetails = z.strictObject({ contentBlob: blobHash })` to `src/http/contract/error-details.ts`. No such schema exists today, and `illegal-transition` is a `PreconditionCode`, so `httpError` at `src/http/contract/errors.ts:94-98` requires a details argument for it.
- Do not add a method, a path segment, an `introducedIn` or a `successStatus` to any of the three. `httpError` at `src/http/contract/errors.ts:94-110` forces a `details` argument for a `409` code, so both `409` codes must declare a details schema.
- Leave `agent.list`, `template.list`, `template.show`, `profile.verify` and `instructions.resolve` at `status: "stubbed"` with no schema, no example and no errors.

### The proposal table

- In `docs/proposal/api/instruction.md:14`, `:15` and `:16`, change only the `status` cell of `profile.instantiate`, `profile.export` and `profile.import` from `stubbed` to `routed`. `src/http/contract/parity.test.ts:12-22` compares the registry against that table through `readRouteMatrix`.
- Change no other cell and no other row. `parity.test.ts:25` pins the total at `58` rows and `:16` pins the comparable set at `54`.

### The handlers

- Add `src/http/server/profile/instantiate-profile.ts`, `src/http/server/profile/export-profile.ts` and `src/http/server/profile/import-profile.ts`. Each parses the request, calls exactly one command or query, and formats the response. None branches on a domain rule.
- Model `instantiate-profile.ts` and `import-profile.ts` on `src/http/server/plan/import-plan.ts:13-43`: read `context.parameters["id"]`, throw `httpError("not-found", "no repository id in the request path")` when it is `undefined`, `safeParse` the body and throw `httpError("invalid-request", …)` on failure, then call the command inside a `try` and map a thrown error through the new `toHttpError`.
- Model `export-profile.ts` on `src/http/server/plan/export-plan.ts:10-31`.
- Pass `actor: dependencies.actor` into both commands, exactly as `importPlanHandler` does.
- Add `src/http/server/profile/refusals.ts` exporting `toHttpError(error: unknown): HttpError`, following `src/http/server/plan/refusals.ts`. Map `ProfileInvalidError` to `httpError("profile-invalid", error.message, { findings: error.findings })`. Map `InstantiateProfileError` refusal `repository-not-found` and `ImportProfileError` refusal `repository-not-found` to `not-found`. Map `InstantiateProfileError` refusal `profile-exists` to `httpError("illegal-transition", error.message, { contentBlob: error.contentBlob })`, so `InstantiateProfileError` carries a `readonly contentBlob: string` field holding the existing content hash. Map `ImportProfileError` refusal `stale-revision` to `httpError("stale-revision", error.message, { expected: error.expected, current: error.current })`, so `ImportProfileError` carries `readonly expected: string | null` equal to the supplied `fromHash` and `readonly current: string | null` equal to the stored `content_blob` or `null`. Rethrow anything else.
- Return `{ status: 200, body: result }` from all three handlers.

### Composition

- In `src/main.ts:163`, construct `const profiles = new SqliteProfileStore();` beside `const plan = new SqlitePlanStore();`.
- In `src/main.ts`, add the three handler keys to the object literal that closes at line 337. Each value is the **handler factory**, never the command itself, matching `"plan.import": importPlanHandler({ … })` at `src/main.ts:329-336`:
  - `"profile.instantiate": instantiateProfileHandler({ instantiateProfile: (input) => instantiateProfile({ storage, profiles, blobs, ids, clock, events }, input), actor: settings.actor })`
  - `"profile.export": exportProfileHandler({ exportProfile: (input) => exportProfile({ storage, profiles, blobs }, input) })`
  - `"profile.import": importProfileHandler({ importProfile: (input) => importProfile({ storage, profiles, blobs, reader, ids, clock, events }, input), actor: settings.actor })`
- Add the matching imports beside the existing store, command, query and handler import blocks. `unimplementedFor(handlers)` at `src/main.ts:338` then drops the three from the shared `501` set with no further change.

### The pinned counts

- `src/http/contract/errors.test.ts:28` — change the title to `pins the twenty-three codes in table order`, and insert `"profile-invalid"` after `"credential-rejected"` in the list at `:29-52`.
- `src/http/contract/errors.test.ts:76-81` — append `"profile-invalid"` as the fifth entry of the `422` group.
- `src/http/contract/errors.test.ts:89` and `:94` — change `22` to `23`.
- `src/http/contract/registry.test.ts:34-43` — routed becomes `30`, stubbed becomes `24`.
- `src/http/contract/registry.test.ts:83` — change the title to `attaches requests to the ten write routes and responses to the twenty-nine routes`; insert `"profile.import"` and `"profile.instantiate"` into the request list between `"plan.validate"` and `"project.create"`; insert `"profile.export"`, `"profile.import"` and `"profile.instantiate"` into the response list between `"plan.validate"` and `"project.create"`.
- `src/http/contract/registry.test.ts:20`, `:25` and `:45-60` do not change: the registry still holds `54` operations, and the phase counts are unchanged because all three are already `phase-2`.
- `src/http/contract/coverage.test.ts:361` — change `27` to `24`.
- `src/http/contract/coverage.test.ts:332` and `src/http/contract/example.test.ts:8-17` do not change; both scope to `phase-1`, and these three operations are `phase-2`.
- `src/http/contract/coverage.test.ts:19-31` `operationAdditions` does not change; the assertion that consumes it scopes to `phase-1`.
- `src/http/server/dispatch.test.ts:458` — change `27` to `24`; this is the stub count.
- `src/http/server/app.test.ts:363,368` — the `bound` object holds `system.health` and `system.db` only, so the number is `routed - 2`, not `stubbed`. It is `25` today against 27 routed, and becomes **`28`** against 30 routed. Change the title to `binding system.health and system.db leaves twenty-eight unimplemented ids` and the assertion to `28`.
- `src/http/server/dispatch.test.ts:191-194` — the same `routed - 2` count in the `the complete binding …` test. Change the title to `derives twenty-eight unimplemented ids` and the assertion from `25` to `28`.
- `src/http/contract/system.test.ts:321` — change `26` to `29`.
- `src/http/contract/openapi.test.ts:205` — the title says `sixty` but the asserted array holds **62** entries today (one `Error`, 27 operation errors, 26 responses, 8 requests), so the title is already stale. Adding eight keys makes it **70**. Change the title to `registers exactly the seventy schema components in bytewise order`, and insert these eight keys between `"plan.validate.response"` and `"project.create.error"`, in this order: `profile.export.error`, `profile.export.response`, `profile.import.error`, `profile.import.request`, `profile.import.response`, `profile.instantiate.error`, `profile.instantiate.request`, `profile.instantiate.response`.
- `src/http/contract/openapi.test.ts:78` does not change; all three operations render the same path `/v1/repository/:id/profile`, which the registry already counted.
- `src/http/contract/field-decisions.fixture.ts` — add these sixteen rows in the file's existing bytewise order: `profile.export.response#/properties/contentHash`, `profile.export.response#/properties/document`, `profile.import.request#/properties/document`, `profile.import.request#/properties/fromHash`, `profile.import.response#/properties/contentHash`, `profile.import.response#/properties/document`, `profile.instantiate.request#/properties/checks`, `profile.instantiate.request#/properties/checks/properties/e2e`, `profile.instantiate.request#/properties/checks/properties/e2e/properties/run`, `profile.instantiate.request#/properties/checks/properties/e2e/properties/timeout`, `profile.instantiate.request#/properties/checks/properties/unit`, `profile.instantiate.request#/properties/checks/properties/unit/properties/run`, `profile.instantiate.request#/properties/checks/properties/unit/properties/timeout`, `profile.instantiate.request#/properties/templateId`, plus `profile.instantiate.response#/properties/contentHash` and `profile.instantiate.response#/properties/document`. Every row ends ` required=true nullable=false enum=-` except `fromHash`, which is `required=true nullable=true enum=-`, and `checks`, `checks/properties/e2e` and `checks/properties/unit`, which are `required=false nullable=false enum=-`. `src/http/contract/coverage.test.ts:255-286` derives the rows from the emitted document, so run that test and pin exactly what it emits; the list above is the expected set, not a substitute for the emitted one.
- `src/main.test.ts` — add three fixture keys to the map that closes at line 136: `"profile.export": { parameters: { id: missing("repository") }, expect: 404 }`; `"profile.instantiate": { parameters: { id: missing("repository") }, body: { templateId: "nodejs" }, expect: 404 }`; `"profile.import": { parameters: { id: missing("repository") }, body: { document: "not a profile", fromHash: null }, expect: 422 }`. The tests at `src/main.test.ts:182-227` require a fixture key for every routed operation.
- The import fixture expects `422`, not `404`, and that is deliberate: Story 7 validates the document **before** it opens the transaction, so an unparsable document refuses with `profile-invalid` and never reaches the repository lookup. The instantiate fixture keeps `404`, because `templateId` of `nodejs` with no `checks` merges to the valid template map, passes validation, and then hits `repository-not-found` inside the transaction. Do not "fix" either fixture by reordering Story 7's refusals.

## Constraints

- Do not branch on a domain rule in any of the three handlers; the signature admits parse, invoke and format only.
- Do not import a command or a query from `src/http/contract/`; the contract holds no koa and no handler.
- Do not flip `profile.verify`, `agent.list`, `template.list`, `template.show` or `instructions.resolve`; EPIC 109 owns verify and the catalogue stays deferred.
- Do not change the method, path tuple, `introducedIn`, `idempotency` or `replayable` of any of the three operations.
- Do not add a field to `profileInstantiateRequest`. EPIC 114 drives this route through onboarding, so the field set is closed here and onboarding adds none.
- Do not hand-edit a generated OpenAPI document.

## Verify

- Add `src/http/server/profile/instantiate-profile.test.ts`, `export-profile.test.ts` and `import-profile.test.ts` with real koa through `createTestApp` of `test/helpers/app.ts`.
- Assert `profile.instantiate` with `checks.unit.run` of `["true"]` answers `422`, `body.error.code` equals `profile-invalid`, `body.error.details.findings[0].code` equals `check-cannot-fail`, and `SELECT COUNT(*) FROM profile` equals `0`.
- Assert `profile.import` with a `true` unit command answers `422 profile-invalid` and `body.error.details.findings[0].locator` equals `unit`.
- Assert `profile.instantiate` on a repository that already holds a profile answers `409` with code `illegal-transition`, and that a replay of the **same** idempotency key answers `200` with the original document, compared with `Buffer.compare` equal to `0`.
- Assert `profile.import` with a stale `fromHash` answers `409` with code `stale-revision`, and `content_blob` is unchanged.
- Assert `profile.export` on a repository with no profile answers `404` with code `not-found`.
- Assert `profile.instantiate` with `checks.unit.run` of `["npm", "run", "test:ci"]` and `timeout` of `5m` answers `200`, and a following `profile.export` returns a document whose `unit` entry holds `["npm", "run", "test:ci"]` and `5m`, and not `["npm", "test"]` and `10m`.
- Assert an instantiated `nodejs` profile exports the exact expected document, asserted whole with `Buffer.compare(actual, expected) === 0`.
- Assert export, then `profile.import` of those same bytes with the matching `fromHash`, then export again returns identical bytes with `Buffer.compare` equal to `0`, and `content_blob` unchanged.
- Assert a malformed instantiate body answers `400 invalid-request`, and that a body carrying a third `checks` key `lint` answers `400`, because the request schema closes the key set.
- Assert the settled 400/422 split at the route: `checks.unit.run` of `[]` answers `400 invalid-request`, `checks.unit.timeout` of `7` answers `400`, and `checks.unit.timeout` of `10s` answers `422 profile-invalid` with `details.findings[0].code` equal to `check-timeout-invalid`. The first two are structural and the third is semantic.
- Assert `profile.instantiate` with a body carrying no `templateId` answers `400`.
- Add or extend `src/http/contract/instruction.test.ts` asserting the registry declares `profile.instantiate`, `profile.export` and `profile.import` as `routed`, and `agent.list`, `template.list`, `template.show`, `profile.verify` and `instructions.resolve` as `stubbed`.
- Run `node --test src/http/contract/*.test.ts src/http/server/profile/*.test.ts src/main.test.ts`; all exit 0.
- Run the EPIC Proof command; it prints `PASS EPIC-103`.
- Run `npm run verify`; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage lines 53, 54, 55, 56, 72, 73, 74, 75 and 76.
