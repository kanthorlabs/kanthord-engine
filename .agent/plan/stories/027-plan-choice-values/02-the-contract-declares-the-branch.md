# Story 2 — The contract declares the branch

Epic: `.agent/plan/epics/027-plan-choice-values.md`
Depends on: Story 1.

**Coupled with Story 3. Run no gate between them.** This story declares a required `values` member; Story 3 is what produces it. Between the two, `src/http/server/plan/validate-plan.test.ts` is red at **both** of its `planValidateResponse.safeParse` assertions — line 140 and line 172 — because the query does not carry `values` yet. That is expected. Run the Verify block of this story, then go straight to Story 3, then run the full gate once.

## Change

### `src/http/contract/graph.ts`

`blobHash` is already imported at line 25. Add no import.

Insert these three schemas immediately before `planChoiceEntry` at line 64:

```ts
export const planChoiceBody = z.strictObject({
  instructionBlob: blobHash,
  acceptanceBlob: blobHash.nullable(),
});

export const planChoiceValues = z.strictObject({
  body: planChoiceBody.optional(),
  depends_on: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(),
  repo: z.string().nullable().optional(),
  title: z.string().optional(),
  worker: z.string().nullable().optional(),
});

export const planChoiceBranch = z.strictObject({
  legal: z.boolean(),
  reason: z.string().nullable(),
  values: planChoiceValues,
});
```

Then replace `planChoiceEntry` at lines 64-79 in full. The two inline branch objects at lines 71-74 and 75-78 become `planChoiceBranch`, and `path` is added between `fields` and `submitted`:

```ts
export const planChoiceEntry = z.strictObject({
  id: z.string(),
  kind: z.enum(nodeKinds),
  presence: z.enum(presences),
  state: z.enum(nodeStates).nullable(),
  suggested: z.enum(choices),
  fields: z.array(z.enum(differingFields)),
  path: z.string().nullable(),
  submitted: planChoiceBranch,
  database: planChoiceBranch,
});
```

- `values` is **required** on the branch. It is not `.optional()`. An entry with a branch of `{ legal, reason }` and no `values` must be refused.
- Every member of `planChoiceValues` is `.optional()`, so `values: {}` parses. `planChoiceValues` is a `z.strictObject`, so an unknown key is refused.
- `depends_on` keeps its underscore. Do not rename it to `dependsOn`.
- `path` goes at that exact position, after `fields` and before `submitted`.
- Change `planValidateRequest` (lines 81-84), `planValidateResponse` (lines 86-92), `planDocument` (lines 40-43) and `planImportRequest` (lines 94-107) in no way.

### `src/http/contract/graph.ts` — the example

`planValidateExamples.success.choices` is `[]` at **line 283**. Replace that one line with exactly one entry. `U` is `EXAMPLE_ULID`, already imported at line 19, and `planDocument_example.path` at line 272 is `initiative/atlas.md`:

```ts
    choices: [
      {
        id: `task_${U}`,
        kind: "task",
        presence: "both",
        state: "ready",
        suggested: "submitted",
        fields: ["title"],
        path: "initiative/atlas.md",
        submitted: {
          legal: true,
          reason: null,
          values: { title: "add the health route" },
        },
        database: {
          legal: true,
          reason: null,
          values: { title: "add the health check" },
        },
      },
    ],
```

The `path` value is `planDocument_example.path`, and `planValidateExamples.success.documents` is `[planDocument_example]` at line 280, so the published example satisfies the join rule of D2 by construction: the one entry's `path` names the one document. Do not invent a second path. The example's document set stands in for the normalized set, so its `path` is a canonical path by definition — keep `planDocument_example` unchanged, because `planImportExamples` and `planExportExamples` share it.

**Leave `planImportExamples` unchanged.** Its `choices: []` at **line 308** is the request shape, `{ id, take }`, which this epic does not touch.

### `src/http/contract/field-decisions.fixture.ts`

Regenerate, never hand-edit:

```bash
node scripts/field-decisions-probe.mjs --write
```

Then re-run with no flag; it must print `fixture in sync`.

The regenerated file gains exactly **19** rows and loses none. One for `path`, and nine per branch. The `path` row lands between the `kind` row (line 326 before this story) and the `presence` row (line 327), because the file is sorted bytewise and `path` falls between `kind` and `presence`:

```
  "plan.validate.response#/properties/choices/items/properties/path required=true nullable=true enum=-",
```

