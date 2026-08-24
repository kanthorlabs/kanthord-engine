# Story 03 — the four decisions each field carries, and every enum from `domain/`

Epic: `.agents/plan/epics/009.5-contract-schemas.md`
Depends on: Story 02 (the audit pins fields on schemas that are already strict).

Every field answers four questions explicitly: required or optional; absent or explicitly `null`; a closed
enum or an open string; and the shape per error code. The fourth is Story 04. This story delivers the first
three, and it changes no field.

## Change

### 1. Export the missing arrays from `domain/`

`src/domain/plan-choice.ts` — add after the existing `structuralFields` at `:10-15`:

```ts
export const presences = ["both", "document-only", "database-only"] as const;
export const differingFields = [
  "body",
  "depends_on",
  "parent",
  "repo",
  "title",
  "worker",
] as const;
```

`differingFields` is the bytewise-sorted union of `proseFields` (`:9`) and `structuralFields` (`:10-15`), which
is exactly the order `src/http/contract/graph.ts:47` restates today. Retype `Presence` (`:17`) and
`DifferingField` (`:6-7`) as `(typeof presences)[number]` and `(typeof differingFields)[number]` so one
declaration carries both the type and the runtime array.

`src/domain/repository.ts` — add above the schema that holds `:17`:

```ts
export const repositoryStates = ["ready", "needs-reconcile"] as const;
```

Replace `:17` with `state: z.enum(repositoryStates),`.

`src/domain/health.ts` — add:

```ts
export const healthStatuses = ["ok", "degraded"] as const;
export const dependencyStatuses = ["ok", "failed", "not-implemented"] as const;
```

Retype `DependencyStatus` (`:1`) as `(typeof dependencyStatuses)[number]`, and the `status` field at `:9` as
`(typeof healthStatuses)[number]`.

`src/domain/lease.ts` — add above the schema that holds `:7`:

```ts
export const leaseSubjectKinds = ["node", "repository"] as const;
```

Replace `:7` with `subjectKind: z.enum(leaseSubjectKinds),`.

### 2. Replace every restated literal in the contract with the imported array

| site               | current                                                          | becomes                     |
| ------------------ | ---------------------------------------------------------------- | --------------------------- |
| `graph.ts:43`      | `z.enum(["both","document-only","database-only"])`               | `z.enum(presences)`         |
| `graph.ts:47`      | `z.enum(["body","depends_on","parent","repo","title","worker"])` | `z.enum(differingFields)`   |
| `graph.ts:61`      | `z.string().regex(/^sha256:[0-9a-f]{64}$/)`                      | `blobHash`                  |
| `graph.ts:76`      | `z.string().regex(/^sha256:[0-9a-f]{64}$/)`                      | `blobHash`                  |
| `repository.ts:74` | `z.enum(["ready","needs-reconcile"])`                            | `z.enum(repositoryStates)`  |
| `system.ts:10`     | `z.enum(["ok","degraded"])`                                      | `z.enum(healthStatuses)`    |
| `system.ts:34`     | `z.enum(["ok","degraded"])`                                      | `z.enum(healthStatuses)`    |
| `system.ts:59`     | `z.enum(["node","repository"])`                                  | `z.enum(leaseSubjectKinds)` |

`blobHash` is already imported in `graph.ts` from `src/domain/blob.ts:5` and used at `:24-26`, `:100`, `:101`.
Add imports for `presences` and `differingFields` to the existing `plan-choice.ts` import in `graph.ts`, for
`repositoryStates` to `repository.ts`, and for `healthStatuses`, `dependencyStatuses` and `leaseSubjectKinds`
to `system.ts`.

### 3. Delete the contract-local `dependencyStatuses`

`src/http/contract/system.ts:7` declares `const dependencyStatuses = [...] as const;`. Remove the declaration
and import the array from `src/domain/health.ts` instead. `system.ts:14` and `:38` keep reading
`z.enum(dependencyStatuses)` unchanged.

`event.ts` needs no change here. Story 01 already exported `actorKinds` from `src/domain/event.ts`.

### 4. Prove enum **provenance**, not enum spelling

A regex that rejects `z.enum([...])` is bypassable: a contract-local `const localStates = ["ready",
"needs-reconcile"] as const;` followed by `z.enum(localStates)` is still a restatement and still passes the
regex. `src/http/contract/system.ts:7` is exactly that bypass in the tree today, which is why step 3 deletes
it. The assertion must therefore prove the array came from `domain/`.

Add to `src/http/contract/coverage.test.ts`. Read every non-test `.ts` file under `src/http/contract/` with
`readdirSync` plus `readFileSync`, bytewise sorted by name, and assert all three:

1. **No inline literal.** No file matches `/z\.enum\(\s*\[/`.
2. **No restated blob-hash pattern.** No file matches `/z\.string\(\)\.regex\(\s*\/\^sha256:/`.
3. **Every `z.enum` argument is imported from `domain/`.** For each file, collect every identifier `X` matched
   by `/z\.enum\(\s*([A-Za-z_$][\w$]*)\s*\)/g`. For each `X`, assert the same file contains an import of `X`
   from a path matching `/^\.\.\/\.\.\/domain\//`. Parse the imports by matching
   `/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g` and splitting the brace list on commas, trimming each name and
   stripping an `as` alias to its local name. Assert additionally that no file declares an `as const` array
   that a `z.enum` then consumes — that is, no `X` collected above also matches
   `new RegExp("(const|let|var)\\s+" + X + "\\s*=")` in the same file.

Name the file and the identifier in every assertion message. `cursor.ts` declares no enum and is unaffected.

