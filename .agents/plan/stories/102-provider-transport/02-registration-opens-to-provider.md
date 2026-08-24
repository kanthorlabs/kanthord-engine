# Story 2 — The registration opens to a variant, a credential and a base url

Epic: `.agents/plan/epics/102-provider-transport.md`
Depends on: Story 1, Story 7 (`Deadline`), Story 9 (the test helpers).

## Change

- Create `src/services/model/pi-ai.ts`, exporting `class PiAi implements Model`.
- Declare `export type PiAiDependencies = Readonly<{ crypto: Crypto; clock: Clock; deadline: Deadline; models: Models }>`, where `Crypto` comes from `../crypto/index.ts`, `Clock` and `Deadline` from `../clock/index.ts`, and `Models` from `@earendil-works/pi-ai`. The constructor takes one `PiAiDependencies` and stores it in a private readonly field.
- Implement `probe(): DependencyStatus` as `this.dependencies.models.getProviders().length > 0 ? "ok" : "failed"`. Story 10 asserts it.
- Implement `complete(request: ModelRequest): Promise<ModelResult>` as this exact ordered pipeline. Later stories fill steps 8 through 11; this story owns steps 1 through 7 and the refusal helper.
  1. Validate the request; refuse `request-invalid`. Story 8 pins the rules.
  2. If `request.signal !== null && request.signal.aborted`, refuse `model-cancelled`. Story 7 owns this line.
  3. If `request.registration.kind !== "llm"`, refuse `registration-kind-invalid`.
  4. Call `this.dependencies.crypto.open({ ciphertext: request.registration.payloadCiphertext, iv: request.registration.payloadIv, tag: request.registration.payloadTag, keyVersion: request.registration.keyVersion })`, then `deserializePayload("llm", text)` from `../../domain/provider-payload.ts`. Wrap both calls in one `try`; any throw refuses `credential-unreadable`. Narrow the result with `as LlmPayload`.
  5. `const found = this.dependencies.models.getProvider(payload.provider)`; `found === undefined` refuses `provider-unknown`.
  6. `const effectiveModel = request.model ?? payload.defaultModel`; `const foundModel = this.dependencies.models.getModel(payload.provider, effectiveModel)`; `foundModel === undefined` refuses `model-unknown`.
  7. `const requestModel = payload.baseUrl === null ? foundModel : { ...foundModel, baseUrl: payload.baseUrl }`.
  8. Arm the deadline and the abort listener. Story 7.
  9. Build the `Context` and the `StreamOptions` and call `models.stream`. Story 4.
  10. Iterate the stream and assemble the result. Stories 5 and 6.
  11. Disarm in a `finally`. Story 7.
- Set `ModelResult.provider` to `payload.provider` and `ModelResult.model` to `effectiveModel`.
- Add one private helper `private refuse(code: ModelErrorCode): never { throw new ModelError(code); }`. It takes no other argument. Every refusal in the file goes through it.

## Constraints

- `deserializePayload` has no `"llm"` overload (`src/domain/provider-payload.ts:161-164` returns the `ProviderPayload` union, unlike `parsePayload` at `:88-93`). Narrow with `as LlmPayload`; add no overload to `src/domain/provider-payload.ts`.
- Do not attach a `cause` and do not read `CryptoError.code` or `PayloadError.refusal`. Both become `credential-unreadable`.
- Step 7 must not mutate `foundModel`. The collection entry keeps its own `baseUrl`.
- `PiAi` persists nothing, opens no storage transaction and appends no event.
- `src/services/model/pi-ai.ts` is an implementation, so it may name `@earendil-works/pi-ai`. `src/services/model/index.ts` may not.

## Verify

- In `src/services/model/pi-ai.test.ts`, build every case from the Story 9 helpers `createRegistration`, `createRequest`, `createMockCrypto`, `createMockModels`, `createMockTransport` and `createManualDeadline`. Import no crypto implementation. Add tests asserting:
  - A registration of `kind: "git"` rejects with `code === "registration-kind-invalid"`, and the mock transport recorded zero calls.
  - A registration whose `payloadTag` is sixteen zero bytes, under `createMockCrypto("throw")`, rejects with `code === "credential-unreadable"`, and the transport recorded zero calls.
  - A `crypto.open` that returns text failing `deserializePayload`, such as `"{}"`, also rejects with `code === "credential-unreadable"`, so both the `CryptoError` and the `PayloadError` path give one code.
  - A payload of `provider: "absent-provider"` rejects with `code === "provider-unknown"`.
  - A payload of `provider: "mock-provider"` called with `model: "absent-model"` rejects with `code === "model-unknown"`.
  - A payload of `defaultModel: "mock-model"` called with `model: null` reaches the transport with `captured.model.id === "mock-model"` and gives `result.model === "mock-model"`.
  - A payload of `baseUrl: null` reaches the transport with `captured.model.baseUrl === "https://mock.invalid"`.
  - A payload of `baseUrl: "https://override.invalid"` reaches the transport with `captured.model.baseUrl === "https://override.invalid"`, and `models.getModel("mock-provider", "mock-model")?.baseUrl` still equals `"https://mock.invalid"`.
  - A successful call gives `result.provider === "mock-provider"`.
  - Every rejection above satisfies `error.message === modelErrorMessages[error.code]`.
- Run `node --test --test-timeout=60000 src/services/model/pi-ai.test.ts`; it exits 0 at the end of the coupled unit.
- Proof: `PASS EPIC-102`, and Hermetic coverage lines 51, 68, 69, 70, 71 and the `result.provider` clause of line 54.