`nullable=true`, because `path` is `z.string().nullable()`. The `state` row at line 328 is the precedent: `z.enum(nodeStates).nullable()` emits `required=true nullable=true`.

The nine rows per branch, shown for `database` — the `submitted` set is identical with `submitted` substituted for `database`:

```
  "plan.validate.response#/properties/choices/items/properties/database/properties/values required=true nullable=false enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/body required=false nullable=false enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/body/properties/acceptanceBlob required=true nullable=true enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/body/properties/instructionBlob required=true nullable=false enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/depends_on required=false nullable=false enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/parent required=false nullable=true enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/repo required=false nullable=true enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/title required=false nullable=false enum=-",
  "plan.validate.response#/properties/choices/items/properties/database/properties/values/properties/worker required=false nullable=true enum=-",
```

`instructionBlob` and `acceptanceBlob` are `required=true` because they are required **inside** `planChoiceBody`; `body` itself is `required=false` because it is `.optional()` inside `planChoiceValues`.

> **The probe is authoritative, not this list.** The row set above is what the schema above must produce. If the probe writes a different set, do not hand-edit the fixture to match this story and do not adjust the schema to match the list — stop and report the difference, because the schema and the expected wire shape then disagree and that is a decision. `src/http/contract/coverage.test.ts:314` is the gate, and it compares the fixture to the live walk with `assert.deepEqual`.

### `src/http/contract/coverage.test.ts`

No edit. `operationAdditions` at line 30 lists error codes, not property names, and the field walk is generic. It passes because the fixture was regenerated.

### `src/http/contract/openapi.test.ts`

No edit. The schema-component list at lines 280-294 names top-level request, response and error slots only. `planChoiceBody`, `planChoiceValues` and `planChoiceBranch` are composition helpers referenced from inside `planChoiceEntry`, so they inline and add no `components.schemas` key. If the list test fails, a new top-level schema was registered by mistake — stop and report it.

## Constraints

- Add no operation, no route, no `operationId` and no status change. `src/http/contract/parity.test.ts` reads the proposal route matrix only and must stay untouched and passing.
- Do not edit `src/queries/**`, `src/domain/**`, `src/http/server/**` or any document. Story 3 owns the query and Story 4 owns the proposal.
- Do not make `values` optional to keep the server test green. The red between this story and Story 3 is intended.
- Do not add `values` to `planImportRequest.choices`.
- `blobHash` is `/^sha256:[0-9a-f]{64}$/`. Every hash literal in a test must be 64 lowercase hex characters after the prefix.
- Add no comment.

## Verify

### `src/http/contract/graph.test.ts`

The file today imports nine schemas at lines 4-14 and does not mention `planChoiceEntry` or `planValidateExamples`. Extend the import from `./graph.ts` with `planChoiceEntry`, `planChoiceValues`, `planValidateResponse` and `planValidateExamples`, keeping the existing members and the existing alphabetical grouping.

Add these tests inside the existing `describe("src/http/contract/graph.test", …)` block. All thirteen existing tests stay and stay passing, unmodified.

Use this valid entry as the base fixture, defined beside the other fixtures in the file:

```ts
const choiceEntry = {
  id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  kind: "task",
  presence: "both",
  state: "ready",
  suggested: "submitted",
  fields: ["title"],
  path: "initiative/atlas.md",
  submitted: { legal: true, reason: null, values: { title: "a" } },
  database: { legal: true, reason: null, values: { title: "b" } },
};
```

**`values` is required.**

- `planChoiceEntry.safeParse(choiceEntry).success` is `true`.
- The pre-epic entry is refused. With both branches replaced by `{ legal: true, reason: null }` and no `values`, `planChoiceEntry.safeParse(...).success` is `false`.
- A branch missing only `values` is refused: `submitted` as `{ legal: true, reason: null }` while `database` keeps its `values`, and `success` is `false`.

**`values` is closed and typed.**

- `planChoiceValues.safeParse({}).success` is `true`.
- `planChoiceValues.safeParse({ title: 1 }).success` is `false`.
- `planChoiceValues.safeParse({ unknown: "x" }).success` is `false`.
- `planChoiceValues.safeParse({ dependsOn: [] }).success` is `false` — the camelCase spelling is not the member name.
- `planChoiceValues.safeParse({ depends_on: ["task_a", "task_b"] }).success` is `true`.
- `planChoiceValues.safeParse({ parent: null, repo: null, worker: null }).success` is `true` — the three nullable names accept `null`.
- `planChoiceValues.safeParse({ title: null }).success` is `false` — `title` is not nullable.
- All six names together parse:

