# Story 2 — Contract declares the `providerRemoveRequest` query schema

Epic: `.agents/plan/epics/042-forced-removal-of-a-default-holding-provider.md`

## Change

**`src/http/contract/credential.ts`**

- Add the following exported schema immediately before the existing `providerRemoveResponse` definition (currently around line 80):

  ```ts
  export const providerRemoveRequest = z.strictObject({
    force: z.enum(["true", "false"]).optional(),
  });
  ```

- Add `query: providerRemoveRequest` to the `provider.remove` registry entry at lines 390-403. The updated entry:

  ```ts
  {
    operationId: "provider.remove",
    method: "DELETE",
    path: [resource("provider"), parameter("provider")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    query: providerRemoveRequest,
    response: providerRemoveResponse,
    errors: {
      ...baselineErrors,
      "binding-in-use": providerBindingInUseDetails,
    },
    examples: providerRemoveExamples,
  },
  ```

- Add `query: { force: "false" }` to `providerRemoveExamples` at lines 146-162:
  ```ts
  export const providerRemoveExamples: OperationExamples = {
    query: { force: "false" },
    success: { id: `provider_${U}` },
    error: {
      error: {
        code: "binding-in-use",
        message: `provider provider_${U} is still in use`,
        details: {
          blockers: [
            { kind: "default-chain" },
            { kind: "project-binding", projectId: `project_${U}` },
            { kind: "repository", repositoryId: `repository_${U}` },
            { kind: "attempt", attemptId: `attempt_${U}` },
          ],
        },
      },
    },
  };
  ```
  `ProviderRemovalBlocker` and `providerBindingInUseDetails` are unchanged.

**`src/http/contract/credential.test.ts`**

- Add `providerRemoveRequest` to the import list.

- Add a new `it` case: **"`providerRemoveRequest` parses valid force values and rejects invalid ones"**:

  ```ts
  it("providerRemoveRequest parses valid force values and rejects invalid ones", () => {
    assert.deepEqual(providerRemoveRequest.parse({}), {});
    assert.deepEqual(providerRemoveRequest.parse({ force: "true" }), {
      force: "true",
    });
    assert.deepEqual(providerRemoveRequest.parse({ force: "false" }), {
      force: "false",
    });
    assert.equal(
      providerRemoveRequest.safeParse({ force: "1" }).success,
      false,
    );
    assert.equal(
      providerRemoveRequest.safeParse({ force: "yes" }).success,
      false,
    );
    assert.equal(
      providerRemoveRequest.safeParse({ force: "TRUE" }).success,
      false,
    );
    assert.equal(providerRemoveRequest.safeParse({ force: "" }).success, false);
    assert.equal(
      providerRemoveRequest.safeParse({ force: undefined }).success,
      true,
    );
    assert.equal(
      providerRemoveRequest.safeParse({ force: "true", extra: 1 }).success,
      false,
    );
  });
  ```

- Update the existing "the remove examples carry the exact story values" test (around line 67) to also assert:

  ```ts
  assert.deepEqual(providerRemoveExamples.query, { force: "false" });
  ```

  Add this alongside the existing `success` and `error` assertions.

- Update the "every example parses against its own strict schema and envelope" test (lines 108-146). The `operations` tuple for `provider.remove` currently is:
  ```ts
  ["provider.remove", providerRemoveExamples, undefined, providerRemoveResponse],
  ```
  Change it to add `providerRemoveRequest` as the fifth element:
  ```ts
  ["provider.remove", providerRemoveExamples, undefined, providerRemoveResponse, providerRemoveRequest],
  ```
  The outer `as const` on the array must be updated to accommodate the fifth element type. After the existing `if (request !== undefined)` block inside the for-of loop, add:
  ```ts
  const [, , , , query] = operation;
  if (query !== undefined) {
    assert.doesNotThrow(
      () => (query as { parse: (v: unknown) => unknown }).parse(examples.query),
      `${operationId} query example fails its schema`,
    );
  }
  ```
  The other two tuples (`provider.rename`, `provider.setDefault`) do not have a fifth element; the destructured `query` is `undefined` for them, so the guard skips them.

## Constraints

- `providerRemoveRequest` uses `z.strictObject`. An unknown key causes a parse failure.
- `force` is `z.enum(["true", "false"]).optional()`. Absent is valid; `"1"`, `"yes"`, `"TRUE"`, and `""` each fail.
- Do not add `force` to `providerRemoveResponse`.
- `ProviderRemovalBlocker` and `providerBindingInUseDetails` are unchanged.
- The registry test at `src/http/contract/registry.test.ts` lists `provider.remove` as `"routed"` at line 170. Adding `query` to the entry does not change `status`; the registry test passes unchanged.
- `query: { force: "false" }` is consistent with the error example (which shows `default-chain` blocker — a response only possible when `force` is false or absent).

## Verify

- `node --test src/http/contract/credential.test.ts src/http/contract/registry.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: delivers `src/http/contract/credential.test.ts` and `src/http/contract/registry.test.ts` from the EPIC-042 Proof block.
