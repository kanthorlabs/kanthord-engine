# Story 4 — The request shape

Epic: `.agent/plan/epics/102-provider-transport.md`
Depends on: Story 2 (step 9 of the pipeline).

## Change

- In `src/services/model/pi-ai.ts`, build one `Context` and one `StreamOptions`, then call `this.dependencies.models.stream(requestModel, context, options)`.
- Build `Context` as a mutable object literal assembled in this order:
  - `systemPrompt` is present only when `request.systemPrompt !== null`. Add the key conditionally; never assign `undefined`.
  - `messages` maps `request.messages` in order. Each mapped message stamps `timestamp: this.dependencies.clock.now()`, called once per message, in message order.
    - `role: "user"` maps to `{ role: "user", content: [{ type: "text", text: message.text }], timestamp }`.
    - `role: "assistant"` maps to `{ role: "assistant", content: [{ type: "text", text: message.text }], timestamp }` plus the fields `AssistantMessage` requires: `api: requestModel.api`, `provider: requestModel.provider`, `model: requestModel.id`, `usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }`, `stopReason: "stop"`.
    - `role: "toolResult"` maps to `{ role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName, content: [{ type: "text", text: message.text }], isError: message.isError, timestamp }`.
  - `tools` is present only when `request.tools.length > 0`. Story 6 pins the mapping.
- Build `StreamOptions` as exactly `{ apiKey: payload.apiKey, signal: controller.signal, maxRetries: 0, maxTokens: request.maxOutputTokens ?? undefined }`, where `controller` is the per-call `AbortController` of Story 7. Set no other key.
- Call `models.stream`, never `models.streamSimple` and never `models.complete`.

## Constraints

- `Context.messages` is typed `Message[]` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:323-327`), so build an array, not a readonly tuple.
- `UserMessage`, `AssistantMessage` and `ToolResultMessage` each require `timestamp` (`types.d.ts:271-298`). `AssistantMessage` additionally requires `api`, `provider`, `model`, `usage` and `stopReason`; supply the literals above so the mapped history typechecks.
- `StreamOptions.timeoutMs` must be absent. Story 7 gives the deadline one owner. `Object.hasOwn(options, "timeoutMs")` must be `false`, so do not write `timeoutMs: undefined`.
- Set no `temperature`. No named source asks for one.
- `maxTokens: undefined` is written as a key whose value is `undefined`; that is intended and differs from the `timeoutMs` rule, which forbids the key entirely.

## Verify

- In `src/services/model/pi-ai.test.ts`, add tests under a mock clock of `createMockClock({ start: 1700000000000, step: 0 })` from `test/helpers/clock.ts`, asserting:
  - A payload of `provider: "mock-provider"`, `apiKey: "sk-secret-value"`, `defaultModel: "mock-model"`, `baseUrl: null` reaches the transport with `captured.options.apiKey === "sk-secret-value"`, `captured.options.maxRetries === 0`, `Object.hasOwn(captured.options, "timeoutMs") === false`, and `captured.options.signal instanceof AbortSignal`.
  - A request of `systemPrompt: "sys"`, one `user` message `"hi"` and one tool `{ name: "t", description: "d", parameters: { type: "object", properties: {} } }` reaches the transport with `captured.context` deep-equal to `{ systemPrompt: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1700000000000 }], tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] }`.
  - A request with `tools: []` reaches the transport with `Object.hasOwn(captured.context, "tools") === false`.
  - A request with `systemPrompt: null` reaches the transport with `Object.hasOwn(captured.context, "systemPrompt") === false`.
  - A request carrying one `toolResult` message reaches the transport with that message deep-equal to `{ role: "toolResult", toolCallId: "call-1", toolName: "t", content: [{ type: "text", text: "out" }], isError: false, timestamp: 1700000000000 }`.
- Run `node --test --test-timeout=60000 src/services/model/pi-ai.test.ts`; it exits 0 at the end of the coupled unit.
- Proof: `PASS EPIC-102`, and Hermetic coverage lines 50, 52 and 53.
