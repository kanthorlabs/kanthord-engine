# EPIC 009.5 — Contract schemas, ahead of the handlers — stories

Epic: `.agent/plan/epics/009.5-contract-schemas.md`
Prereq: EPIC 009 (sequence order).

Every phase-1 `routed` operation except `blob.show` declares a request and response schema that rejects an
unknown key, error `details` is typed per code, and one script publishes the generated document plus an
example set.

## Dispatch order

01 → 02 → 03 → 04 → 05 → 06 → 07 → 08. Every story is unblocked.

- **01 before 02** because `event.list` is authored strict at birth, so the sweep never revisits it.
- **02 before 03** because strictness fixes the final JSON Schema representation _before_ Story 03 captures its
  field-decision fixture. Capturing the fixture first would mean regenerating all of it after the sweep. The
  ordering is about the fixture, not about the enum work: Story 02 does not need the domain arrays, and Story 03
  could export them at any time.
- **04 and 05 are a coupled pair.** 04 authors the named `details` schemas and makes production emit them; 05
  binds them to operations and rebuilds the envelope. They split because 04 touches three production files and 05
  touches the registry and the generator.
- **06 before 07** because 07 asserts the example set 06 authors.
- **07 and 08 are not a coupled pair.** 08 consumes the example set but adds no assertion to 07's walk.

## Decisions the human ratified, and what they cost

The EPIC claims `docs/proposal/api/README.md` "names each one's contents" for the ten error codes. It does not.
Four decisions were escalated and answered. They are binding, and no story may re-open them.

| Decision                    | Ratified answer                                                             | Cost                                                                                              |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `stale-revision` `details`  | `{expected, current}` — self-contained conflict evidence                    | **Adds `expected`** to production. The non-goal "does not add a field" is lifted for this payload |
| `binding-in-use` `details`  | a discriminated `{blockers: [...]}` list, at least one, deterministic order | The field names are newly decided here, not read from a source                                    |
| `needs-reconcile` `details` | `{divergedLandingOid, divergedUpstreamOid}`, both required and non-null     | Reuses the names already in `repositoryView` and `systemStatusResponse`                           |
| details keying              | per **`(operationId, code)`**, not globally per code                        | A new story 05, and edits to `Operation`, `openapi.ts` and the pinned component list              |

Three findings were raised rather than fixed, and each has an assertion pinning the status quo so it cannot rot:

- **`identity-kind-mismatch` is not an HTTP code.** It is a plan finding code (`src/domain/plan-finding.ts:15`)
  and nothing throws it as an `httpError`. It stays in `errorStatuses` because `errors.test.ts:13-23` asserts
  parity with `readErrorCodeMatrix()` and `README.md:186` lists it. Story 05 declares it on no operation. Whether
  `README.md` should drop it is a proposal decision.
- **The `outside-writer` → `stale-revision` mapping is dead.** `src/http/server/repository/refusals.ts:43-47`
  maps it and `src/commands/repository/register-repository.ts:52` declares it, but no file throws it, and its
  `{expectedOid, observedOid}` shape contradicts the ratified one. Story 07 asserts it stays unreachable.
- **`invalid-request` carries `details` inconsistently.** Some handlers emit `{refusal}` and some emit nothing,
  so `refusal` must be optional and a client cannot rely on it. A handler cleanup for a later epic.

## The EPIC needs four amendments

`/author` does not edit the EPIC. These are the edits the human must make so the EPIC and the stories agree:

1. The story list is **eight**, not seven — Story 05 is new.
2. The non-goal "**No new field on an operation that already answers**" is lifted for the `stale-revision`
   `details` payload.
3. The typed-details list is **eleven** codes, not ten: `idempotency-mismatch` carries `{differed}` at
   `src/commands/plan/import-plan.ts:532-538` and the EPIC omits it.
4. `event.list` binds its schema to a new **`query`** slot on `Operation`, not to `request`. The EPIC never says
   which slot, and `openapi.ts:117-131` would otherwise put a required request body on a `GET`.
   `docs/proposal/api/graph.md:102` says the API has "no query-parameter mechanism", which this contradicts and
   which the EPIC should acknowledge.

## Stories

