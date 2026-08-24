# Story 1 — The domain projects the choice values

Epic: `.agents/plan/epics/027-plan-choice-values.md`

Domain only. No file outside `src/domain/plan-diff.ts` and `src/domain/plan-diff.test.ts` changes.

## Change

### `src/domain/plan-diff.ts`

The file today exports exactly one symbol, the function `differingFields` (lines 6-39), and holds two private helpers, `normalized` (lines 41-50) and `equalIdentities` (lines 52-58). Keep all three byte-identical. Add two types and two functions.

**Add no import.** The four existing imports at lines 1-4 already supply `DifferingField`, `StoredNode`, `ResolvedDocument` and `comparePaths`.

> **Do not import the `differingFields` array from `./node-write-legality.ts`.** This module already exports a _function_ of that name at line 6, so the array could only enter under an alias. An alias is technically possible and is still refused here: the six names are written as six literal `if` statements, because each one reads a _different_ pair of properties and no loop over the array can express that mapping. The array would be imported only to be iterated for its order, and the source order of the six blocks already fixes the order. The drift risk this creates is closed by the last test of this story, which pins the produced key order against the exported array.

Append these two types after the existing imports and before `differingFields` at line 6:

```ts
export type ChoiceBody = Readonly<{
  instructionBlob: string;
  acceptanceBlob: string | null;
}>;

export type ChoiceValues = Readonly<{
  body?: ChoiceBody;
  depends_on?: readonly string[];
  parent?: string | null;
  repo?: string | null;
  title?: string;
  worker?: string | null;
}>;
```

Append these three functions at the end of the file, after `equalIdentities`:

```ts
function selects(
  fields: readonly DifferingField[] | null,
  name: DifferingField,
): boolean {
  return fields === null || fields.includes(name);
}

export function storedValues(
  stored: StoredNode,
  fields: readonly DifferingField[] | null,
): ChoiceValues {
  const values: {
    body?: ChoiceBody;
    depends_on?: readonly string[];
    parent?: string | null;
    repo?: string | null;
    title?: string;
    worker?: string | null;
  } = {};
  if (selects(fields, "body")) {
    values.body = {
      instructionBlob: stored.instructionBlob,
      acceptanceBlob: stored.acceptanceBlob,
    };
  }
  if (selects(fields, "depends_on")) {
    values.depends_on = normalized(stored.dependencies);
  }
  if (selects(fields, "parent")) {
    values.parent = stored.parentId;
  }
  if (selects(fields, "repo")) {
    values.repo = stored.repositoryId;
  }
  if (selects(fields, "title")) {
    values.title = stored.title;
  }
  if (selects(fields, "worker")) {
    values.worker = stored.worker;
  }
  return values;
}

export function submittedValues(
  submitted: ResolvedDocument,
  blobs: Readonly<{ instruction: string; acceptance: string | null }>,
  fields: readonly DifferingField[] | null,
): ChoiceValues {
  const values: {
    body?: ChoiceBody;
    depends_on?: readonly string[];
    parent?: string | null;
    repo?: string | null;
    title?: string;
    worker?: string | null;
  } = {};
  if (selects(fields, "body")) {
    values.body = {
      instructionBlob: blobs.instruction,
      acceptanceBlob: blobs.acceptance,
    };
  }
  if (selects(fields, "depends_on")) {
    values.depends_on = normalized(submitted.dependencies);
  }
  if (selects(fields, "parent")) {
    values.parent = submitted.parentIdentity;
  }
  if (selects(fields, "repo")) {
    values.repo = submitted.repo;
  }
  if (selects(fields, "title")) {
    values.title = submitted.title;
  }
  if (selects(fields, "worker")) {
    values.worker = submitted.worker;
  }
  return values;
}
```

**The property mapping is not symmetric, and these are the exact source properties.** They are the same ones `differingFields` compares at lines 12-37, so a mismatch here is a defect:

| name         | `storedValues` reads                              | `submittedValues` reads                 |
| ------------ | ------------------------------------------------- | --------------------------------------- |
| `body`       | `stored.instructionBlob`, `stored.acceptanceBlob` | `blobs.instruction`, `blobs.acceptance` |
| `depends_on` | `normalized(stored.dependencies)`                 | `normalized(submitted.dependencies)`    |
| `parent`     | `stored.parentId`                                 | `submitted.parentIdentity`              |
| `repo`       | `stored.repositoryId`                             | `submitted.repo`                        |
| `title`      | `stored.title`                                    | `submitted.title`                       |
| `worker`     | `stored.worker`                                   | `submitted.worker`                      |

