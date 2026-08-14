# Story 11 — Two concurrency classes

Epic: `.agent/plan/epics/014-external-drive-contract.md`
Depends on: EPIC 013 (sequence order). Independent of every other story.

## Change

### A new `src/domain/revision-guard.ts`

It imports nothing. Export two tuples, two types and one function:

```ts
export const nodeWriteKinds = [
  "create",
  "update-fields",
  "update-topology",
  "delete",
] as const;
export type NodeWriteKind = (typeof nodeWriteKinds)[number];

export const revisionGuardClasses = ["node", "project"] as const;
export type RevisionGuardClass = (typeof revisionGuardClasses)[number];

export function revisionGuardFor(kind: NodeWriteKind): RevisionGuardClass {
  return kind === "update-fields" ? "node" : "project";
}
```

The function is total over `nodeWriteKinds` and pure. `update-fields` returns `node`. `create`, `update-topology` and `delete` return `project`. There is no third class, so EPIC 017 cannot invent one.

`node.show` already returns the revision that last wrote the node, so the `node` class needs no new read.

## Constraints

- Write the function with no `default` branch and no `throw`. The parameter type is the closed set, so the ternary is total.
- Add no consumer. EPIC 017 reads this file.
- Declare `revisionGuardClasses` as a tuple, not as a bare union type, so a test can assert the value set.
- `eslint.config.js:230-247` allows only relative domain imports and `zod` in `src/domain/`. This file needs neither.

## Verify

- Add `src/domain/revision-guard.test.ts` with the suite name `"src/domain/revision-guard.test"`.
- Assert `nodeWriteKinds` deep-equals `["create", "update-fields", "update-topology", "delete"]` and `nodeWriteKinds.length === 4`.
- Assert `revisionGuardClasses` deep-equals `["node", "project"]` and `revisionGuardClasses.length === 2`.
- Assert `revisionGuardFor` over every member of `nodeWriteKinds`, one assertion per member: `create` → `project`, `update-fields` → `node`, `update-topology` → `project`, `delete` → `project`.
- Assert the result set is exactly `{ node, project }`: build `new Set(nodeWriteKinds.map(revisionGuardFor))`, assert its size is `2`, and assert `[...set].sort()` deep-equals `["node", "project"]`. A third value fails it.
- `node --test src/domain/revision-guard.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`, with `src/domain/revision-guard.test.ts` named explicitly in the Proof block. Hermetic coverage: the `revisionGuardFor` bullet at `.agent/plan/epics/014-external-drive-contract.md:95`.