- 01 — `event.list` request and response, and the one cursor shape → `01-event-list-schemas.md`
- 02 — every object schema becomes `z.strictObject` → `02-strict-object-sweep.md`
- 03 — the four decisions each field carries, and every enum from `domain/` → `03-field-decision-audit.md`
- 04 — one named `details` schema per error code → `04-error-details-schemas.md`
- 05 — errors declared per operation, one envelope per operation → `05-per-operation-error-contract.md`
- 06 — one request, success and error example per operation → `06-example-set.md`
- 07 — the coverage assertion widens to schema, example and error coverage → `07-coverage-assertion.md`
- 08 — one script publishes the document and the example set → `08-published-artifact.md`

## Facts (needed for implementation)

### The registry and its pinned counts

- `src/http/contract/registry.ts:24-37` concatenates ten domain arrays and sorts by `operationId` bytewise.
- `src/http/contract/operation.ts:19-28` is the `Operation` type. `request?: ZodType` and `response?: ZodType`
  are the only schema slots today.
- Pinned counts that stories change: `src/http/contract/registry.test.ts:14` 53 operations, `:29` 23 routed /
  30 stubbed, `:40` 23 phase-1, `:78-115` the by-name lists of 7 entries with `request` and 21 with `response`.
- `src/http/contract/openapi.test.ts:74` pins 47 paths, `:112` pins 53 operations, `:205` pins the 29
  component names as a literal list.
- The phase-1 `routed` set is 23 operations. `blob.show` (`src/http/contract/system.ts:94`) is the one routed
  entry with no `response`, so the schema-and-example scope of this epic is **22 operations**.

### The generator

- `src/http/contract/openapi.ts:12` `buildOpenApiDocument()`, `:65` `renderOpenApiYaml()`, `:69`
  `operationObject(entry, schemas)`.
- zod → JSON Schema is native zod 4 `z.toJSONSchema(schema, { target: "openapi-3.0", io })`. Three call
  sites: `:16` the `Error` component, `:95` responses (`io: "output"`), `:121` requests (`io: "input"`).
- Components are named `Error`, `<operationId>.request`, `<operationId>.response` and referenced by
  `$ref: "#/components/schemas/<name>"`.
- Order is fixed: path keys bytewise (`:34`), methods by `fixedMethodOrder` (`:10`), components bytewise
  (`:48`), top-level keys by the literal at `:53-62`.
- `openapi.ts:117-131` renders **any** entry carrying `request` as a `requestBody` with `required: true`,
  regardless of method. Story 01 adds the query mechanism rather than putting a body on a `GET`.
- Generate → write → validate → delete lives in `src/http/contract/openapi.test.ts`, not in a script:
  `:60` `mkdtempSync`, `:270` write, `:272` `await SwaggerParser.validate`, `:61-63` the `after` hook removes
  the directory. `@apidevtools/swagger-parser@12.1.0` is a devDependency and `:312` asserts it never appears
  in a production source.

### The z.object inventory story 02 must convert (exhaustive)

| file                              | `z.object` sites                                                     |
| --------------------------------- | -------------------------------------------------------------------- |
| `src/http/contract/credential.ts` | 10, 16, 26                                                           |
| `src/http/contract/graph.ts`      | 10, 15, 20, 29, 33, 40, 49, 50, 53, 58, 66, 74, 79, 85, 97, 108, 115 |
| `src/http/contract/project.ts`    | 12, 14, 23, 24                                                       |
| `src/http/contract/repository.ts` | 6, 11, 16, 19, 45, 63, 67, 85                                        |
| `src/domain/provider-payload.ts`  | 41 `llmProjection`, 47 `gitProjection`                               |

- `src/http/contract/system.ts` is already `z.strictObject` at all 9 object nodes (`9, 12, 19, 21, 30, 36, 42,
50, 58`). It is the rule the sweep generalises.
- `src/http/contract/graph.ts:99` is `nodeListItem.extend({...})`. `.extend()` inherits the base strictness,
  so it needs **no** edit once `:85` is strict.
- `src/domain/provider-payload.ts:41,47` are in scope because `providerView.projection`
  (`credential.ts:20`) reaches them, so the registry walk sees them. `provider-payload.ts:31` already uses
  `.strict()`, so strictness is an established domain idiom.