`submittedValues` reads `submitted.dependencies`, never `submitted.dependsOn`. `dependsOn` is the raw frontmatter list on `ParsedDocument` (`src/domain/plan-document.ts:43`); `dependencies` is the resolved identity list (`src/domain/plan-identity.ts:18`) and it is the one `differingFields` compares at line 24.

`submittedValues` reads the hashes from its `blobs` argument and never from `submitted.instruction` or `submitted.acceptance`. Those two are plain text and this module does not hash.

## Constraints

- **Key order is the source order of the six `if` blocks: `body`, `depends_on`, `parent`, `repo`, `title`, `worker`.** It is independent of the order of the `fields` argument. Never iterate the `fields` argument to build the record.
- `fields === null` selects all six names. A `fields` of `[]` selects none and returns `{}`. Both functions are total; neither returns `{}` for any other reason.
- Neither function takes `presence`. Neither can return the empty branch for a missing side, because each requires its node or its document. The `{}` of the presence table comes from the caller, and Story 3 owns it.
- `depends_on` publishes the **normalized** list — `normalized` sorts by `comparePaths` and drops adjacent duplicates. Never publish the raw `dependencies` array.
- `normalized` and `equalIdentities` stay private. Do not export them.
- `differingFields` (lines 6-39) changes by not one byte. Its signature, its push order and its `[...fields].sort(comparePaths)` return stay exactly as they are.
- Do not touch `src/domain/plan-choice.ts`. `choiceVerdict` is out of scope for every story of this epic.
- Add no comment. The project forbids them.

## Verify

### `src/domain/plan-diff.test.ts`

Amend the import at line 4 to add the two new functions:

```ts
import { differingFields, storedValues, submittedValues } from "./plan-diff.ts";
```

Add `import type { ChoiceValues } from "./plan-diff.ts";` only if a test annotates one; it is not required.

The file already supplies every fixture these tests need. Reuse them exactly and add no new builder:

- `stored(overrides)` at lines 51-53 and `submitted(overrides)` at lines 55-59;
- `instructionHash` = `sha256:` followed by 64 `a` characters (line 13) and `acceptanceHash` = `sha256:` followed by 64 `b` characters (line 14);
- `taskIdentity`, `objectiveIdentity`, `otherTaskIdentity`, `otherObjectiveIdentity` at lines 8-11;
- `sameBlobs()` at lines 61-66, which returns `{ instruction: instructionHash, acceptance: acceptanceHash }`.

Add two constants for the third and fourth hashes, beside line 14:

```ts
const otherInstructionHash = `sha256:${"c".repeat(64)}`;
const otherAcceptanceHash = `sha256:${"d".repeat(64)}`;
```

Add these tests inside the existing `describe("src/domain/plan-diff.test", …)` block at line 68. Every one of the thirteen existing tests stays and stays passing, unmodified.

**`storedValues` — the selected names.**

- `storedValues(stored(), ["title"])` deep-equals `{ title: "Render the manifest" }`. Exactly one key.
- `storedValues(stored(), [])` deep-equals `{}`.
- `storedValues(stored(), null)` deep-equals, exactly:

```ts
{
  body: { instructionBlob: instructionHash, acceptanceBlob: acceptanceHash },
  depends_on: [otherTaskIdentity],
  parent: objectiveIdentity,
  repo: null,
  title: "Render the manifest",
  worker: null,
}
```

- `storedValues(stored({ acceptanceBlob: null }), ["body"]).body` deep-equals `{ instructionBlob: instructionHash, acceptanceBlob: null }`. A stored node with no acceptance publishes `null`, not an absent key.
- `storedValues(stored({ worker: null, repositoryId: null, parentId: null }), null)` has `worker`, `repo` and `parent` all present and all `null`. Assert with `Object.hasOwn` on each of the three, then assert each value is `null`. This is the absent-versus-`null` distinction, and `deepEqual` alone does not prove it.
- `storedValues(stored(), ["worker"])` — `Object.hasOwn(result, "worker")` is `true` and `Object.hasOwn(result, "title")` is `false`.
- `storedValues` maps `parent` from `parentId` and `repo` from `repositoryId`: `storedValues(stored({ parentId: otherObjectiveIdentity, repositoryId: "repository_a" }), ["parent", "repo"])` deep-equals `{ parent: otherObjectiveIdentity, repo: "repository_a" }`.

