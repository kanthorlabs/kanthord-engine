# Story 1 — The `model` capability interface

Epic: `.agent/plan/epics/102-provider-transport.md`
Depends on: EPIC 101.

## Change

- Create `src/services/model/index.ts`. It declares types and one interface. It imports `ProviderRow` from `../../domain/provider.ts` and `DependencyStatus` from `../../domain/health.ts`, both as types. It names no vendor package.
- Declare `ModelMessage` as a union over `role`:
  - `Readonly<{ role: "user"; text: string }>`
  - `Readonly<{ role: "assistant"; text: string }>`
  - `Readonly<{ role: "toolResult"; toolCallId: string; toolName: string; text: string; isError: boolean }>`
- Declare `ModelTool` as `Readonly<{ name: string; description: string; parameters: Readonly<Record<string, unknown>> }>`.
- Declare `ModelRequest` as `Readonly<{ registration: ProviderRow; model: string | null; systemPrompt: string | null; messages: readonly ModelMessage[]; tools: readonly ModelTool[]; maxOutputTokens: number | null; timeoutMs: number; signal: AbortSignal | null; onTextDelta: ((delta: string) => void) | null }>`.
- Declare `ModelStop` as `"stop" | "length" | "toolUse"`.
- Declare `ModelToolCall` as `Readonly<{ id: string; name: string; arguments: Readonly<Record<string, unknown>> }>`.
- Declare `ModelUsage` as `Readonly<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number }>`.
- Declare `ModelResult` as `Readonly<{ provider: string; model: string; stop: ModelStop; text: string; toolCalls: readonly ModelToolCall[]; usage: ModelUsage }>`.
- Declare `ModelErrorCode` as a union of exactly these nine literals, in this declaration order: `"request-invalid"`, `"registration-kind-invalid"`, `"credential-unreadable"`, `"provider-unknown"`, `"model-unknown"`, `"model-timeout"`, `"model-cancelled"`, `"model-failed"`, `"callback-failed"`. There is no `model-stream-incomplete`; see the Constraints.
- Export `modelErrorMessages` as `Object.freeze({ ... })` typed `Readonly<Record<ModelErrorCode, string>>`, with its keys written in the same nine-literal order and exactly these values:
  - `"request-invalid"`: `"the model request is invalid"`
  - `"registration-kind-invalid"`: `"the registration is not a kind llm registration"`
  - `"credential-unreadable"`: `"the stored provider payload cannot be opened"`
  - `"provider-unknown"`: `"the payload names a provider that is not registered"`
  - `"model-unknown"`: `"the provider does not hold the requested model"`
  - `"model-timeout"`: `"the model call passed its timeout"`
  - `"model-cancelled"`: `"the model call was cancelled"`
  - `"model-failed"`: `"the model call failed"`
  - `"callback-failed"`: `"the text delta callback threw"`
- Export `class ModelError extends Error` with `readonly code: ModelErrorCode` and `constructor(code: ModelErrorCode)`. The body runs exactly three statements in this order: `super(modelErrorMessages[code]);`, `this.name = "ModelError";`, `this.code = code;`. It declares no other field.
- Declare `export interface Model` with exactly two members: `complete(request: ModelRequest): Promise<ModelResult>;` and `probe(): DependencyStatus;`.

## Constraints

- No field of `ModelRequest`, `ModelResult` or `ModelTool` is optional. A `null` states the absence.
- `ModelError` carries `code` and nothing else. Do not add a `cause`, a `detail`, a `provider` field or an upstream message field; `src/domain/layout.test.ts:73` of the EPIC Proof asserts the own-property list.
- The file must not contain the string `"implements "`. `src/domain/layout.test.ts:159-175` asserts no `src/services/*/index.ts` contains it.
- Follow the shape of `src/services/agent/index.ts:23-30`, except that `ModelError` takes its message from `modelErrorMessages` rather than from a caller argument.
- Add no `model-stream-incomplete` code. On `pi-ai` 0.84.1 a provider stream that ends with no terminal event never ends the outer stream, so `PiAi` cannot observe that state; the deadline observes it and reports `model-timeout`. A code kanthord cannot reach is dead code.
- Keep `ModelStop` at exactly three values. `done.reason` of 0.84.1 also admits `"deferred"`, which Story 8 refuses as `model-failed` rather than modelling.
- Create no implementation file in this story.

## Verify

- Add `src/services/model/index.test.ts`, suite name `src/services/model/index.test`, asserting:
  - `Object.keys(modelErrorMessages)` deep-equals `["request-invalid", "registration-kind-invalid", "credential-unreadable", "provider-unknown", "model-unknown", "model-timeout", "model-cancelled", "model-failed", "callback-failed"]`.
  - `Object.getOwnPropertyNames(new ModelError("model-failed"))` deep-equals `["stack", "message", "name", "code"]`.
  - `new ModelError("model-failed").message === modelErrorMessages["model-failed"]`, and `new ModelError("model-timeout").code === "model-timeout"`.
  - `Object.isFrozen(modelErrorMessages) === true`.
- Run `node --test --test-timeout=60000 src/services/model/index.test.ts`; it exits 0.
- `npm run verify` exits 0 only after Story 11 updates `src/domain/layout.test.ts`. Run the full gate at the end of the Story 1 + Story 11 pair, not between them.
- Proof: `PASS EPIC-102` for `src/services/model/*.test.ts`, and Hermetic coverage lines 73 and 80.
