# Story 6 — Tool calls

Epic: `.agents/plan/epics/102-provider-transport.md`
Depends on: Story 4 and Story 5.

## Change

- In `src/services/model/pi-ai.ts`, map `request.tools` to the `Context.tools` array. Each `ModelTool` maps to `{ name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Tool["parameters"] }`, where `Tool` is imported as a type from `@earendil-works/pi-ai`. Keep request order.
- Assemble `ModelResult.toolCalls` from the terminal `done` message: map every block of `terminal.message.content` whose `type === "toolCall"`, in content order, to `{ id: block.id, name: block.name, arguments: block.arguments }`.
- A terminal `done` event whose `reason` is `"toolUse"` sets `stop: "toolUse"`.
- A terminal message with no `toolCall` block gives `toolCalls` equal to `[]`.

## Constraints

- `pi-ai` types `Tool.parameters` as `TSchema` of `typebox` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:318-322`). A `typebox` schema is a JSON Schema object at run time, so the double cast is the whole conversion. Run no schema transform, and add no `typebox` import or dependency.
- Do not reorder, deduplicate or validate tool calls. The provider's content order is the result order.
- `ToolCall.arguments` is `Record<string, any>` (`dist/types.d.ts:241-247`); pass the reference through unchanged.

## Verify

- In `src/services/model/pi-ai.test.ts`, add tests asserting:
  - A `done` event with `reason: "toolUse"` and content `[{ type: "toolCall", id: "call-1", name: "t", arguments: { a: 1 } }, { type: "toolCall", id: "call-2", name: "t", arguments: { a: 2 } }]` gives `result.stop === "toolUse"` and `result.toolCalls` deep-equal to `[{ id: "call-1", name: "t", arguments: { a: 1 } }, { id: "call-2", name: "t", arguments: { a: 2 } }]`, in that order.
  - Two tools in the request reach the transport as `captured.context.tools` deep-equal to `[{ name: "t1", description: "d1", parameters: { type: "object", properties: {} } }, { name: "t2", description: "d2", parameters: { type: "object", properties: {} } }]`, in that order.
  - A `done` event with `reason: "stop"` and content `[{ type: "text", text: "Hello" }]` gives `result.toolCalls` deep-equal to `[]`.
- Run `node --test --test-timeout=60000 src/services/model/pi-ai.test.ts`; it exits 0 at the end of the coupled unit.
- Proof: `PASS EPIC-102`, and Hermetic coverage line 58.
