# Story 9 — The hand-written mock transport, and the manual deadline

Epic: `.agents/plan/epics/102-provider-transport.md`
Depends on: Story 1 and Story 7.

## Change

- Declare `createMockTransport`, `createMockModels` and `createManualDeadline` at the top of `src/services/model/pi-ai.test.ts`. Put them in no other file.
- `createMockTransport` returns an object implementing `ProviderStreams` of `@earendil-works/pi-ai` — exactly the two methods `stream(model, context, options)` and `streamSimple(model, context, options)`, both returning an `AssistantMessageEventStream` synchronously. It also exposes `calls`, an array of the captured `{ model, context, options }` of every `stream` call, so a test reads `transport.calls.length` and `transport.calls[0]`.
- `createMockTransport` takes one script argument that selects the event sequence. Support exactly these six scripted behaviours, because the tests of Stories 2 and 4 through 8 need no others:
  - `events`: push each supplied `AssistantMessageEvent` in order, synchronously, before returning the stream. A terminating script must not call `end()`.
  - `endWithoutTerminal`: push `{ type: "start", partial: <the terminal message fixture> }`, then call `stream.end()` with no argument.
  - `plainIterableNoTerminal`: return a plain object whose `[Symbol.asyncIterator]` yields one `start` event and then completes, holding no `result` method.
  - `throwSync`: throw before returning a stream.
  - `throwWhileIterating`: return a plain object whose `[Symbol.asyncIterator]` yields one `start` event and then throws.
  - `waitForAbort`: push nothing. If `options.signal.aborted` is already `true`, set `abortObserved = true` and call `stream.end()` with no argument at once. Otherwise add an `abort` listener with `{ once: true }` that sets `abortObserved = true` and calls `stream.end()` with no argument. A test reads `transport.abortObserved`.
- Write no `Models` double. On `pi-ai` 0.84.1 both throw scripts reach `PiAi` as a terminal `error` event through the real collection, so `createMockModels` covers every case of Stories 2 and 4 through 8.
- Declare `createMockCrypto(mode: "open" | "throw"): Crypto` of `src/services/crypto/index.ts`. `seal` throws `new Error("not used")`. Under `"open"`, `open` returns the JSON text of the payload the test names. Under `"throw"`, `open` throws `new CryptoError("crypto-authentication-failed", "…")`, which is the corrupted-`payloadTag` case of Story 2. Do not import `AesGcmCrypto`; a test reaches an implementation only in the capability it covers.
- Declare `createRegistration(overrides)`, returning a `ProviderRow` (`src/domain/provider.ts:6-21`) with `id: "provider_a"`, `name: "mock"`, `kind: "llm"`, `setDefaultAt: null`, `payloadCiphertext: new Uint8Array([1])`, `payloadIv: new Uint8Array(12)`, `payloadTag: new Uint8Array(16)`, `keyVersion: 1`, `updatedAt: 1`. The corrupted case passes `payloadTag: new Uint8Array(16)` with `createMockCrypto("throw")`.
- Declare `createRequest(overrides)`, returning a `ModelRequest` with `registration: createRegistration({})`, `model: null`, `systemPrompt: null`, `messages: [{ role: "user", text: "hi" }]`, `tools: []`, `maxOutputTokens: null`, `timeoutMs: 5000`, `signal: null`, `onTextDelta: null`. Every test names only the fields it changes.
- `createManualDeadline` returns an object implementing `Deadline` of `src/services/clock/index.ts` plus the armed entries. `arm(delayMs, onExpire)` appends `{ delayMs, onExpire, disarmed: false }` to a public `armed` array and returns a function that sets `disarmed = true`. It exposes `expire(index)`, which calls the entry's `onExpire` by one synchronous call. It reads no wall clock and creates no timer.
- `createMockModels` builds the collection the adapter is driven through:
  - Call `createProvider` with `id: "mock-provider"`, `auth: { apiKey: <the hand-written ApiKeyAuth> }`, `api: lazyApi(async () => <the mock transport>)`, and `models: [<the mock model>]`.
  - The hand-written `ApiKeyAuth` is `{ name: "mock", resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }) }`. It reads no environment.
  - The mock model is exactly:

    ```ts
    {
      id: "mock-model",
      name: "mock-model",
      api: "mock-api",
      provider: "mock-provider",
      baseUrl: "https://mock.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    }
    ```

  - Register the provider with `setProvider` on `createModels({ authContext: { env: async () => undefined, fileExists: async () => false } })`, and return the collection.
