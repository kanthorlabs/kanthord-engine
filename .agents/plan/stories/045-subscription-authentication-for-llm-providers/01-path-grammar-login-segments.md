# Story 1 — The path grammar admits the two login segments

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`

## Change

### `src/http/contract/path.ts`

Add exactly one member to each of two closed arrays. Both arrays are asserted sorted
bytewise and duplicate-free by `path.test.ts:23-35`, so the insert position is fixed.

1. `subresourceSegments` (`src/http/contract/path.ts:20-37`): insert `"login"` between
   `"llm"` (line 28) and `"node"` (line 29). Bytewise: `llm` < `login` < `node`.

   ```ts
   export const subresourceSegments = [
     "approval",
     "attempt",
     "binding",
     "check",
     "default",
     "edge",
     "graph",
     "llm",
     "login",
     "node",
     "plan",
     "profile",
     "repository",
     "revision",
     "run",
     "status",
     "worker",
   ] as const;
   ```

2. `actionSegments` (`src/http/contract/path.ts:39-63`): insert `"complete"` between
   `"claim"` (line 43) and `"delete"` (line 44). Bytewise: `claim` < `complete` < `delete`.

Change nothing else in the file. `"cancel"` is already at line 42 and is reused as is.

### `docs/proposal/api/README.md`

In the five-kind table at `docs/proposal/api/README.md:137-143`, append the two new
spellings to the `Examples` cell of their own row, at the end of each list:

- line 140, the `subresource` row: `` `plan`, `profile`, `approval`, `default`, `login` ``
- line 141, the `action` row: `` `inspect`, `rename`, `reconcile`, `import`, `publish`, `complete` ``

Change no other line of the file. `prettier` reflows the table column widths; run
`npm run format` and commit the reflowed table.

### `src/http/contract/path.test.ts`

1. Update the pinned sizes at `src/http/contract/path.test.ts:37-42`:

   ```ts
   it("pins the closed-array sizes", () => {
     assert.equal(resourceSegments.length, 14);
     assert.equal(subresourceSegments.length, 17);
     assert.equal(actionSegments.length, 24);
     assert.equal(systemSegments.length, 3);
   });
   ```

2. Add two tests after the existing `graph` test (which ends at
   `src/http/contract/path.test.ts:165`), following that test's exact form:

   ```ts
   it("login is a subresource segment sorted between llm and node", () => {
     assert.ok(
       subresourceSegments.includes("login"),
       "login subresource segment is missing",
     );
     const loginIndex = subresourceSegments.indexOf("login");
     assert.ok(
       loginIndex > subresourceSegments.indexOf("llm"),
       "login must be sorted after llm",
     );
     assert.ok(
       loginIndex < subresourceSegments.indexOf("node"),
       "login must be sorted before node",
     );
     assert.equal(
       renderPath([resource("provider"), sub("login")]),
       "/v1/provider/login",
     );
   });

   it("complete is an action segment sorted between claim and delete", () => {
     assert.ok(
       actionSegments.includes("complete"),
       "complete action segment is missing",
     );
     const completeIndex = actionSegments.indexOf("complete");
     assert.ok(
       completeIndex > actionSegments.indexOf("claim"),
       "complete must be sorted after claim",
     );
     assert.ok(
       completeIndex < actionSegments.indexOf("delete"),
       "complete must be sorted before delete",
     );
     assert.equal(
       renderPath([resource("provider"), sub("login"), action("complete")]),
       "/v1/provider/login/complete",
     );
     assert.equal(
       renderPath([resource("provider"), sub("login"), action("cancel")]),
       "/v1/provider/login/cancel",
     );
   });
   ```

   The singular assertion at `src/http/contract/path.test.ts:88-96` covers both new
   segments with no edit: neither `login` nor `complete` ends in `s`.

### `src/http/contract/registry.test.ts`

Add one test to the legality block, after the existing illegal-sequence table that ends
at `src/http/contract/registry.test.ts:570`. It proves the EPIC's stated reason for
carrying the login id in the body:

```ts
it("refuses a parameter after the login subresource", () => {
  const entry = {
    operationId: "provider.loginIllegal",
    method: "POST",
    path: [resource("provider"), sub("login"), parameter("provider")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
  } as const;
  const faults = registryFaults([entry]);
  assert.equal(faults.length, 1);
  assert.equal(faults[0]?.reason, "segment sequence is not a legal path");
});

it("accepts the two login tuples", () => {
  for (const path of [
    [resource("provider"), sub("login")],
    [resource("provider"), sub("login"), action("complete")],
    [resource("provider"), sub("login"), action("cancel")],
  ] as const) {
    assert.deepEqual(
      registryFaults([
        {
          operationId: "provider.loginProbe",
          method: "POST",
          path,
          introducedIn: "phase-2",
          status: "routed",
          allowedActors: ["human"],
        },
      ]),
      [],
    );
  }
});
```

`isLegalPath` (`src/http/contract/registry.ts:319-366`) already yields both verdicts:
`subresource → parameter` is refused by the branch at lines 356-359, and
`subresource → action` is admitted by the same branch.

## Constraints

- Add one member to each array and nothing else. A third spelling is a separate decision.
- Do not add an operation in this story. `registry.length` stays 70, and
  `src/http/contract/registry.test.ts:49-51` stays unchanged.
- Do not touch `resourceSegments`, `systemNamespaceSegments` or `systemLeafSegments`.
- The two probe entries above are test-local literals. Do not add them to any registry
  array.

## Verify

```
node --test src/http/contract/path.test.ts src/http/contract/registry.test.ts
npm run verify
```

`path.test.ts` asserts: both arrays stay sorted and duplicate-free, the two pinned sizes
are 17 and 24, both new segments are singular, and the three login paths render exactly
`/v1/provider/login`, `/v1/provider/login/complete` and `/v1/provider/login/cancel`.
`registry.test.ts` asserts the parameter-after-`login` tuple is illegal and the three
legal tuples produce no fault.

Proof: delivers `src/http/contract/path.test.ts` and part of
`src/http/contract/registry.test.ts` (PASS EPIC-045). `npm run verify` exits 0.