**`submittedValues` — the selected names.**

- `submittedValues(submitted(), sameBlobs(), ["title"])` deep-equals `{ title: "Render the manifest" }`.
- `submittedValues(submitted(), sameBlobs(), [])` deep-equals `{}`.
- `submittedValues(submitted(), sameBlobs(), null)` deep-equals, exactly:

```ts
{
  body: { instructionBlob: instructionHash, acceptanceBlob: acceptanceHash },
  depends_on: [otherTaskIdentity],
  parent: objectiveIdentity,
  repo: null,
  title: "Render the manifest",
  worker: null,
}
```

- `submittedValues(submitted(), { instruction: otherInstructionHash, acceptance: null }, ["body"]).body` deep-equals `{ instructionBlob: otherInstructionHash, acceptanceBlob: null }`. The value comes from the `blobs` argument.
- `submittedValues` maps `parent` from `parentIdentity` and `repo` from `repo`: `submittedValues(submitted({ parentIdentity: otherObjectiveIdentity, repo: "repository_b" }), sameBlobs(), ["parent", "repo"])` deep-equals `{ parent: otherObjectiveIdentity, repo: "repository_b" }`.
- `submittedValues` reads `dependencies` and not `dependsOn`: `submittedValues(submitted({ dependencies: [otherTaskIdentity], dependsOn: ["plan/whatever.md"] }), sameBlobs(), ["depends_on"])` deep-equals `{ depends_on: [otherTaskIdentity] }`.

**The `body` pair names both blobs (D2).**

- Instruction equal, acceptance different — the two calls that a `fields: ["body"]` entry produces:
  - `storedValues(stored(), ["body"]).body` deep-equals `{ instructionBlob: instructionHash, acceptanceBlob: acceptanceHash }`;
  - `submittedValues(submitted(), { instruction: instructionHash, acceptance: otherAcceptanceHash }, ["body"]).body` deep-equals `{ instructionBlob: instructionHash, acceptanceBlob: otherAcceptanceHash }`;
  - and `result.body.instructionBlob` is equal on both sides while `result.body.acceptanceBlob` differs, asserted as two explicit assertions.
- Stored acceptance absent, submitted acceptance supplied:
  - `storedValues(stored({ acceptanceBlob: null }), ["body"]).body.acceptanceBlob` is `null`;
  - `submittedValues(submitted(), sameBlobs(), ["body"]).body.acceptanceBlob` equals `acceptanceHash`.

**`depends_on` is the normalized list (D3).**

- A reorder with a repeat publishes the same list on both sides. With `stored({ dependencies: [otherTaskIdentity, taskIdentity] })` and `submitted({ dependencies: [taskIdentity, otherTaskIdentity, otherTaskIdentity] })`:
  - `differingFields(thatStored, thatSubmitted, sameBlobs())` does **not** contain `depends_on` — assert `fields.includes("depends_on") === false`;
  - `storedValues(thatStored, null).depends_on` deep-equals `[taskIdentity, otherTaskIdentity]`;
  - `submittedValues(thatSubmitted, sameBlobs(), null).depends_on` deep-equals `[taskIdentity, otherTaskIdentity]`;
  - and the two arrays deep-equal each other.

  `taskIdentity` is `task_01ARZ3NDEKTSV4RRFFQ69G5FAV` and `otherTaskIdentity` is `task_01DRZ3NDEKTSV4RRFFQ69G5FAV`, so `taskIdentity` sorts first under `comparePaths` (`A` is `0x41`, `D` is `0x44`). Assert the exact arrays above, not a sorted-ness property.

- A genuinely different member publishes two different normalized lists. With `stored({ dependencies: [otherTaskIdentity] })` and `submitted({ dependencies: [taskIdentity, taskIdentity] })`:
  - `differingFields(...)` contains `depends_on`;
  - `storedValues(thatStored, ["depends_on"])` deep-equals `{ depends_on: [otherTaskIdentity] }`;
  - `submittedValues(thatSubmitted, sameBlobs(), ["depends_on"])` deep-equals `{ depends_on: [taskIdentity] }` — the duplicate is dropped.

**`depends_on` order is code-point order, and a naive sort is refused.**

