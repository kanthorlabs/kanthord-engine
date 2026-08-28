# Story 3 — Handler parses `force` and passes a boolean to the command

Epic: `.agents/plan/epics/042-forced-removal-of-a-default-holding-provider.md`
Depends on: Story 1 (`RemoveProviderInput.force: boolean`), Story 2 (`providerRemoveRequest`)

## Change

**`src/http/server/credential/remove-provider.ts`**

The file currently has 28 lines. Add three imports at the top (after the existing imports):

```ts
import { providerRemoveRequest } from "../../contract/credential.ts";
import { invalidRequest } from "../invalid-request.ts";
import { singleValued } from "../single.ts";
```

Inside the handler function, after extracting `id` from `context.parameters["id"]` (currently line 14) and before the `try` block (currently line 17), insert the query-parse block:

```ts
const queryParsed = providerRemoveRequest.safeParse(
  singleValued(context.query),
);
if (!queryParsed.success) {
  throw invalidRequest(
    "query-schema",
    "the force parameter is not valid",
    queryParsed.error,
  );
}
const force = queryParsed.data.force === "true";
```

Change the command call (currently lines 19-22) to include `force`:

```ts
const removed = dependencies.removeProvider({
  id,
  actor: context.actor.id,
  force,
});
```

`RemoveProviderHandlerDependencies` at lines 6-8 does not change. Its `removeProvider` field is typed as `(input: RemoveProviderInput) => Readonly<{ id: string }>`. After Story 1, `RemoveProviderInput` includes `force`. The dependency type stays structurally valid.

`src/main.ts` does not change. The bound lambda `(input) => removeProvider(deps, input)` passes `input` through; TypeScript satisfies the new `force` field because the handler provides it.

**`src/http/server/credential/remove-provider.test.ts`**

- Update the existing happy-path test (lines 22-43). The existing assertion:

  ```ts
  assert.deepEqual(called, { id: providerId, actor: bootstrapActorId });
  ```

  Change to:

  ```ts
  assert.deepEqual(called, {
    id: providerId,
    actor: bootstrapActorId,
    force: false,
  });
  ```

- Add the following new `it` cases:

  **Case A — `force=true` in query string → command receives `force: true`.**
  Reset the spy to `undefined` before calling. Send `app.del(\`/v1/provider/${providerId}?force=true\`)`. Assert `response.status === 200`and`called!.force === true`.

  **Case B — `force=false` in query string → command receives `force: false`.**
  Send `app.del(\`/v1/provider/${providerId}?force=false\`)`. Assert `response.status === 200`and`called!.force === false`.

  **Case C — absent `force` → command receives `force: false`.**
  Send `app.del(\`/v1/provider/${providerId}\`)`(no query string). Assert`response.status === 200`and`called!.force === false`.

  **Case D — `force=1` → 400 `invalid-request`, command not called.**
  Reset the spy to `undefined` before calling. Send `app.del(\`/v1/provider/${providerId}?force=1\`)`. Assert `response.status === 400`, `response.body.error.code === "invalid-request"`, and `called`is still`undefined`.

  **Case E — `force=yes` → 400 `invalid-request`, command not called.**
  Same pattern as Case D with `?force=yes`.

  **Case F — `force=TRUE` → 400 `invalid-request`, command not called.**
  Same pattern as Case D with `?force=TRUE`.

  **Case H — `force=` (empty value) → 400 `invalid-request`, command not called.**
  Same pattern as Case D with `?force=`. The empty string `""` is not in `["true", "false"]`; the schema rejects it before the command runs.

  **Case G — two `force` values in the query string → 400 `invalid-request` from `singleValued`.**
  Send `app.del(\`/v1/provider/${providerId}?force=true&force=false\`)`. Assert `response.status === 400`, `response.body.error.code === "invalid-request"`, and `called`is still`undefined`. This path throws before the schema parse because `singleValued` rejects duplicate keys.

**`src/http/server/credential/refusals.test.ts`**

No change. The `RemoveProviderError "binding-in-use"` test at line 87 covers the `toHttpError` path and passes unchanged.

**`src/main.test.ts`**

No change. The `provider.remove` test at line 95 sends no `force` query param; the handler defaults `force` to `false` and the 404 response is unaffected.

## Constraints

- `singleValued(context.query)` executes before the schema parse. A duplicate `force` key causes `singleValued` to throw `httpError("invalid-request")` before the schema is evaluated.
- `force = queryParsed.data.force === "true"` is the exact boolean conversion. `"false"` and absent (`undefined`) both yield `false`.
- The handler does not branch on domain rules: it parses, calls one command, formats the response.
- `invalidRequest` is imported from `"../invalid-request.ts"` — the same import path used by other handlers in `src/http/server/`.

## Verify

- `node --test src/http/server/credential/remove-provider.test.ts src/http/server/credential/refusals.test.ts src/main.test.ts` exits 0.
- `npm run verify` exits 0 (this is the first point in the coupled 1+3 pair where full type-check is valid).
- Proof: delivers `src/http/server/credential/remove-provider.test.ts`, `src/http/server/credential/refusals.test.ts`, and `src/main.test.ts` from the EPIC-042 Proof block.
