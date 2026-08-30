# Story 07 — No writer can change a pair in place

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Depends on: Story 05

## Change

No production code changes. This story adds only test assertions.

## Verify

### `src/domain/node-write-legality.test.ts`

Add two assertions to the existing test file at `src/domain/node-write-legality.test.ts`:

1. `proseFields` does not contain `"deliverable"`:
   ```ts
   assert.ok(!proseFields.includes("deliverable" as never));
   ```
2. `structuralFields` does not contain `"deliverable"`:
   ```ts
   assert.ok(!structuralFields.includes("deliverable" as never));
   ```

### `src/commands/node/update-node.test.ts`

Add one assertion to the existing test file at `src/commands/node/update-node.test.ts`:

3. A `node.update` request body that includes a `deliverable` field is refused by the contract schema. The contract schema `nodeUpdateRequest` (from `src/http/contract/graph.ts`) must reject a body that carries `deliverable`. Use a fully-specified task update body — read `nodeUpdateRequest` in `src/http/contract/graph.ts` to find the exact required fields for `kind: "task"` and include all of them. The assertion:
   ```ts
   const result = nodeUpdateRequest.safeParse({
     kind: "task",
     fromRevision: "01JQ8Z7G3HZZZZZZZZZZZZZZZZ",
     title: "a task",
     instruction: "do the thing",
     acceptance: "it is done",
     dependsOn: [],
     parentId: "obj_01JQ8Z7G3HZZZZZZZZZZZZZZZZ",
     deliverable: "test",
   });
   assert.strictEqual(result.success, false);
   ```
   Read `nodeWriteFields` and `nodeUpdateRequest` in `src/http/contract/graph.ts` to confirm required fields before writing the fixture. The fixture must not omit a required field or the parse fails for the wrong reason.

```bash
node --test src/domain/node-write-legality.test.ts
node --test src/commands/node/update-node.test.ts
```

Both must pass.

Proof: PASS EPIC-047 line for `src/domain/node-write-legality.test.ts` and `src/commands/node/update-node.test.ts`; hermetic coverage — `deliverable` is in neither `proseFields` nor `structuralFields`, and `node.update` carrying a `deliverable` field is refused.
