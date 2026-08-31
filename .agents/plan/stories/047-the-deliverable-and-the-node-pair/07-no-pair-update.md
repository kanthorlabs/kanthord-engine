# Story 07 — No writer can change a pair in place

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Depends on: Story 05

## Change

No production code changes. This story adds only test assertions.

## Tasks

### Task 07 — Pin the absence of `deliverable` from every node update path

**Input:** `src/domain/node-write-legality.test.ts`, `src/commands/node/update-node.test.ts`

**Action — RED:** Write the three assertions named under `## Verify`. This Task is a
characterization Task: every assertion passes on the first run, because the production
code already excludes `deliverable` from both field lists and from `nodeUpdateRequest`.
A first-run pass is the intended result here, and it is not a defect. The assertions are
regression guards, and each one is falsifiable:

- Assertion 1 fails when a writer adds `"deliverable"` to `proseFields`.
- Assertion 2 fails when a writer adds `"deliverable"` to `structuralFields`.
- Assertion 3 fails when a writer adds a `deliverable` key to any member of
  `nodeWriteFields`, or relaxes `z.strictObject` to a passthrough object.

Prove the sensitivity by construction: state in the turn which single production edit
breaks each assertion. Do not add a temporary production edit to demonstrate it — that
edit is out of your lane.

**Action — GREEN:** None. Production already satisfies all three assertions. The
software-engineer changes no file. Record a no-op turn that reports `pnpm run typecheck`
exit 0, lists `None` under `**Files changed.**`, and states that Story 07 assigns no
production work. Do not raise `OPEN:` and do not raise `ATTEMPT-FAILED:` for the absence
of production work — this Task is RED-only by design.

**Action — REFACTOR:** None.

## Verify

### `src/domain/node-write-legality.test.ts`

Add two assertions to the existing test file at `src/domain/node-write-legality.test.ts`:

1. `proseFields` does not contain `"deliverable"`:
   ```ts
   assert.ok(!(proseFields as readonly string[]).includes("deliverable"));
   ```
2. `structuralFields` does not contain `"deliverable"`:
   ```ts
   assert.ok(!(structuralFields as readonly string[]).includes("deliverable"));
   ```

### `src/commands/node/update-node.test.ts`

Add one assertion to the existing test file at `src/commands/node/update-node.test.ts`:

3. A `node.update` request body that carries a `deliverable` field is refused by the
   contract schema `nodeUpdateRequest` (from `src/http/contract/graph.ts`).
   `nodeUpdateRequest` is `z.strictObject({ fromRevision, node })`, and `node` is a
   discriminated union of `z.strictObject` members — so `deliverable` belongs inside
   `node`, never at the top level. The assertion:
   ```ts
   const result = nodeUpdateRequest.safeParse({
     fromRevision: "01JQ8Z7G3HZZZZZZZZZZZZZZZZ",
     node: {
       kind: "task",
       title: "a task",
       parentId: "obj_01JQ8Z7G3HZZZZZZZZZZZZZZZZ",
       instruction: "do the thing",
       acceptance: "it is done",
       worker: null,
       dependsOn: [],
       deliverable: "test",
     },
   });
   assert.strictEqual(result.success, false);
   ```
   Assert the refusal reason too, so the test cannot pass for a missing required field:
   ```ts
   assert.deepStrictEqual(result.error?.issues[0]?.code, "unrecognized_keys");
   assert.deepStrictEqual(result.error?.issues[0]?.path, ["node"]);
   ```
   Then assert the same body without `deliverable` parses, which proves the fixture is
   otherwise complete:
   ```ts
   assert.strictEqual(
     nodeUpdateRequest.safeParse({
       fromRevision: "01JQ8Z7G3HZZZZZZZZZZZZZZZZ",
       node: {
         kind: "task",
         title: "a task",
         parentId: "obj_01JQ8Z7G3HZZZZZZZZZZZZZZZZ",
         instruction: "do the thing",
         acceptance: "it is done",
         worker: null,
         dependsOn: [],
       },
     }).success,
     true,
   );
   ```

```bash
node --test src/domain/node-write-legality.test.ts
node --test src/commands/node/update-node.test.ts
```

Both must pass.

Proof: PASS EPIC-047 line for `src/domain/node-write-legality.test.ts` and `src/commands/node/update-node.test.ts`; hermetic coverage — `deliverable` is in neither `proseFields` nor `structuralFields`, and `node.update` carrying a `deliverable` field is refused as an unrecognized key.
