# Story 2 — Probe implementation and test

Epic: `.agents/plan/epics/044-llm-credential-verification.md`
Depends on: Story 1 and Story 3 (verdict.ts must exist before probe compiles)

## Dispatch note

Story 3 (verdict.ts) must be completed and verified BEFORE this story is implemented.
The probe imports `toVerdict` from `./verdict.ts`.

## Change

### `src/services/provider-auth/pi-ai.ts` — add `PiAiProviderAuth`

Append to `pi-ai.ts` (after the `createStore` function from Story 1):

Additional imports at the top of `pi-ai.ts`:

```ts
import {
  builtinModels,
  getBuiltinModels,
  builtinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import type { Model, Api, Context } from "@earendil-works/pi-ai";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai/models";
```

Wait — `ModelsSimpleStreamOptions` is from `@earendil-works/pi-ai` root since
`models.ts` is re-exported. Import it as:

```ts
import type {
  Model,
  Api,
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
```

Add the constant and the class:

```ts
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_PROMPT = "What time is it?";
const PROBE_MAX_TOKENS = 16;

type PiAiProviderAuthDependencies = Readonly<{
  createTimeoutSignal: (milliseconds: number) => AbortSignal;
  createModels: typeof builtinModels;
}>;
```

```ts
export class PiAiProviderAuth implements ProviderAuth {
  readonly #fetch: typeof fetch;
  readonly #createTimeoutSignal: PiAiProviderAuthDependencies["createTimeoutSignal"];
  readonly #createModels: PiAiProviderAuthDependencies["createModels"];

  constructor(
    fetchImplementation: typeof fetch = fetch,
    dependencies: Partial<PiAiProviderAuthDependencies> = {},
  ) {
    this.#fetch = fetchImplementation;
    this.#createTimeoutSignal =
      dependencies.createTimeoutSignal ??
      ((milliseconds) => AbortSignal.timeout(milliseconds));
    this.#createModels = dependencies.createModels ?? builtinModels;
  }

  async probe(
    row: ProviderAuthRow,
    signal: AbortSignal,
  ): Promise<ProbeOutcome> {
    const providers = builtinProviders();
    const provider = providers.find((p) => p.id === row.vendorId);
    if (provider === undefined || provider.auth.apiKey === undefined) {
      throw new ProviderAuthError(
        "vendor-not-catalogued",
        `vendor ${row.vendorId} has no api-key auth in the pi-ai catalog`,
      );
    }

    const builtinModelList = getBuiltinModels(row.vendorId as BuiltinProvider);
    const builtinModel = builtinModelList.find(
      (m) => m.id === row.defaultModel,
    );
    if (builtinModel === undefined) {
      throw new ProviderAuthError(
        "vendor-not-catalogued",
        `model ${row.defaultModel} is not in the pi-ai catalog for ${row.vendorId}`,
      );
    }

    const probeModel: Model<Api> =
      row.baseUrl !== null
        ? { ...builtinModel, baseUrl: row.baseUrl }
        : builtinModel;

    const timeoutSignal = this.#createTimeoutSignal(PROBE_TIMEOUT_MS);
    const probeSignal = AbortSignal.any([signal, timeoutSignal]);

    const models = this.#createModels({
      credentials: createStore(row),
      authContext: defaultProviderAuthContext(),
    });

    const context: Context = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: PROBE_PROMPT }],
        },
      ],
    };

    const options: ModelsSimpleStreamOptions = {
      maxTokens: PROBE_MAX_TOKENS,
      signal: probeSignal,
      fetch: this.#fetch,
    };

    const result = await models.completeSimple(probeModel, context, options);

    const raw = toRawOutcome(result, probeSignal);
    return { model: row.defaultModel, ...toVerdict(raw) };
  }
}
```

Add the private helper function `toRawOutcome`:

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { toVerdict, type RawOutcome } from "./verdict.ts";