- `src/http/contract/errors.ts:36-37` is **not** story 02's. Story 04 replaces that schema outright.

### Enums restated in the contract, and the `domain/` array each needs

| contract site                  | restated literal                                         | fix                                                                            |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `graph.ts:43`                  | `["both","document-only","database-only"]`               | export `presences` from `src/domain/plan-choice.ts` (type `Presence` at `:17`) |
| `graph.ts:47`                  | `["body","depends_on","parent","repo","title","worker"]` | export `differingFields` from `src/domain/plan-choice.ts` (type at `:6-7`)     |
| `graph.ts:61`, `graph.ts:76`   | `z.string().regex(/^sha256:[0-9a-f]{64}$/)`              | use `blobHash`, already imported in the file from `src/domain/blob.ts:5`       |
| `repository.ts:74`             | `["ready","needs-reconcile"]`                            | export `repositoryStates` from `src/domain/repository.ts` (inline at `:17`)    |
| `system.ts:10`, `system.ts:34` | `["ok","degraded"]`                                      | export `healthStatuses` from `src/domain/health.ts` (type at `:9`)             |
| `system.ts:7`                  | `dependencyStatuses` declared **in the contract**        | move to `src/domain/health.ts` beside `DependencyStatus` at `:1`               |
| `system.ts:59`                 | `["node","repository"]`                                  | export `leaseSubjectKinds` from `src/domain/lease.ts` (inline at `:7`)         |
| `domain/event.ts:11`           | `["human","daemon"]`                                     | export `actorKinds` from `src/domain/event.ts` — **story 01 does this one**    |

Enums already imported correctly, which no story touches: `providerKinds` (`credential.ts:12,19`),
`findingCodes` (`graph.ts:34`), `nodeKinds` (`graph.ts:42,88`), `nodeStates` (`graph.ts:44,90`), `choices`
(`graph.ts:45,74`), `blockReasons` (`graph.ts:91`), and the prebuilt `nodeKind` / `nodeState` / `blockReason`
schemas (`system.ts:43,44,45`).

### The `details` shape every phase-1 code actually emits

This table is read from the production throw sites. It is the anchor for story 04, because
`docs/proposal/api/` names field keys for `stale-revision` only, and even there it names two sets that it
never reconciles.

| code                     | emitted `details`                                                                | site                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `stale-revision`         | **ratified** `{ expected, current }` — `current` from the site, `expected` added | `src/commands/plan/import-plan.ts:141-145` → `plan/refusals.ts:23`       |
| `choices-stale`          | `{ conflicts: { id: string, suggested: Choice }[] }`                             | `src/commands/plan/import-plan.ts:151-155`, `:475-486`                   |
| `choices-changed`        | `{ conflicts: { id: string, reason: string }[] }`                                | `src/commands/plan/import-plan.ts:233`, `:287-291`                       |
| `plan-invalid`           | `{ findings: Finding[] }`                                                        | `src/http/server/plan/refusals.ts:11-13`                                 |
| `choices-invalid`        | `{ findings: Finding[] }`                                                        | `src/http/server/plan/refusals.ts:15-17`                                 |
| `host-key-mismatch`      | `{ presented: string[], confirmed: string \| null }`                             | `src/http/server/repository/refusals.ts:34-37`                           |
| `host-key-mismatch`      | `{ failure: "host-key-mismatch" }`                                               | `src/http/server/repository/refusals.ts:65-67`                           |
| `credential-rejected`    | `{ failure: "auth-failed" \| "permission-denied" }`                              | `src/http/server/repository/refusals.ts:57-63`                           |
| `idempotency-mismatch`   | `{ differed: string }`                                                           | `src/commands/plan/import-plan.ts:532-538`                               |
| `needs-reconcile`        | **ratified** `{ divergedLandingOid, divergedUpstreamOid }`                       | no throw site; names from `repository.ts:78-79`                          |
| `binding-in-use`         | **no production throw site** (the removal route is phase-2 stubbed)              | —                                                                        |
| `identity-kind-mismatch` | **no schema.** It is a plan _finding_ code, never an HTTP code                   | `src/domain/plan-finding.ts:15`, surfaced inside `plan-invalid` findings |

