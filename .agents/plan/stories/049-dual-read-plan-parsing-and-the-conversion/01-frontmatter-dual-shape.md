# Story 1 — Frontmatter accepts both shapes

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: EPIC 047 (provides `deliverable` Zod enum from `src/domain/deliverable.ts` and `verifyBlock` Zod schema from `src/domain/verify-block.ts`; both must exist before this story compiles)

## Change

**`src/domain/plan-document.ts` — `planFrontmatterKeys` (lines 7-14)**

Add `"deliverable"` and `"verify"` to the `Set` constructor call. The set must contain exactly: `"id"`, `"kind"`, `"title"`, `"depends_on"`, `"worker"`, `"repo"`, `"deliverable"`, `"verify"`. Order inside the `Set` constructor is alphabetical by existing convention.

**`src/domain/plan-document.ts` — `planFrontmatter` (lines 16-36)**

Add two optional fields to the Zod object:

- `deliverable: deliverable.optional()` — import `deliverable` from `"./deliverable.ts"`.
- `verify: verifyBlock.optional()` — import `verifyBlock` from `"./verify-block.ts"`.

Add a second `.superRefine` after the existing unknown-key superRefine. It enforces two rules in this exact order:

1. If `value.worker !== undefined && value.deliverable !== undefined`: call `context.addIssue({ code: "custom", path: ["deliverable"], message: "frontmatter-invalid" })`.
2. If `value.deliverable !== undefined && value.verify === undefined`: call `context.addIssue({ code: "custom", path: ["verify"], message: "frontmatter-invalid" })`.

Rules are checked independently; a single parse call may trigger more than one issue.

A document carrying neither `worker` nor `deliverable` is legal. `worker` is `required=true nullable=true` in the `node.create` request for all three kinds, at `src/http/contract/field-decisions.fixture.ts:113`, `:120` and `:127`, so the daemon creates such a node itself and `renderDocument` emits a document naming neither field. Refusing it would stop the daemon re-reading its own export. EPIC 057 removes `worker` and makes `deliverable` mandatory in one change.

**`src/domain/plan-document.ts` — `ParsedDocument` (lines 38-49)**

Add two fields to the `Readonly<{...}>` type:

- `deliverable: Deliverable | null` — the parsed deliverable, or `null` if absent. Import `Deliverable` from `"./deliverable.ts"`.
- `verify: VerifyBlock | null` — the parsed verify block, or `null` if absent. Import `VerifyBlock` from `"./verify-block.ts"`.

In the function that constructs a `ParsedDocument` from a parsed frontmatter value (locate by searching for the object that assigns `worker: frontmatter.worker ?? null`), add `deliverable: frontmatter.deliverable ?? null` and `verify: frontmatter.verify ?? null`.

## Constraints

- `worker` must remain in `planFrontmatterKeys` and in `planFrontmatter`. Do not remove it. EPIC 057 removes it.
- The mutual-exclusivity superRefine must not touch the unknown-key superRefine. Keep them as two separate `.superRefine` calls.
- `ParsedDocument.worker` stays `string | null`. Do not change its type.

## Verify

```
node --test src/domain/plan-document.test.ts
```

Add the following test cases inside `describe("src/domain/plan-document.test", ...)` in `src/domain/plan-document.test.ts`:

1. `"planFrontmatter accepts the legacy shape (worker only)"` — input `{ kind: "task", title: "T", worker: "claude.swe@1" }` — assert `result.success === true` and `result.data.deliverable === undefined` and `result.data.verify === undefined`.

2. `"planFrontmatter accepts the new shape (deliverable and verify)"` — input `{ kind: "task", title: "T", deliverable: "test", verify: { paths: [], commands: [] } }` — assert `result.success === true` and `result.data.worker === undefined`.

3. `"both worker and deliverable together raise frontmatter-invalid on path deliverable"` — input `{ kind: "task", title: "T", worker: "claude.swe@1", deliverable: "test", verify: { paths: [], commands: [] } }` — assert `result.success === false`. Collect `const paths = issuePaths(result)`. Assert `assert.equal(paths.filter((p) => JSON.stringify(p) === JSON.stringify(["deliverable"])).length, 1)` — exactly one issue has path `["deliverable"]`. Assert `assert.deepEqual(paths.find((p) => JSON.stringify(p) === JSON.stringify(["deliverable"])), ["deliverable"])` — the path value is exactly `["deliverable"]`.

4. `"a document naming neither worker nor deliverable parses for every kind"` — inputs `{ kind: "initiative", title: "T" }`, `{ kind: "objective", title: "T" }` and `{ kind: "task", title: "T" }` — assert `result.success === true` for each, and `result.data.worker === undefined` and `result.data.deliverable === undefined`.

5. `"deliverable with no verify raises frontmatter-invalid on path verify"` — input `{ kind: "task", title: "T", deliverable: "test" }` — assert `result.success === false`. Collect `const paths = issuePaths(result)`. Assert `assert.equal(paths.length, 1)`. Assert `assert.deepEqual(paths[0], ["verify"])`.

6. `"an assignment key raises unknown frontmatter key on path assignment"` — input `{ kind: "task", title: "T", worker: "claude.swe@1", assignment: "x" }` — assert `result.success === false`. Collect `const paths = issuePaths(result)`. Assert `assert.equal(paths.length, 1)`. Assert `assert.deepEqual(paths[0], ["assignment"])`.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/domain/plan-document.test.ts` in `PASS EPIC-049`. Hermetic coverage: rule 1, rule 2, rule 3 of the mutual-exclusivity check; legacy shape parses; new shape parses; assignment key refused.