function toRawOutcome(
  result: AssistantMessage,
  signal: AbortSignal,
): RawOutcome {
  const stop = result.stopReason;
  if (stop === "stop" || stop === "length") {
    return { kind: "success" };
  }
  if (stop === "aborted" || signal.aborted) {
    return { kind: "abort" };
  }
  // stop === "error" — accept installed "STATUS: ..." and bracketed "[STATUS] ..."
  const match = result.errorMessage?.match(/^(?:\[(\d+)\]|(\d{3}):)/);
  const statusText = match?.[1] ?? match?.[2];
  const httpStatus =
    statusText === undefined ? undefined : parseInt(statusText, 10);
  if (httpStatus === undefined) {
    return { kind: "transport-error" };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "http-auth", status: httpStatus };
  }
  if (httpStatus === 404) {
    return { kind: "http-not-found", status: httpStatus };
  }
  if (httpStatus === 429) {
    return { kind: "http-quota", status: httpStatus };
  }
  return { kind: "http-other", status: httpStatus };
}
```

**Why `errorMessage` prefix parsing works**: pi-ai 0.84.1's openai adapters catch a
provider error with HTTP status and format the string with a decimal `STATUS:` prefix,
such as `401:`. This is internal behavior, not a documented contract. The parser also
accepts the bracketed `[STATUS]` form for compatibility. The `normalizeProviderError`
function probes `error.status` and `error.statusCode` fields set by the OpenAI SDK.

**Why `stream.result()` / `completeSimple` always resolves**: `AssistantMessageEventStream`
is constructed with `resolve`-only, no `reject`. Provider errors are pushed as
`{ type: "error" }` events; `result()` resolves with the error `AssistantMessage`
(not rejects). `completeSimple` calls `.result()`. Tests must assert `result.stopReason`
and must NOT use try/catch to detect provider errors.

### `src/services/provider-auth/pi-ai.test.ts` (new file)

Use `groq` as the test vendor and `llama-3.1-8b-instant` as the default model:

- `groq` exists in `builtinProviders()` with `auth.apiKey` defined.
- `llama-3.1-8b-instant` is in `getBuiltinModels('groq')` with `api: "openai-completions"`.
- This means the fake fetch needs to return a valid OpenAI Chat Completions SSE response.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PiAiProviderAuth } from "./pi-ai.ts";
import { ProviderAuthError } from "./index.ts";
import type { ProviderAuthRow } from "./index.ts";
```

Fixture row:

```ts
const row: ProviderAuthRow = {
  vendorId: "groq",
  defaultModel: "llama-3.1-8b-instant",
  apiKey: "gsk_test_probe_key_ABCDEFGH123456",
  baseUrl: null,
};
const SIGNAL = AbortSignal.timeout(30_000);
```

**Success fake fetch** — returns a valid Chat Completions SSE for `openai-completions`:

```ts
function successFetch(): typeof fetch {
  return async (_url, _init) => {
    const body = [
      'data: {"id":"chatcmpl-t","object":"chat.completion.chunk",' +
        '"choices":[{"delta":{"role":"assistant","content":"3"},"finish_reason":null,"index":0}],' +
        '"model":"llama-3.1-8b-instant"}',
      "",
      'data: {"id":"chatcmpl-t","object":"chat.completion.chunk",' +
        '"choices":[{"delta":{},"finish_reason":"stop","index":0}],' +
        '"model":"llama-3.1-8b-instant",' +
        '"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}
```

**Error fake fetch** — returns a non-2xx response that causes the OpenAI SDK to throw:

```ts
function errorFetch(status: number): typeof fetch {
  return async (_url, _init) => {
    return new Response(JSON.stringify({ error: { message: "error" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
```

**Recording fake fetch** — counts calls:

```ts
function recordingFetch(inner: typeof fetch): {
  fetch: typeof fetch;
  calls: number;
} {
  const rec = { fetch: inner as typeof fetch, calls: 0 };
  const wrapped: typeof fetch = async (url, init) => {
    rec.calls++;
    return inner(url, init);
  };
  rec.fetch = wrapped;
  return rec;
}
```