```ts
assert.equal(
  planChoiceValues.safeParse({
    body: {
      instructionBlob: `sha256:${"a".repeat(64)}`,
      acceptanceBlob: null,
    },
    depends_on: ["task_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    parent: null,
    repo: null,
    title: "a",
    worker: null,
  }).success,
  true,
);
```

**`body` is a pair of blob hashes.**

- `planChoiceValues.safeParse({ body: { instructionBlob: "sha256:" + "a".repeat(64), acceptanceBlob: "sha256:" + "b".repeat(64) } }).success` is `true`.
- `acceptanceBlob` of `null` parses; `instructionBlob` of `null` is refused.
- `planChoiceValues.safeParse({ body: { instructionBlob: "not-a-hash", acceptanceBlob: null } }).success` is `false`.
- A `body` missing `instructionBlob` is refused.
- `planChoiceValues.safeParse({ body: { instructionBlob: "sha256:" + "A".repeat(64), acceptanceBlob: null } }).success` is `false` — uppercase hex is refused by `blobHash`.
- A `body` with a third key is refused.

**`path` is required and nullable.**

- `path` of `null` parses.
- An entry with `path` omitted is refused.
- `path` of `1` is refused.

**The published example is asserted, not only present.**

```ts
it("the plan.validate example carries one both entry whose values name the two titles", () => {
  const parsed = planValidateResponse.parse(planValidateExamples.success);
  assert.equal(parsed.choices.length, 1);
  const entry = parsed.choices[0]!;
  assert.equal(entry.presence, "both");
  assert.deepEqual(entry.fields, ["title"]);
  assert.deepEqual(Object.keys(entry.submitted.values), ["title"]);
  assert.deepEqual(Object.keys(entry.database.values), ["title"]);
  assert.equal(entry.submitted.values.title, "add the health route");
  assert.equal(entry.database.values.title, "add the health check");
  assert.notEqual(entry.submitted.values.title, entry.database.values.title);
});
```

- And the join holds in the published example:

```ts
it("the plan.validate example joins its choice path to one document", () => {
  const parsed = planValidateResponse.parse(planValidateExamples.success);
  const entry = parsed.choices[0]!;
  assert.equal(entry.path, "initiative/atlas.md");
  assert.equal(
    parsed.documents.filter((document) => document.path === entry.path).length,
    1,
  );
});
```

### Commands

```bash
node --test src/http/contract/graph.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/parity.test.ts
node scripts/field-decisions-probe.mjs
npm run typecheck
npm run lint
```

Assertions:

- `graph.test.ts` passes, with the thirteen pre-existing tests unmodified.
- `coverage.test.ts` passes with no edit to the file.
- `example.test.ts` passes. `plan.validate` is in its covered list at line 38, so the new example entry is parsed against `planValidateResponse` by this test.
- `openapi.test.ts` and `parity.test.ts` pass with no edit.
- `node scripts/field-decisions-probe.mjs` prints `fixture in sync` and exits 0.
- The fixture grew by exactly 19 rows:

```bash
test "$(( $(grep -c '"' src/http/contract/field-decisions.fixture.ts) - $(git show HEAD:src/http/contract/field-decisions.fixture.ts | grep -c '"') ))" -eq 19 \
  && echo "PASS 19 new rows"
```

- Every one of the 19 rows listed in the Change section is present, checked with `grep -Fq`.
- **`npm run verify` is expected to FAIL at `src/http/server/plan/validate-plan.test.ts` and nowhere else.** Confirm the failure is that one file and that its cause is the `planValidateResponse.safeParse` assertion at line 140:

```bash
node --test src/http/server/plan/validate-plan.test.ts; echo "exit=$?"
```

`exit=1` here is the expected state of the coupled pair, and the failures are the two `planValidateResponse.safeParse` assertions at lines 140 and 172. If any other test file fails, stop and report it. Do not run the full gate until Story 3 lands.

Proof: the `src/http/contract/graph.test.ts`, `src/http/contract/coverage.test.ts`, `src/http/contract/example.test.ts`, `src/http/contract/openapi.test.ts` and `src/http/contract/parity.test.ts` lines of the `PASS EPIC-027` block, and Hermetic coverage bullets 12 (the `safeParse` refusals) and 14 (the published example). The `PASS EPIC-027` marker cannot print until Story 3 lands, so this story's evidence is the Verify assertions above.