Add these two constants beside the identity constants:

```ts
const emojiIdentity = "task_\u{1F600}";
const replacementIdentity = "task_�";
```

`comparePaths` compares code points, so `replacementIdentity` (`0xFFFD`) sorts **before** `emojiIdentity` (`0x1F600`). The default `Array.prototype.sort` compares UTF-16 code units, so it puts `emojiIdentity` first, because the leading surrogate `0xD83D` is below `0xFFFD`. The two orders differ, and the test asserts the `comparePaths` one:

- `storedValues(stored({ dependencies: [emojiIdentity, replacementIdentity] }), ["depends_on"])` deep-equals `{ depends_on: [replacementIdentity, emojiIdentity] }`.
- `submittedValues(submitted({ dependencies: [emojiIdentity, replacementIdentity] }), sameBlobs(), ["depends_on"])` deep-equals `{ depends_on: [replacementIdentity, emojiIdentity] }`.
- The guard, asserted explicitly so the substitution cannot pass silently:

```ts
assert.deepEqual([emojiIdentity, replacementIdentity].sort(), [
  emojiIdentity,
  replacementIdentity,
]);
```

That is the order this story refuses, and it is the opposite of the two assertions above.

> `Buffer.compare` over UTF-8 agrees with `comparePaths` for every well-formed string, so it cannot be the contrast case. The defect a test must catch is the bare `.sort()`, and the assertion above is the one that catches it. See the planning note in `index.md`.

**Key order is the `differingFields` order and never the argument order (D4).**

- `Object.keys(storedValues(stored(), null))` deep-equals `["body", "depends_on", "parent", "repo", "title", "worker"]`.
- The same call with the six names passed explicitly, and again reversed, returns the identical key array:

```ts
const forward = [
  "body",
  "depends_on",
  "parent",
  "repo",
  "title",
  "worker",
] as const;
const reversed = [...forward].reverse();
assert.deepEqual(Object.keys(storedValues(stored(), reversed)), [...forward]);
assert.equal(
  JSON.stringify(storedValues(stored(), reversed)),
  JSON.stringify(storedValues(stored(), forward)),
);
```

- The same two assertions for `submittedValues(submitted(), sameBlobs(), …)`.
- `Object.keys(storedValues(stored(), ["worker", "body"]))` deep-equals `["body", "worker"]` — a two-name subset also ignores argument order.

**The key order is pinned to the exported vocabulary, so the six literal blocks cannot drift.** Add `import { differingFields as differingFieldNames } from "./node-write-legality.ts";` to the test file — a test may import `domain/` — and assert the correspondence structurally:

```ts
it("the value keys are the differingFields vocabulary in its own order", () => {
  assert.deepEqual(Object.keys(storedValues(stored(), null)), [
    ...differingFieldNames,
  ]);
  assert.deepEqual(
    Object.keys(submittedValues(submitted(), sameBlobs(), null)),
    [...differingFieldNames],
  );
});
```

If a later epic adds a seventh name to `differingFields`, this test fails and names the omission. That is the intended failure.

### Commands

```bash
node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts
npm run typecheck
npm run lint
```

Assertions:

- `src/domain/plan-diff.test.ts` passes, with the thirteen pre-existing tests unmodified.
- `src/domain/plan-choice.test.ts` passes with **no edit to the file**, because `choiceVerdict` did not change. Confirm the absence of change:

```bash
git diff --quiet src/domain/plan-choice.ts && echo "PASS plan-choice untouched"
```

- `git status --porcelain` lists exactly `src/domain/plan-diff.ts` and `src/domain/plan-diff.test.ts` as modified, plus the untracked story directory. No other path under `src/` appears.

`npm run verify` exits 0.

Proof: the `src/domain/plan-diff.test.ts` and `src/domain/plan-choice.test.ts` lines of the `PASS EPIC-027` block. Hermetic coverage bullets 5 (the `body` pair), 6 (absent stored acceptance), 7 (the `depends_on` reorder and the real difference), 8 (the non-ASCII order) and 9 (the key-order determinism claim) are delivered here at the domain level; bullets 1 to 4 and 10 to 16 need the query and the contract and belong to Stories 2 and 3.

`storedValues` and `submittedValues` have no caller after this story. That is expected: Story 3 wires them. `npm run lint` must still pass, so if the boundary or unused-export rules refuse an uncalled export, stop and report it rather than adding a caller early.
