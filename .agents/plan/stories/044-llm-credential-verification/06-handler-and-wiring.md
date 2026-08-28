# Story 6 — Handler, refusals, and main.ts wiring

Epic: `.agents/plan/epics/044-llm-credential-verification.md`
Depends on: Story 5

## Change

### `src/http/server/credential/verify-provider.ts` (new file)

```ts
import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { VerifyProviderError } from "../../../queries/provider/verify-provider.ts";
import type {
  VerifyProviderInput,
  VerifyProviderResult,
} from "../../../queries/provider/verify-provider.ts";
import { toHttpError } from "./refusals.ts";

export type VerifyProviderHandlerDependencies = Readonly<{
  verifyProvider: (input: VerifyProviderInput) => Promise<VerifyProviderResult>;
}>;

export function verifyProviderHandler(
  dependencies: VerifyProviderHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no provider id in the request path");
    }
    try {
      const result = await dependencies.verifyProvider({
        id,
        signal: AbortSignal.timeout(60_000),
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
```

Note: `HandlerContext` (defined in `src/http/server/app.ts:30-38`) has no `signal`
field. The handler creates its own `AbortSignal.timeout(60_000)` for the probe.
This is intentional: the 60-second handler timeout is wider than the 30-second probe
timeout inside `PiAiProviderAuth`; the inner probe signal fires first.

### `src/http/server/credential/refusals.ts`

Extend `toHttpError` to handle `VerifyProviderError`. Add after the existing
`RemoveProviderError` branch:

```ts
if (error instanceof VerifyProviderError) {
  if (error.refusal === "not-found") {
    return httpError("not-found", error.message);
  }
  if (error.refusal === "service-unavailable") {
    return httpError("service-unavailable", error.message);
  }
  return httpError("invalid-request", error.message, {
    refusal: error.refusal,
  });
}
```

Import `VerifyProviderError` from
`"../../../queries/provider/verify-provider.ts"`.

### `src/http/server/credential/verify-provider.test.ts` (new file)

Pattern follows `show-provider.test.ts` exactly (2 tests minimum).

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "../../../../test/helpers/app.ts";
import { VerifyProviderError } from "../../../queries/provider/verify-provider.ts";
import { verifyProviderHandler } from "./verify-provider.ts";
```

Fixture result:

```ts
const successResult = {
  checkedAt: 1_700_000_000_000,
  model: "gpt-4o",
  reachability: "reachable",
  authentication: "accepted",
  completed: true,
  refusal: null,
};
```

Test cases:

1. **POST /v1/provider/:id/verify answers 200** with the result and passes the
   parsed id and signal:

   ```ts
   let called: unknown = "not-called";
   const app = await createTestApp({
     handlers: {
       "provider.verify": verifyProviderHandler({
         verifyProvider: (input) => {
           called = input;
           return Promise.resolve(successResult);
         },
       }),
     },
   });
   const response = await app.post(
     "/v1/provider/provider_01HZY8QF3M4N5P6R7S8T9V0W1X/verify",
   );
   assert.equal(response.status, 200);
   assert.deepEqual(response.body, successResult);
   assert.deepEqual((called as any).id, "provider_01HZY8QF3M4N5P6R7S8T9V0W1X");
   ```

2. **VerifyProviderError not-found → 404**:

   ```ts
   const app = await createTestApp({
     handlers: {
       "provider.verify": verifyProviderHandler({
         verifyProvider: () =>
           Promise.reject(
             new VerifyProviderError(
               "not-found",
               "no provider provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
             ),
           ),
       }),
     },
   });
   const response = await app.post(
     "/v1/provider/provider_01HZY8QF3M4N5P6R7S8T9V0W1X/verify",
   );
   assert.equal(response.status, 404);
   assert.equal(response.body.error.code, "not-found");
   ```

3. **VerifyProviderError provider-not-verifiable → 400**:
   Handler rejects with `VerifyProviderError("provider-not-verifiable", ...)`.
   Assert `response.status === 400` and `response.body.error.code === "invalid-request"`.

4. **VerifyProviderError service-unavailable → 503**:
   Handler rejects with `VerifyProviderError("service-unavailable", ...)`.
   Assert `response.status === 503`.

### `src/http/server/credential/refusals.test.ts`

Add test cases for `VerifyProviderError`:

```ts
it("VerifyProviderError not-found → httpError not-found", () => {
  const err = new VerifyProviderError("not-found", "no provider x");
  const result = toHttpError(err);
  assert.equal(result.code, "not-found");
});

it("VerifyProviderError service-unavailable → httpError service-unavailable", () => {
  const err = new VerifyProviderError(
    "service-unavailable",
    "cannot decrypt x",
  );
  const result = toHttpError(err);
  assert.equal(result.code, "service-unavailable");
});

it("VerifyProviderError provider-not-verifiable → httpError invalid-request", () => {
  const err = new VerifyProviderError("provider-not-verifiable", "kind=git");
  const result = toHttpError(err);
  assert.equal(result.code, "invalid-request");
});
```

`HttpError` (from `src/http/contract/errors.ts:81-90`) exposes `code: ErrorCode`, not `kind`.
Use `result.code` in all refusal tests.

### `src/main.ts`

1. Add imports near the existing provider imports (around lines 40-60):

   ```ts
   import { verifyProvider } from "./queries/provider/verify-provider.ts";
   import { PiAiProviderAuth } from "./services/provider-auth/pi-ai.ts";
   import { verifyProviderHandler } from "./http/server/credential/verify-provider.ts";
   ```

2. Inside `serve()`, after `const catalog = new PiAiModelCatalog();` (~line 354):

   ```ts
   const providerAuth = new PiAiProviderAuth();
   ```

3. In the `handlers` object, after `"provider.show"` (~line 411):
   ```ts
   "provider.verify": verifyProviderHandler({
     verifyProvider: (input) => verifyProvider({ storage, crypto, providerAuth, clock }, input),
   }),
   ```

### `src/main.test.ts`

In the operation fixture map (around line 85), after `"provider.show"` (~line 85),
insert:

```ts
"provider.verify": {
  parameters: { id: missing("provider") },
  expect: 404,
},
```

The harness resolves the HTTP method from the registry (POST), builds the path using
the `parameters` map, and expects a 404 `not-found` response (because
`missing("provider")` is a non-existent provider id). No `body` field is needed
(the operation has no request schema). Verify against the `"provider.show"` entry
pattern at line 85 (`{ parameters: { id: missing("provider") }, expect: 404 }`).

## Constraints

- The handler is async (it calls `verifyProvider` which is async).
- `HandlerContext` has no `signal` field. The handler creates `AbortSignal.timeout(60_000)`.
  The inner probe uses `AbortSignal.any([outerSignal, AbortSignal.timeout(30_000)])`.
- `refusals.ts` re-throws anything it does not recognize (existing behavior unchanged).
- `main.ts` is the composition root: `PiAiProviderAuth` is instantiated there only.
- No import of `PiAiProviderAuth` in any file other than `main.ts`.

## Verify

```
node --test \
  src/http/server/credential/verify-provider.test.ts \
  src/http/server/credential/refusals.test.ts \
  src/main.test.ts
npm run verify
```

Proof: delivers `src/http/server/credential/verify-provider.test.ts`,
`src/http/server/credential/refusals.test.ts`, and `src/main.test.ts` (PASS EPIC-044).
`npm run verify` exits 0.