Test cases:

1. **Success → completed: true**:

   ```ts
   const rec = recordingFetch(successFetch());
   const auth = new PiAiProviderAuth(rec.fetch);
   const outcome = await auth.probe(row, SIGNAL);
   assert.deepEqual(outcome, {
     model: "llama-3.1-8b-instant",
     reachability: "reachable",
     authentication: "accepted",
     completed: true,
     refusal: null,
   });
   assert.equal("detail" in outcome, false);
   assert.equal(rec.calls, 1);
   ```

2. **401 → credential-rejected**:

   ```ts
   const outcome = await new PiAiProviderAuth(errorFetch(401)).probe(
     row,
     SIGNAL,
   );
   assert.deepEqual(outcome, {
     model: "llama-3.1-8b-instant",
     reachability: "reachable",
     authentication: "rejected",
     completed: false,
     refusal: "credential-rejected",
     detail: "HTTP 401",
   });
   ```

3. **403 → credential-rejected, detail: "HTTP 403"**: same shape with `detail: "HTTP 403"`.

4. **404 → model-unavailable**:

   ```ts
   assert.deepEqual(outcome, {
     model: "llama-3.1-8b-instant",
     reachability: "reachable",
     authentication: "accepted",
     completed: false,
     refusal: "model-unavailable",
     detail: "HTTP 404",
   });
   ```

5. **429 → quota-exceeded**:

   ```ts
   assert.deepEqual(outcome, {
     model: "llama-3.1-8b-instant",
     reachability: "reachable",
     authentication: "accepted",
     completed: false,
     refusal: "quota-exceeded",
     detail: "HTTP 429",
   });
   ```

6. **500 → endpoint-rejected**:

   ```ts
   assert.deepEqual(outcome, {
     model: "llama-3.1-8b-instant",
     reachability: "reachable",
     authentication: "unknown",
     completed: false,
     refusal: "endpoint-rejected",
     detail: "HTTP 500",
   });
   ```

7. **Network failure (fetch throws) → endpoint-unreachable**:

   ```ts
   const throwingFetch: typeof fetch = async () => {
     throw new TypeError("network failure");
   };
   const outcome = await new PiAiProviderAuth(throwingFetch).probe(row, SIGNAL);
   assert.deepEqual(outcome, {
     model: "llama-3.1-8b-instant",
     reachability: "unreachable",
     authentication: "unknown",
     completed: false,
     refusal: "endpoint-unreachable",
     detail: "transport-error",
   });
   ```

8. **Internal timeout signal → endpoint-unreachable**:

   Use a non-aborted caller signal and inject a timeout factory that records its argument, returns an
   `AbortController.signal`, and aborts that controller from a pending fetch double. The fetch double
   records the composed transport signal and rejects when it aborts. Assert the complete
   `endpoint-unreachable` / `timeout-or-abort` outcome, exactly one outbound call, the timeout factory
   argument `[30_000]`, the timeout signal is aborted, the composed transport signal is aborted, and the
   caller signal remains un-aborted. Do not advance timers or wait on wall-clock time.

9. **Unknown vendor → ProviderAuthError throws, zero fetch calls**:

   ```ts
   const rec = recordingFetch(successFetch());
   const badRow: ProviderAuthRow = {
     ...row,
     vendorId: "not-a-real-vendor-xyz",
   };
   await assert.rejects(
     () => new PiAiProviderAuth(rec.fetch).probe(badRow, SIGNAL),
     (err: unknown) => {
       assert(err instanceof ProviderAuthError);
       assert.equal(err.refusal, "vendor-not-catalogued");
       return true;
     },
   );
   assert.equal(rec.calls, 0);
   ```

10. **No api key in any outcome**: for each of the six response-level outcomes
    (tests 1–7), JSON.stringify the full outcome and assert it does NOT contain
    `"gsk_test_probe_key_ABCDEFGH123456"`. This assertion runs alongside each
    existing deepEqual.

