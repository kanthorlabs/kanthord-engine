# Story 06c — Generated `openapi.yaml`

Epic: `.agent/plan/epics/004-transport-skeleton.md`
Depends on: Story 06a (`src/http/contract/registry.ts`), Story 05 (`src/http/contract/errors.ts`).

One self-contained OpenAPI 3.0.3 document, generated into a temporary directory, validated, and deleted. It is never committed — `docs/proposal/api/README.md:17`: "the reviewable contract change is already the zod module and the table in this directory."

No human edits the generated file, so its size is not an editing concern. The authored side is ten domain modules under `src/http/contract/`, one per file of `docs/proposal/api/`.

## Change

### 1. `src/http/contract/openapi.ts` (new)

```ts
export function buildOpenApiDocument(): Readonly<Record<string, unknown>>;
export function renderOpenApiYaml(): string;
```

`buildOpenApiDocument` returns one self-contained OpenAPI 3.0.3 document with internal `#/components/…` references only — `docs/proposal/api/README.md:15`.

- `openapi` is `"3.0.3"`. `info` is `{ title: "kanthord", version: KANTHORD_VERSION }`, read from `src/domain/version.ts`.
- `components.securitySchemes.bearerAuth` is `{ type: "http", scheme: "bearer" }`. The document's top-level `security` is `[{ bearerAuth: [] }]`.
- `components.schemas.Error` is `z.toJSONSchema(errorEnvelopeSchema, { target: "openapi-3.0", io: "output" })`.
- `paths` holds one key per distinct `renderOpenApiPath` value, and the keys are inserted in bytewise sorted order.
- Within a path, method keys are inserted in the fixed order `delete`, `get`, `post`, `put`, lowercased.
- Each operation object holds `operationId`, and `parameters` when the path templates one: `{ name, in: "path", required: true, schema: { type: "string" } }`, with `name` from `parameterNames`.
- `system.health` alone carries `security: []`. Every other operation inherits the document default.
- Responses. A `routed` entry emits `"<successStatus ?? 200>": { description: <operationId> }`; a `stubbed` entry emits `"501": { description: "not implemented" }`. Every entry also emits `default: { description: "error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }`. The status key is read from the entry rather than hard-coded, so a create operation documents `201` the day it declares one.
- When an entry carries a `response` schema, its success response gains `content: { "application/json": { schema: <converted> } }` with the schema converted by `z.toJSONSchema(schema, { target: "openapi-3.0", io: "output" })` and registered under `components.schemas["<operationId>.response"]`, referenced by `$ref`. A `request` schema is converted with `io: "input"` under `components.schemas["<operationId>.request"]` and referenced from `requestBody: { required: true, content: { "application/json": { schema: { $ref } } } }`.
- `components.schemas` keys are inserted in bytewise sorted order, after every operation is walked.

`renderOpenApiYaml` returns `YAML.stringify(buildOpenApiDocument(), { lineWidth: 0 })`. Measured: `yaml@2.9.0` with that option emits LF only and exactly one trailing newline, which is the canonical form `docs/proposal/api/README.md:19` requires. `zod@4.4.3` supports `target: "openapi-3.0"` and emits `enum` rather than `const` for a literal, which is what OpenAPI 3.0 accepts.

`node --test src/http/contract/openapi.test.ts` — new file, suite `"src/http/contract/openapi.test"`. The generate-validate-delete cycle lives here rather than in a fourth `npm run verify` step, because `.agent/plan/stories/001-runtime-foundation/09-staged-verify.md:26` fixes `verify` as `typecheck`, `test`, `lint` and nothing else. `npm test` runs this file, so `npm run verify` performs the generation `docs/proposal/api/README.md:19` asks for.

