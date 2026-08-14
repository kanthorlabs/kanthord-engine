# EPIC 102 — Provider transport on `pi-ai` — stories

Epic: `.agent/plan/epics/102-provider-transport.md`
Prereq: EPIC 101 (sequence order).

One model call reaches a real provider through a stored `kind = 'llm'` registration, behind the new `model` capability.

## Dispatch order

Run Stories 1 and 11 as one coupled pair, in that order, with no full gate between them: `src/services/model/` breaks the service-directory assertion of `src/domain/layout.test.ts:101-125` the moment it exists, and Story 11 restores it.

Then run **Story 7 Part A** (the `clock` capability only), then Story 3; each passes the full gate on its own.

Then run Stories 9, 2, 4, 5, 6, **Story 7 Part B** and 8 as one coupled unit, in that order, with no full gate between them. They are facets of one class: `PiAi` cannot satisfy `implements Model` until the stream loop, the deadline and the result assembly all exist. Story 8 closes the unit and runs the gate.

Story 7 is split because its clock half stands alone and its adapter half edits `src/services/model/pi-ai.ts`, which Story 2 creates. Dispatching all of Story 7 early would edit a file that does not exist and would use test helpers Story 9 has not written.

Then run Story 10.

## Stories

- 1 — Declare the `model` capability interface → `01-model-capability-interface.md`
- 2 — Open a registration to a variant, a credential and a base url → `02-registration-opens-to-provider.md`
- 3 — Deny an ambient credential in the pi-ai collection → `03-models-collection-denies-ambient.md`
- 4 — Build the request shape → `04-request-shape.md`
- 5 — Stream, and refuse a stream with no terminal event → `05-streaming-and-incomplete-stream.md`
- 6 — Map tool calls → `06-tool-calls.md`
- 7 — Give the deadline one owner (Part A clock, Part B adapter) → `07-deadline-has-one-owner.md`
- 8 — Handle a truncated response and a provider failure → `08-truncation-and-provider-failure.md`
- 9 — Write the mock transport and the manual deadline → `09-mock-transport-and-manual-deadline.md`
- 10 — Construct the adapter in the daemon and report it → `10-daemon-constructs-and-reports.md`
- 11 — Update the layout and the vendor boundary → `11-layout-and-vendor-boundary.md`

## Vendor version (decided, verified)

This epic targets `@earendil-works/pi-ai` **0.84.1**. All three `@earendil-works` packages moved from `0.80.6` to `0.84.1` together, because `pi-coding-agent` of EPIC 106 travels with `pi-ai`. `npm run verify` passes on the upgrade; no `src/` file imported these packages before this epic.

The upgrade resolved the earlier blocker and changed four story facts. Every claim below was verified by running it against the installed package on the real nested `lazyApi` topology, not by reading:

- **An iteration throw is fixed.** `forwardStream` is now `async` and `lazyStream` returns its promise from `.then`, so the rejection chains into the existing `.catch` and arrives as a terminal `error` event. Result `["start","error"]`, zero unhandled rejections. Stories 8 and 9 therefore need no `Models` double, and every case runs on the real collection.
- **A stream that ends with no terminal event now hangs.** `forwardStream` ends with `target.end(hasResult(source) ? await source.result() : undefined)`, and `result()` never settles without a terminal event. This holds for a plain async iterable too, because the `lazyApi` layer converts it to an event stream first. On `0.80.6` this case ended cleanly; on `0.84.1` it does not.
- **`model-stream-incomplete` is therefore removed.** kanthord cannot observe that state, so the code would be unreachable. The error union holds nine codes, and the deadline reports `model-timeout` for a stream that never ends.
- **`done.reason` gains `"deferred"`.** `ModelStop` keeps three values, and Story 8 refuses a deferred answer as `model-failed`. No api implementation of 0.84.1 emits it on a plain stream; it arrives only through `fetchDeferred`, which kanthord never calls.

Story 7's deadline preemption is the mechanism that makes the second point safe, and it is version-independent by construction.

## Facts (needed for implementation)

