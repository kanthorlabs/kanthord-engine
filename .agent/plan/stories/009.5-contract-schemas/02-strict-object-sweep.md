# Story 02 — every object schema becomes `z.strictObject`

Epic: `.agent/plan/epics/009.5-contract-schemas.md`
Depends on: Story 01 (`event.list` is authored strict, so the sweep never revisits it).

## Change

### 1. Replace `z.object` with `z.strictObject` at every listed site

Every site below is a plain textual replacement of `z.object(` with `z.strictObject(`. Nested inline objects
are included, and the list is exhaustive.

| file                              | lines                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `src/http/contract/credential.ts` | 10, 16, 26                                                           |
| `src/http/contract/graph.ts`      | 10, 15, 20, 29, 33, 40, 49, 50, 53, 58, 66, 74, 79, 85, 97, 108, 115 |
| `src/http/contract/project.ts`    | 12, 14, 23, 24                                                       |
| `src/http/contract/repository.ts` | 6, 11, 16, 19, 45, 63, 67, 85                                        |
| `src/domain/provider-payload.ts`  | 41 (`llmProjection`), 47 (`gitProjection`)                           |

Leave alone:

- `src/http/contract/system.ts` — all 9 object nodes are already `z.strictObject`.
- `src/http/contract/graph.ts:99` — `nodeListItem.extend({...})` inherits strictness from `:85`.
- `src/http/contract/errors.ts:36-37` — Story 04 replaces that schema outright.
- `src/domain/provider-payload.ts:31` — already `.strict()`.

`src/domain/provider-payload.ts:41,47` are in scope because `credential.ts:20`
(`projection: providerProjection.nullable()`) reaches them, so the registry walk in step 2 sees them.

### 2. New file `src/http/contract/coverage.test.ts` — the registry-walking strictness assertion

Do not read zod internals. Convert each schema through the public generator and walk the JSON Schema.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { registry } from "./registry.ts";
```

Write one local helper:

```ts
function objectNodes(schema: unknown): readonly Record<string, unknown>[];
```

It walks a JSON Schema value recursively and returns every node that is an object with `type === "object"`.
It must recurse through `properties` (every value), `items`, `additionalProperties` when it is an object,
`anyOf`, `oneOf`, `allOf`, `not`, and `$defs`.

The test:

- For every `registry` entry, for each of `entry.query`, `entry.request` and `entry.response` that is defined,
  convert with `z.toJSONSchema(schema, { target: "openapi-3.0", io })` — `io: "input"` for `query` and
  `request`, `io: "output"` for `response`.
- Collect `objectNodes` of each result. Assert the collected list is non-empty across the registry.
- Assert every collected node has `additionalProperties === false`, and name the failing `operationId` and slot
  in the assertion message.

`describe` title: `"src/http/contract/coverage.test"`.

### 3. Fix the tests a strict request schema now rejects

A request schema that rejects an unknown key changes runtime parsing. Any existing test that sends an extra
key to `providerRegisterRequest`, `repositoryInspectRequest`, `repositoryRegisterRequest`,
`projectCreateRequest`, `projectRepositoriesRequest`, `planValidateRequest` or `planImportRequest` now fails.
Run the full suite, and for each failure remove the extra key from the fixture. Do **not** relax a schema to
keep a fixture passing.

`payload: z.unknown()` (`credential.ts:13`) is a field whose _value_ is arbitrary. Strictness on the enclosing
object does not constrain it, so a provider payload fixture needs no change.

## Constraints

- Add no field, remove no field, rename no field, and change no enum in this story.
- Change no `.nullable()` and no `.default(...)`.
- Do not touch `src/http/contract/errors.ts`.
- The generated document changes, because a strict object emits `additionalProperties: false`.
  `src/http/contract/openapi.test.ts` snapshots no bytes, so its assertions still hold — confirm rather than
  edit.

## Verify

- `node --test src/http/contract/coverage.test.ts` — passes. Then revert one site, for example
  `src/http/contract/project.ts:14`, to `z.object` and confirm the suite **fails** naming
  `project.create`/`project.list`/`project.show`/`project.repositories`. Restore it.
- `node --test src/http/contract/openapi.test.ts` — `:242` internal refs, `:261` byte-identical render,
  `:269` `SwaggerParser.validate` and `:205` the 30-component list all pass.
- `node --test src/domain/provider-payload.test.ts` — passes; add one assertion that `llmProjection` and
  `gitProjection` each reject an unknown key.
- `npm test` — the whole suite passes, including every `src/http/server/**` and `src/commands/**` test whose
  fixture the sweep touched.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`.