- `buildOpenApiDocument().openapi` is `"3.0.3"`, and `info` deep-equals `{ title: "kanthord", version: KANTHORD_VERSION }`.
- `Object.keys(document.paths)` is bytewise sorted and holds `47` keys. The 53 operations collapse onto 47 distinct paths: `/v1/provider` carries GET and POST, `/v1/provider/{id}` carries GET and DELETE, `/v1/repository` carries GET and POST, `/v1/project` carries GET and POST, and `/v1/repository/{id}/profile` carries GET, POST and PUT — six operations beyond one per path. Assert the count and the sortedness, then assert `paths["/v1/repository/{id}/profile"]` has exactly the keys `["get", "post", "put"]` in that order, and `paths["/v1/provider/{id}"]` exactly `["delete", "get"]`.
- Every operation object across every path has an `operationId`, and the set of those 53 values equals the registry's set.
- The union of `paths` method keys is a subset of `["delete", "get", "post", "put"]`, and within each path the keys appear in that relative order.
- `paths["/v1/health"].get.security` deep-equals `[]`. For every other operation, `Object.hasOwn(operation, "security")` is `false`.
- `paths["/v1/node/{id}/unblock"].post.parameters` deep-equals `[{ name: "id", in: "path", required: true, schema: { type: "string" } }]`, and `paths["/v1/blob/{hash}"].get.parameters[0].name` is `"hash"`.
- `paths["/v1/health"].get.responses` has key `"200"`; `paths["/v1/node/{id}/unblock"].post.responses` has key `"501"` and no `"200"`. Every operation's `responses` has a `default` key.
- `Object.keys(document.components.schemas)` is bytewise sorted and contains `"Error"`.
- Every `$ref` string anywhere in the document starts with `"#/components/schemas/"`. Walk the document recursively and collect them; assert the collected list is non-empty and that each referenced key exists in `components.schemas`.
- The rendered YAML is canonical: `renderOpenApiYaml()` contains no `"\r"`, ends with exactly one `"\n"`, and `renderOpenApiYaml() === renderOpenApiYaml()` byte for byte across two calls.
- The document validates, and the file is deleted. Write `renderOpenApiYaml()` into `fs.mkdtempSync(path.join(os.tmpdir(), "kanthord-openapi-"))` as `openapi.yaml`, `await SwaggerParser.validate(filePath)` without a throw, then `fs.rmSync(dir, { recursive: true, force: true })` in an `after()` registered right after the `mkdtempSync`. Assert `fs.existsSync(dir)` is `false` in a following case is **not** required; the `after` hook is the deletion and the epic asks for nothing observable afterwards.
- `openapi.yaml` is never committed: assert `fs.existsSync(path.join(repositoryRoot, "openapi.yaml"))` is `false`, where `repositoryRoot` is resolved from `import.meta.url`.
- The validator is proved to reject, so a green run means something. Two synthetic cases, each written into the same temporary directory and each asserting `SwaggerParser.validate` rejects: a copy of the document whose `info.version` key is deleted, and a copy whose `paths["/v1/health"].get.responses.default.content["application/json"].schema.$ref` is set to `"#/components/schemas/missing"`. Assert only that each rejects — `assert.rejects` with no message matcher. The message wording is a property of the installed validator version and asserting a fragment of it would break on a patch bump while proving nothing extra.
- `"200"` is not assumed for every routed operation. Assert that for each `routed` entry, the non-`default` response key equals `String(entry.successStatus ?? 200)`, and that no entry currently declares `successStatus` — so this assertion starts as "all 200" and stays correct when a create operation declares `201`.

### 2. `package.json` — one devDependency

Add `"@apidevtools/swagger-parser": "12.1.0"` to `devDependencies`, keeping the block alphabetically sorted, so it lands between `@types/supertest` and `eslint`. Run `npm install` so `package-lock.json` records the tree, and commit both files — a lock file that does not name the dependency fails a clean `npm ci`. It is the independent OpenAPI validator of `docs/proposal/api/README.md:19`. Its `validate` both checks the document against the OpenAPI schema and dereferences it, which is the two assertions the epic needs from one call. Import it as `import SwaggerParser from "@apidevtools/swagger-parser";` — the package's only usable export is the default, and `validate` and `dereference` are static members on it.

Do not add a generation dependency. `zod@4.4.3` already emits OpenAPI-3.0 schemas through `z.toJSONSchema(schema, { target: "openapi-3.0" })`.

Do not add `@apidevtools/swagger-parser` to `eslint.config.js`'s `vendorPackages`. It is imported only by a test, and `src/**` never names it. Instead add one assertion to `src/http/contract/openapi.test.ts`: reading every `src/**/*.ts` that is not a `.test.ts` and asserting none contains the string `"@apidevtools/swagger-parser"`.

## Constraints

- `src/http/contract/openapi.ts` writes no file and imports no `node:fs`. It returns a document and a string; the test owns the temporary directory.
- Internal `#/components/…` references only. An external `$ref` split is refused by `docs/proposal/api/README.md:15`, and a self-contained document is what a consumer bundles to anyway.
- Never commit `openapi.yaml`, and never add it to the repository root or to `.gitignore` as if it were expected there.
- Generation is canonical: fixed path, method and component order, LF endings, one trailing newline.

## Verify

Every assertion listed in section 1 above, in `src/http/contract/openapi.test.ts` — one suite named `"src/http/contract/openapi.test"`.

`npm run verify` exits 0.

Proof: contributes `src/http/contract/openapi.test.ts` to `node --test src/http/**/*.test.ts`.