The same rule covers the prebuilt schemas `nodeKind`, `nodeState` and `blockReason` (`system.ts:43-45`): they
are not `z.enum(...)` call sites, so step 3 of this list does not reach them. Add a fourth assertion that
`system.ts` imports them from `../../domain/state.ts`, which it already does at `:3`.

### 5. Add the recursive field-decision fixture to `src/http/contract/coverage.test.ts`

The audit must reach **every** field, not only a top-level property. A top-level-only table would miss
`planFinding` inside `planValidateResponse.findings`, `planChoiceEntry.submitted.reason`,
`repositoryView.credential.name`, `providerView.projection`'s union members and every list element in the
contract — and the EPIC requires each field to answer all four questions.

**Mechanism.** Normalise each schema's JSON Schema into a flat, sorted list of one row per field, keyed by JSON
pointer.

```
<operationId>.<slot>#/properties/actorKind  required=false nullable=true enum=[human,daemon]
<operationId>.<slot>#/properties/events/items/properties/id  required=true nullable=false enum=-
```

Write one local helper in the test file:

```ts
function fieldRows(label: string, schema: unknown): readonly string[];
```

It walks the JSON Schema recursively, following `properties` (each value, keys visited in bytewise order),
`items`, `additionalProperties` when it is an object, and `anyOf` / `oneOf` / `allOf` (index-suffixed, e.g.
`#/oneOf/0/properties/...`). For every node reached through a `properties` key it emits one row:

- the pointer, prefixed by `<operationId>.<slot>`;
- `required=` — whether the property name appears in the **enclosing** object's `required` array. Read it as
  `enclosing.required ?? []`, because `z.toJSONSchema` **omits** `required` entirely when no property is
  required, which the installed zod 4.4.3 does for `eventListRequest` under `io: "input"` since every field
  carries a default;
- `nullable=` — whether the node carries `nullable: true`. Target `openapi-3.0` emits `nullable: true`, not
  `type: ["string","null"]`, so read that key and no other;
- `enum=` — the node's `enum` array joined by `,`, or `-` when the node declares none. Absence is the record
  that the field is an open string.

Rows are collected across all 22 operations and all three slots, then sorted bytewise, then asserted against
the expected fixture with one `assert.deepEqual`.

**Where the fixture comes from — this is a planning step, not a build-time derivation.** The implementing agent
must not hand-transcribe several hundred rows; it would transpose values and still author a passing test. So:

1. The agent writes `fieldRows`, prints the produced list, and writes it verbatim into
   `src/http/contract/field-decisions.fixture.ts` as an exported `readonly string[]`, sorted bytewise.
2. The agent then makes exactly one assertion in `coverage.test.ts`: the freshly computed list deep-equals the
   fixture.
3. **The fixture is the review artifact.** The `/work` cycle must stop after step 1 and surface the generated
   fixture in the discussion file for the human to read before the story closes. A row the human does not
   accept is a schema finding for a later epic, not an edit here — this story changes no field.

That keeps the test mechanical and puts the judgement where it belongs. The fixture also becomes the regression
guard: any later change to any field, at any depth, fails one `deepEqual` and names the pointer.

## Constraints

- **Change no field.** Add none, remove none, rename none. Change no `.optional()`, `.nullable()`,
  `.nullish()` or `.default(...)`. The epic's non-goal forbids it, and the table in step 5 must therefore
  record what already exists.
- Every replaced enum must produce the identical value list in the identical order, so the generated document
  is unchanged by step 2. `openapi.test.ts:261` byte-identical render still holds within a run.
- `graph.ts:43` and `graph.ts:47` keep their exact current value order. `presences` and `differingFields` are
  declared in that order for that reason.
- Do not widen or narrow `subjectKind` or `subject` on `eventListRequest`. They are open strings on purpose.
- Do not touch `src/http/contract/errors.ts`.

## Verify

- `node --test src/http/contract/coverage.test.ts` — passes. Then, one at a time, restoring after each:
  - restore `graph.ts:43` to the inline literal → the step-4 no-inline-literal assertion fails;
  - restore `graph.ts:61` to the inline regex → the blob-hash assertion fails;
  - add `const localStates = ["ready","needs-reconcile"] as const;` to `repository.ts` and point `:74` at it →
    the step-4 provenance assertion fails. This is the bypass a plain regex misses, so it is the negative
    control that matters most;
  - delete one row from `field-decisions.fixture.ts` → the step-5 `deepEqual` fails naming the pointer;
  - change one nested field, for example make `planFinding.message` nullable → the step-5 fixture fails at
    `#/properties/findings/items/properties/message`, proving the audit reaches nested fields. Revert.
- `node --test src/http/contract/graph.test.ts` and `node --test src/http/contract/system.test.ts` — pass
  unchanged.
- `node --test src/domain/plan-choice.test.ts`, `node --test src/domain/repository.test.ts`,
  `node --test src/domain/lease.test.ts` — pass; add one assertion per new array pinning its exact values in
  order.
- **The document is unchanged by step 2, proved against a captured baseline.** `openapi.test.ts:261` compares
  two renders _after_ the edit, so it proves self-consistency and not equality with the pre-edit document.
  Before making any step-2 edit, capture the baseline:

  ```bash
  node -e 'import("./src/http/contract/openapi.ts").then((m) => process.stdout.write(m.renderOpenApiYaml()))' \
    > "$TMPDIR/openapi-before-03.yaml"
  ```

  After step 2, run the same command into `openapi-after-03.yaml` and assert `cmp` reports no difference. This
  is the real proof that replacing eight restated enums with imported arrays changed no emitted value. Delete
  both files afterwards; neither enters the tree.

- `node --test src/http/contract/openapi.test.ts` — `:205` the 30-component list and `:261` the byte-identical
  render pass unchanged.
- `npm test` — the whole suite passes.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`.
