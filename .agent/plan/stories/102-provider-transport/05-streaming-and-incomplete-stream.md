# Story 5 — Streaming, and a stream that stops without a terminal event

Epic: `.agent/plan/epics/102-provider-transport.md`
Depends on: Story 4 (step 10 of the pipeline).

## Change

- In `src/services/model/pi-ai.ts`, consume the `AssistantMessageEventStream` returned by `models.stream` with `for await (const event of stream)`. Never call `stream.result()` and never call `models.complete`.
- Hold one mutable `terminal: AssistantMessageEvent | null`, starting `null`. In the loop:
  - `event.type === "text_delta"`: if `request.onTextDelta !== null`, call it with `event.delta`. Story 7 owns the throw path.
  - `event.type === "thinking_delta"`: ignore it.
  - `event.type === "done"` or `event.type === "error"`: if `terminal === null`, assign it; then `break`.
  - Every other event type: ignore it.
- After the loop, `terminal === null` refuses by the `outcome` flag of Story 7: `outcome === "timeout"` refuses `model-timeout`, and `outcome === "cancelled"` refuses `model-cancelled`. `outcome === null` with no terminal event is unreachable on `pi-ai` 0.84.1, because a stream that ends with no terminal event never ends the outer stream and only preemption leaves the loop. Refuse `model-failed` on that branch so the function is total, and add no `model-stream-incomplete` code.
- A `terminal` of type `error` maps by flag; Story 7 and Story 8 pin that mapping.
- A `terminal` of type `done` assembles the result from `terminal.message`:
  - `text` is the concatenation of `block.text` for every block of `terminal.message.content` whose `type === "text"`, in content order, joined with `""`.
  - `stop` maps `terminal.reason`: `"stop"` to `"stop"`, `"length"` to `"length"`, `"toolUse"` to `"toolUse"`. `"deferred"` refuses `model-failed`; Story 8 owns that case.
  - `toolCalls` comes from Story 6.
  - `usage` maps `terminal.message.usage` field by field: `input` to `inputTokens`, `output` to `outputTokens`, `cacheRead` to `cacheReadTokens`, `cacheWrite` to `cacheWriteTokens`, `totalTokens` to `totalTokens`. When `terminal.message.usage` is absent or `undefined`, every one of the five is `0`.
  - No other field of `Usage` reaches the result, so `cost`, `reasoning` and `cacheWrite1h` are dropped.

## Constraints

- Iterate; do not await `stream.result()`. `EventStream.end` (`node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`) settles `finalResultPromise` only on a terminal event, so `result()` never settles for a stream that ends without one. `Models.complete` is `stream(...).result()`, so awaiting it would hang where iterating plus preemption refuses.
- `push` of a terminal event already sets `done = true` (`dist/utils/event-stream.js:17-23`), so the iterator ends by itself; the `break` is belt-and-braces and must not change the assembled result.
- `lazyStream` observes no abort itself; it forwards whatever the provider stream does. An aborted provider may end its stream with no terminal event, or emit a terminal `error` of `reason: "aborted"`. Both shapes must give the same code, so the `outcome` flag decides in both branches: the no-terminal branch of this story, and the terminal-`error` branch of Story 8. Do not assume one shape.
- On 0.84.1 a stream that ends with no terminal event does not reach the no-terminal branch by itself; `forwardStream` awaits a `result()` that never settles, so only the preemption of Story 7 leaves the loop. Verified against the real nested `lazyApi` topology, for both an event-stream source and a plain async iterable source.
- A `ThinkingContent` block never enters `text`. Only `type === "text"` blocks contribute.
- `Usage` types `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and `cost` as required (`dist/types.d.ts:248-269`), so the absent-usage case arises only from a scripted mock message; guard it at run time rather than by type.

## Verify

- In `src/services/model/pi-ai.test.ts`, add tests asserting:
  - A scripted stream of `text_delta` `"Hel"`, then `text_delta` `"lo"`, then `done` with `reason: "stop"` and content `[{ type: "text", text: "Hello" }]` gives collected deltas deep-equal to `["Hel", "lo"]`, `result.text === "Hello"` and `result.stop === "stop"`.
  - A null `onTextDelta` over the same script resolves with `result.text === "Hello"` and throws nothing.
  - A terminal message reporting `usage` of `{ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, reasoning: 7, totalTokens: 110, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } }` gives `result.usage` deep-equal to `{ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, totalTokens: 110 }`.
  - A terminal message whose `usage` is absent gives `result.usage` deep-equal to `{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }`, and the call throws nothing.
  - A terminal message of content `[{ type: "thinking", thinking: "why" }, { type: "text", text: "answer" }]` gives `result.text === "answer"`, and a scripted `thinking_delta` event calls `onTextDelta` zero times.
  - A transport that pushes `start` and then calls `end()` with no argument, called with `timeoutMs: 5000` under `createManualDeadline`, rejects with `code === "model-timeout"` once the test expires the deadline by one synchronous call. Await the rejection inside the test, so a missing preemption fails on `--test-timeout` rather than passing.
  - The same holds for a transport returning a plain async iterable that ends with no terminal event, because the `lazyApi` layer converts it to an event stream first.
- Run `node --test --test-timeout=60000 src/services/model/pi-ai.test.ts`; it exits 0 at the end of the coupled unit.
- Proof: `PASS EPIC-102`, and Hermetic coverage lines 54, 55, 56, 57 and 60.
