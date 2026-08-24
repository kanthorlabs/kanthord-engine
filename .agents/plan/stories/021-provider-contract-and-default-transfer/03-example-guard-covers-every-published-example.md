# Story 3 — `example.test.ts` validates every published example

Epic: `.agents/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 2, for ordering only. This story has no technical dependency on Story 2: `provider.register` is phase-1 routed and already inside the current scope, so the widened filter adds `provider.rename`, `provider.remove` and `provider.setDefault` and nothing else. Run it after Story 2 so the corrected `token` example sits under the widened guard from the first run.

## Change

- Edit `src/http/contract/example.test.ts`. Replace the `scoped` constant at lines 8-13 with

```ts
const scoped = registry.filter((entry) => entry.examples !== undefined);
```

Delete the `entry.status === "routed"`, the `entry.introducedIn === "phase-1"` and the `entry.operationId !== "blob.show"` clauses. `blob.show` carries no examples, so it leaves `scoped` by the filter itself rather than by name.

- Replace the sub-test at line 17 titled `"covers the thirty-six phase-1 routed operations"`. Its new title is `"covers every operation that carries examples"`, and its body asserts

```ts
assert.deepEqual(
  scoped.map((entry) => entry.operationId),
  [
    "actor.list",
    "actor.register",
    "actor.revoke",
    "actor.rotate",
    "actor.show",
    "edge.list",
    "event.list",
    "node.claim",
    "node.create",
    "node.delete",
    "node.heartbeat",
    "node.list",
    "node.release",
    "node.report",
    "node.show",
    "node.unblock",
    "node.update",
    "plan.export",
    "plan.import",
    "plan.revisions",
    "plan.validate",
    "project.create",
    "project.list",
    "project.repositories",
    "project.show",
    "project.status",
    "provider.list",
    "provider.register",
    "provider.remove",
    "provider.rename",
    "provider.setDefault",
    "provider.show",
    "repository.inspect",
    "repository.list",
    "repository.register",
    "repository.show",
    "system.db",
    "system.health",
    "system.status",
  ],
);
```

`registry` is already sorted bytewise by `operationId` at `src/http/contract/registry.ts:25-39`, so `scoped` preserves that order and the list is written in it. Assert no count. The list holds 39 ids; if it does not deep-equal the live value, a later epic added a routed operation, and the fix is to add its id in bytewise position, never to relax the assertion.

- Replace the sub-test at line 165 titled `"blob.show carries no example"` with one titled `"blob.show is the only routed operation with no example"`, whose body asserts

```ts
assert.deepEqual(
  registry
    .filter(
      (entry) => entry.status === "routed" && entry.examples === undefined,
    )
    .map((entry) => entry.operationId),
  ["blob.show"],
);
```

- In the success, request and query sub-tests, skip a slot whose schema is `undefined` rather than asserting its presence. A slot is skipped per slot, not per entry: an entry with a `response` schema and no `request` schema still has its success example parsed.
- Keep the query sub-test's assertion that `event.list` is the only entry carrying a query example, unchanged.
- Keep the sub-tests `"every error example satisfies its own operation's envelope"`, `"an error example naming an undeclared code fails"`, `"a broken example fails its schema"`, `"no stubbed operation carries an example"` and `"every example is a plain JSON value"` unchanged, except that they now read the widened `scoped`.
- Add one comment line above the `scoped` constant recording exactly what the widened filter adds: the three phase-2 provider operations, whose examples no test parsed before. Do **not** write that the filter makes `provider.register` verifiable — `provider.register` is phase-1 routed and was already in scope; Story 2 is what makes its request example verifiable, by typing `payload`. A comment claiming otherwise records a false repository fact.

## Constraints

- Add no dependency on `introducedIn` and no dependency on `status` in assertion 1. Assertion 2 is the only place `status` is read.
- Do not enumerate `blob.show` as an exclusion anywhere in the file. Its only mention is the deep-equal of assertion 2.
- Change no registry entry and no example in this story.
- Assert the exact sorted operation-id list. Do not assert a length, and do not derive the expected list from `registry` at run time.

## Verify

- Run `node --test --test-timeout=60000 src/http/contract/example.test.ts`; it exits 0.
- The suite must now parse the success and error examples of `provider.rename`, `provider.remove` and `provider.setDefault` against their own schemas and envelopes, which is the coverage this story adds. Confirm by temporarily corrupting `providerSetDefaultExamples.success` with an added key and observing the suite fail; revert the corruption before the gate.
- Run `node --test --test-timeout=60000 src/http/contract/coverage.test.ts src/http/contract/credential.test.ts`; it exits 0.
- Run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/http/contract/example.test.ts`, plus Hermetic coverage "The example guard", all three bullets.