11. **Empty reply text also counts as completed: true**: use success fake fetch that
    returns an SSE where the assistant delta content is `""` (empty string).
    Assert `outcome.completed === true` and `outcome.refusal === null`.

12. **Single-entry store isolation**: inject a `createModels` wrapper that captures `options.credentials`
    before delegating to `builtinModels(options)`. Probe two rows with `vendorId: "groq"` and distinct
    api keys. For each captured store, assert `list()` deep-equals
    `[{ providerId: "groq", type: "api_key" }]`, `read("groq")` returns that row's exact credential,
    `read("anthropic")` returns `undefined`, and `modify("anthropic", callback)` returns `undefined`
    without invoking its callback. Assert that neither store returns the other row's key. This tests
    the real private `createStore` result without exporting it.

13. **pi-ai error format pin**: this test does NOT go through `probe()`. It calls
    `models.completeSimple()` directly with a 401-returning fake fetch and asserts
    the `errorMessage` prefix shape. The test lives in the same `pi-ai.test.ts` file
    under a `describe("pi-ai error format contract", ...)` block:
    ```ts
    import { builtinModels } from "@earendil-works/pi-ai/providers/all";
    import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
    import type { Context, Model, Api } from "@earendil-works/pi-ai";

    const groqModel = getBuiltinModels("groq").find(
      (m) => m.id === "llama-3.1-8b-instant",
    )! as Model<Api>;
    const probeContext: Context = {
      messages: [
        { role: "user", content: [{ type: "text", text: "What time is it?" }] },
      ],
    };
    ```

it("pi-ai formats a 401 provider error with a 401: prefix in errorMessage", async () => {
const fakeFetch: typeof fetch = async () =>
new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
status: 401,
headers: { "Content-Type": "application/json" },
});
const models = builtinModels({
credentials: {
async read() {
return { type: "api_key" as const, key: "sk-pin-test" };
},
async list() {
return [];
},
async modify(_id, fn) {
return fn({ type: "api_key" as const, key: "sk-pin-test" });
},
async delete() {},
},
authContext: defaultProviderAuthContext(),
});
const result = await models.completeSimple(groqModel, probeContext, {
maxTokens: 1,
fetch: fakeFetch,
});
assert.equal(result.stopReason, "error");
assert(
result.errorMessage?.startsWith("401:"),
`expected errorMessage to start with "401:" but got: ${result.errorMessage}`,
);
});
```
If a pi-ai upgrade changes `formatProviderError` so it no longer emits the `STATUS:`
prefix, this test fails before any probe test does, surfacing the contract break at
upgrade time instead of silently misreporting every non-2xx verdict.

## Constraints

- No real network. Every test injects a `fetch` double.
- `completeSimple()` always resolves. Tests assert on `outcome` fields, never try/catch
  for provider HTTP errors.
- Every outcome `assert.deepEqual` comparison covers the entire outcome object. No field-by-field
  checking (except the key-absence assertion).
- The `groq` vendor MUST be used for all probe tests. Do not use `openai` (whose models
  use `openai-responses` api format, incompatible with the Chat Completions SSE fixture).
- `SIGNAL` uses `AbortSignal.timeout(30_000)` — long enough not to fire during tests. The timeout test
  injects `createTimeoutSignal`, aborts its returned signal from the pending transport double, and does
  not advance timers or wait on wall-clock time.
- The `model` field on every outcome is exactly `row.defaultModel`.

## Verify

```
node --test src/services/provider-auth/pi-ai.test.ts
npm run lint -- --quiet
```

`pi-ai.test.ts` contains thirteen tests: twelve probe and adapter tests (cases 1–12) and one
format-pin test (case 13). The format-pin test asserts `result.errorMessage.startsWith("401:")`
against the installed library's live behavior. A pi-ai upgrade that changes
`formatProviderError`'s prefix syntax will fail this test before any probe-outcome test
does.

Proof: delivers `src/services/provider-auth/pi-ai.test.ts` (PASS EPIC-044).
