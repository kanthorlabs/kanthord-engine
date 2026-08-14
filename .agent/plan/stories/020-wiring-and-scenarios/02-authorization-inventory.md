# Story 2 — The registry-wide authorization inventory

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 1.

## Change

### A new `src/http/contract/authorization.test.ts`

Suite name `"src/http/contract/authorization.test"`. It imports `registry` from `./registry.ts` and nothing else from the product.

Declare the harness set as one exported-in-file literal, sorted bytewise, exactly these sixteen ids:

```ts
const harnessOperations: readonly string[] = [
  "blob.show",
  "edge.list",
  "node.claim",
  "node.create",
  "node.delete",
  "node.heartbeat",
  "node.list",
  "node.release",
  "node.report",
  "node.show",
  "node.update",
  "plan.export",
  "project.list",
  "project.show",
  "project.status",
  "system.health",
];
```

Write these cases, in this order:

- `it("every entry declares a non-empty allowedActors", ...)` — iterate the whole `registry`. For each entry assert `Array.isArray(entry.allowedActors)` and `entry.allowedActors.length > 0`. Name the offending `operationId` in the assertion message. Iterate by member, never by count.
- `it("every entry admits human", ...)` — iterate the whole `registry` and assert `entry.allowedActors.includes("human")`, naming the `operationId` on failure.
- `it("the harness-admitting set is exactly the sixteen named ids", ...)` — compute

  ```ts
  const actual = registry
    .filter((entry) => entry.allowedActors.includes("harness"))
    .map((entry) => entry.operationId)
    .sort(byBytes);
  ```

  and `assert.deepEqual(actual, harnessOperations)`. `byBytes` compares through `Buffer.compare(Buffer.from(a), Buffer.from(b))`, matching `src/http/contract/registry.ts:24-37`.

- `it("system.status and event.list admit human only", ...)` — assert by name that neither id appears in `actual`, and assert each declares `["human"]` exactly. `015-actor-identity.md:62` excludes `system.status` because it returns operator detail, and `event.list` because it discloses every human decision.
- `it("every operation outside the harness set declares human alone", ...)` — compute the difference as a set, never as a count:

  ```ts
  const outside = registry
    .filter((entry) => !harnessOperations.includes(entry.operationId))
    .map((entry) => entry.operationId)
    .sort(byBytes);
  ```

  For each id in `outside`, assert `findOperation(id).allowedActors` deep-equals `["human"]`, naming the id on failure.

- `it("a removed harness row fails the set assertion by name", ...)` — build a local copy of the registry rows with one entry's `allowedActors` narrowed to `["human"]`, run the same computation over the copy, and assert the comparison reports the removed id. Mutate no imported object.
- `it("an added harness row fails the set assertion by name", ...)` — the same shape with one `["human"]` row widened to `["human", "harness"]`, asserting the added id is reported.

### Remove the duplicated assertion from `src/http/contract/registry.test.ts`

`harnessOperations` and the harness-set assertion live in `src/http/contract/registry.test.ts` today, per `015-actor-identity.md` story `07-authorization-registry.md:36`. Delete that list and that assertion from `registry.test.ts`, and leave every other assertion in the file unchanged. The harness set has exactly one home after this story.

Story 1 Check 5 confirms the pin before this story starts. If the grep disagreed, this epic stopped there.

Do not move, and do not touch, the scalar totals at `src/http/contract/registry.test.ts:20,25`. Each vertical epic owns its own raise of those numbers.

## Constraints

- **This file states no registry total.** No `registry.length`, no routed count, no stubbed count, no harness count. Every assertion is by name or by set difference.
- Edit no registry row. A failure here is a defect returned to the epic that declared the offending row.
- Import no koa, no server module and no command.

## Verify

- `node --test src/http/contract/authorization.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts` exits 0.
- Narrowing one `allowedActors` row of `src/http/contract/graph.ts` to `["human"]` makes the third case fail, and the failure message names that operation id. Restore the row.
- `npm run verify` exits 0.
- Proof: `src/http/contract/authorization.test.ts`, `src/http/contract/registry.test.ts`, `src/http/contract/parity.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:149`, `:150`.