- Declare one terminal-message fixture helper in the same file that builds an `AssistantMessage` with `api: "mock-api"`, `provider: "mock-provider"`, `model: "mock-model"`, `timestamp: 1700000000000`, and the `content`, `usage` and `stopReason` a test names. `usage` defaults to all zeros with a zeroed `cost`.
- The absent-usage case of Story 5 needs a message with no `usage` key, which the vendor type declares as required (`dist/types.d.ts:276-289`). Build it by constructing the fixture and then `delete`-ing the key behind one `as unknown as AssistantMessage` cast, in the fixture helper and nowhere else. Do not make `usage` optional anywhere in kanthord.

## Constraints

- No file under `test/helpers/` may contain the string `"@earendil-works"`. A shared helper coupled to a vendor type crosses the import matrix; these helpers stay in `src/services/model/pi-ai.test.ts`.
- Do not use `fauxProvider` of `@earendil-works/pi-ai/providers/faux`. A `FauxResponseStep` is an `AssistantMessage`, so it cannot script a stream that ends with no terminal event or one that blocks until an abort.
- `push` of a `done` or `error` event already sets the stream `done` (`node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`), so a terminating script must not also call `end()`; only `endWithoutTerminal` and `waitForAbort` call it.
- `ProviderStreams` of 0.84.1 adds optional `fetchDeferred` and `cancelDeferred` (`dist/types.d.ts:191-192`). Both are optional, so the mock still satisfies the interface with `stream` and `streamSimple` alone. Declare neither.
- The three scripts that return a plain object rather than an `AssistantMessageEventStream` are legal: `forwardStream` accepts any async iterable, and the `lazyApi` layer wraps the result in an event stream regardless.
- `createProvider` requires `id`, `auth`, `models` and `api` (`node_modules/@earendil-works/pi-ai/dist/models.d.ts:95-115`). It selects the single-implementation form by `typeof input.api.stream === "function"` (`dist/models.js:137`), so the transport object must carry `stream` as an own function property.
- `Model` requires `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, `input`, `cost`, `contextWindow` and `maxTokens` (`dist/types.d.ts:581-600`). Supply every one; the literals above are the fixture.
- `Api` and `ProviderId` are open unions (`dist/types.d.ts:14,18`), so `"mock-api"` and `"mock-provider"` typecheck.
- `createMockModels` registers the provider with `api: lazyApi(async () => <the transport>)`, importing `lazyApi` from `@earendil-works/pi-ai`, and never with the transport directly. Every built-in provider of 0.84.1 declares `api` as a `lazyApi`, so a test that omits it exercises a shallower topology than production and misses the nested `forwardStream` that decides the no-terminal and throw outcomes.
- The `waitForAbort` transport must handle an already-aborted signal, because `lazyStream` resolves its setup on a microtask: a deadline the test expires synchronously fires before the transport is ever called.
- These are Mocks, not Fakes: each returns the deterministic value a story names.

## Verify

- The helpers carry no test of their own. They are exercised by every test of Stories 2 and 4 through 8 in the same file.
- Run `node --test --test-timeout=60000 src/services/model/pi-ai.test.ts`; it exits 0 at the end of the coupled unit.
- Add to `src/domain/layout.test.ts` one test named `no file under test/helpers/ names the pi-ai package`, which walks `test/helpers/` with the existing `walkFiles` helper (`src/domain/layout.test.ts:33-41`) and asserts no file content includes `"@earendil-works"`.
- Proof: `PASS EPIC-102`, and Hermetic coverage line 81.