`Finding` is `{ code: FindingCode, path: string | null, id: string | null, message: string }`
(`src/domain/plan-finding.ts:28-33`), and `src/http/contract/graph.ts:33-38` already declares it as
`planFinding`.

`idempotency-mismatch` carries `details` and is **absent from the EPIC's list of ten**. Story 04 includes it,
because a 409 code that emits `details` and declares none is exactly the untypable branch the epic closes.

**One consumer already proves the point.** `src/cli/plan/import.ts:131-137` reads `details.conflicts` through a
hand-written `as` cast — a second authority for the shape, living in the client. Story 04 replaces it with
`choicesChangedDetails.parse(...)`. That single edit is the epic's claim demonstrated inside this repository.

### The list-envelope convention, fixed by code and not by the docs

`docs/proposal/api/` never states a collection envelope. The authored contract does, without exception: a
single key named for the plural of the resource, holding an array of the view.

- `credential.ts:26-28` `{ providers: [...] }`
- `project.ts:23` `{ projects: [...] }`
- `repository.ts:85-87` `{ repositories: [...] }`
- `graph.ts:29-31` `{ revisions: [...] }`, `:97` `{ nodes: [...] }`, `:115` `{ edges: [...] }`

`event.list` therefore answers `{ events: [...] }`. Story 01 follows the convention and invents nothing.

### Test conventions in `src/http/contract/`

- `import { describe, it } from "node:test";` and `import assert from "node:assert/strict";`. Every file
  except `openapi.test.ts`, which uses bare `test` plus `after`.
- The `describe` title is the module path minus the extension, e.g.
  `describe("src/http/contract/registry.test", ...)`.
- Relative imports carry the explicit `.ts` extension.
- Proposal helpers: `readRouteMatrix` and `readErrorCodeMatrix` from `test/helpers/proposal.ts`
  (`parity.test.ts:7`, `errors.test.ts:10`).

### Fixed literals every example and test uses

Determinism forbids a generated timestamp or id. Story 05 declares these in
`src/http/contract/example-literal.ts` and every example imports them.

- Timestamp: `1738368000000` for every `updatedAt`, `createdAt`, `setDefaultAt`, `appliedAt` and `expiresAt`.
- ULID body: `01JQ8Z7G3HZZZZZZZZZZZZZZZZ`, so an id reads `project_01JQ8Z7G3HZZZZZZZZZZZZZZZZ`. Verified against
  `ulidPattern` (`src/domain/identity.ts:45`).
- Id prefixes come from `identityPrefixes` (`src/domain/identity.ts:25-43`). Two are not the kind name:
  `repository` → **`repo`**, `planRevision` → **`revision`**.
- Blob hash: `sha256:` followed by 64 `a` characters.
- Host fingerprint: `SHA256:` followed by 43 `A` characters.
- Object ids: 40 `a` for landing, 40 `b` for tracking, 40 `c` for upstream.

### Query decoding, verified rather than assumed

`z.number()` **rejects** the string `"100"`, and koa hands every query value to a handler as a string. So
`cursorRequest.limit` is `z.coerce.number().int()`, not `z.number().int()`. Probed against the installed zod
4.4.3: `"100"` → `100`, `"501"` / `"0"` / `"1.5"` / `"abc"` → reject, absent → `100`, and the emitted JSON Schema
is still `{ type: "integer", minimum: 1, maximum: 500, default: 100 }`. A repeated parameter arrives as an array
and is rejected by construction.

### Generator behaviour these stories depend on, verified rather than assumed

Probed against the installed zod 4.4.3, target `openapi-3.0`:

- `z.strictObject` emits `additionalProperties: false`. `.extend()` on a strict base stays strict.
- A field with `.default(...)` is **omitted from `required`** under `io: "input"`, and `required` is omitted
  entirely when no field is required. Read it as `enclosing.required ?? []`.
- A nullable field emits `nullable: true`, **not** `type: ["string","null"]`.
- `z.literal("x")` emits `{ type: "string", enum: ["x"] }`; `const` is unavailable in 3.0.
- `z.discriminatedUnion` emits `oneOf`, and `z.record(z.string(), z.unknown())` is representable.