- Greenfield: `src/services/model/` does not exist, and no file under `src/`, `test/` or `scripts/` imports `@earendil-works` today. `@earendil-works/pi-ai` is already a dependency at `package.json:54`, pinned to `0.84.1`.
- `deserializePayload` returns the `ProviderPayload` union (`src/domain/provider-payload.ts:161-164`); only `parsePayload` carries the `"llm"` overload (`:88-93`). Narrow with `as LlmPayload`, and edit no domain file.
- `Crypto.open` is synchronous and throws `CryptoError` (`src/services/crypto/index.ts:22`). `SealedPayload` fields are `ciphertext`, `iv`, `tag`, `keyVersion` (`:1-6`).
- `ProviderRow` supplies `payloadCiphertext`, `payloadIv`, `payloadTag`, `keyVersion` and `kind` (`src/domain/provider.ts:6-21`).
- `EventStream.push` sets `done = true` on a `done` or `error` event (`node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js:17-23`), so the async iterator ends by itself and a terminating mock script must not also call `end()`.
- `EventStream.end()` with no argument leaves `finalResultPromise` unsettled (`dist/utils/event-stream.js:33-43`), and `forwardStream` calls exactly that when the inner stream exhausts (`dist/api/lazy.js:22-29`). `Models.complete` is `stream(...).result()` (`dist/models.js:110-112`), so awaiting the result hangs where iterating refuses. This is why the adapter iterates.
- `ModelsImpl.stream` always wraps the provider in `lazyStream`, and every built-in provider declares `api` as a `lazyApi`, so **two** `forwardStream` bridges sit between kanthord and a transport. `createMockModels` must reproduce that nesting.
- A transport that throws, synchronously or while iterating, surfaces as a terminal `error` event. Neither is a synchronous throw at the `models.stream` call site, though the adapter still guards that site so the mapping is total.
- A stream that ends with no terminal event never ends the outer stream, so only the deadline preemption of Story 7 leaves the loop. The no-terminal branch reports `model-timeout` or `model-cancelled`.
- An abort may end the provider stream or emit a terminal `error` of `reason: "aborted"`. The `outcome` flag decides the code in both branches.
- `lazyStream` resolves setup on a microtask, so a deadline expired synchronously by a test fires before the transport is called. The `waitForAbort` mock must handle an already-aborted signal.
- The adapter still checks `getProvider` and `getModel` itself, so it refuses before any stream opens.
- `applyAuth` rebuilds the options object as `{ ...options, apiKey, headers, env }`, so the captured options carry `headers` and `env` keys of value `undefined`. It adds no `timeoutMs`, so the `Object.hasOwn(options, "timeoutMs") === false` assertion holds.
- `Models.stream` of 0.84.1 takes `ModelsApiStreamOptions<TApi> = ApiStreamOptions<TApi> & ModelsRequestTransforms` (`dist/models.d.ts:45`). `transformHeaders` is optional, so the Story 4 options literal still typechecks unchanged.
- `CreateModelsOptions` of 0.84.1 gains an optional `modelsStore`; Story 3 passes `credentials` and `authContext` only, which remains valid.
- `getAuth` is now overloaded on `providerId` or `model` with optional overrides. Story 3's `getAuth(getBuiltinModel(...))` call still resolves, and both `anthropic/claude-haiku-4-5` and `openai/gpt-4.1` remain in the catalogue. Ambient denial still yields `undefined` for both, with 40 providers registered.
- `Model` requires `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens` (`dist/types.d.ts:581-600`). `Api` and `ProviderId` are open unions (`:14,18`), so `"mock-api"` and `"mock-provider"` typecheck.
- `done.reason` is `"stop" | "length" | "toolUse"`; `error.reason` is `"aborted" | "error"` (`dist/types.d.ts:382-388`).
- `Usage` carries `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost` as required, plus optional `reasoning` and `cacheWrite1h` (`dist/types.d.ts:248-269`).
- `AuthContext` requires async `env` and `fileExists` (`dist/auth/types.d.ts:61-65`). `resolveProviderAuth` reads ambient sources only through it (`dist/auth/resolve.js:15-37`), and falls back to `apiKey.resolve({ credential: undefined })` only when the credential store is empty.
- `builtinModels(options?: CreateModelsOptions): MutableModels` and `getBuiltinModel(provider, modelId)` come from `@earendil-works/pi-ai/providers/all` (`dist/providers/all.d.ts:9,15`). `anthropic/claude-haiku-4-5` and `openai/gpt-4.1` both exist in the generated catalogue.
- `src/main.ts:200-208` builds `reporters` and `:209-212` constructs `crypto` immediately after, so Story 10 reverses that order.
- `src/queries/system/read-health.ts:32-34` already sorts dependency lines bytewise and `:25-29` already turns a throwing probe into `"failed"`. No edit.
- `src/http/contract/system.ts:18-26` types the dependency `name` as `z.string().min(1)`, and `system.health` is already `routed` (`:140-148`). No contract or schema change.
- `src/domain/layout.test.ts:159-175` asserts no `src/services/*/index.ts` contains the string `"implements "`. `:144-157` requires a `not-implemented.ts` for `agent`, `verify` and `lease` only.
- `lintCase` (`test/helpers/lint.ts:7-26`) lints virtual text at a given path; the file need not exist, so Story 11 can assert against `src/services/model/pi-ai.ts` before it is written.
- Flat config resolves `no-restricted-imports` by last match, never by union (`eslint.config.js:204-207`), so the new service-interface block repeats the `gitLibraries` and `node:child_process` entries.
- `createMockClock({ start: 1700000000000, step: 0 })` is at `test/helpers/clock.ts:5` and gives the fixed `timestamp` the request-shape assertions need.
- A direct `node --test` command carries no timeout. Every command in these stories passes `--test-timeout=60000`, matching the `test` script of `package.json`, so a deadline or stream defect fails the run instead of hanging it.
- Hermetic coverage lines are traced at clause level, not line level. Lines 54, 73 and 80 each split across stories, and the owning story names its clause.
