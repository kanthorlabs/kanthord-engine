# Story 8 — A truncated response, and a provider failure

Epic: `.agent/plan/epics/102-provider-transport.md`
Depends on: Story 5 and Story 7.

## Change

- In `src/services/model/pi-ai.ts`, implement step 1 of the Story 2 pipeline. Validation runs before every other step and refuses `request-invalid` when any of these holds:
  - `Number.isInteger(request.timeoutMs) === false` or `request.timeoutMs <= 0`.
  - `request.model !== null` and `request.model.length === 0`.
  - `request.messages.length === 0`.
  - `request.maxOutputTokens !== null` and (`Number.isInteger(request.maxOutputTokens) === false` or `request.maxOutputTokens <= 0`).
- A terminal `done` event with `reason: "length"` returns `stop: "length"` with the assembled text and throws nothing.
- A terminal `error` event refuses by the `outcome` flag of Story 7. With `outcome === null` it refuses `model-failed`, and `event.error.errorMessage` reaches nothing.
- A terminal `done` event whose `reason` is `"deferred"` refuses `model-failed`. `done.reason` of `pi-ai` 0.84.1 admits `"stop" | "length" | "toolUse" | "deferred"`, and `ModelStop` holds the first three. kanthord never calls `fetchDeferred`, so a deferred answer is a provider protocol violation.

## Constraints

- Validation precedes the already-aborted check of Story 7, so an invalid request with an aborted signal refuses `request-invalid`.
- Read no field of `event.error` other than nothing. No upstream text enters a `ModelError`; the message always comes from `modelErrorMessages`.
- A truncated answer is not a failure. Do not refuse on `reason: "length"`.

## Verify

- In `src/services/model/pi-ai.test.ts`, add tests asserting:
  - A `done` event with `reason: "length"` and content `[{ type: "text", text: "half" }]` resolves with `result.stop === "length"` and `result.text === "half"`, and throws nothing.
  - An `error` event with `reason: "error"` and a terminal message carrying `errorMessage: "upstream 500"` rejects with `code === "model-failed"`, `error.message === modelErrorMessages["model-failed"]`, and `error.message.includes("upstream 500") === false`.
  - A transport whose `stream` throws synchronously rejects with `code === "model-failed"`.
  - A transport that yields `start` and then throws from its async iteration rejects with `code === "model-failed"`. Both cases use the real collection through `createMockModels`; neither needs a `Models` double, because 0.84.1 chains the iteration rejection into `lazyStream`'s `.catch` and both arrive as a terminal `error` event.
  - A `done` event with `reason: "deferred"` rejects with `code === "model-failed"`.
  - Each of `timeoutMs: 0`, `timeoutMs: 1.5`, `model: ""`, `messages: []`, `maxOutputTokens: 0` and `maxOutputTokens: 1.5` rejects with `code === "request-invalid"`, and the transport recorded zero calls for each.
  - Every rejection produced anywhere in `src/services/model/pi-ai.test.ts` satisfies `error.message === modelErrorMessages[error.code]`. Assert this through one shared helper the file's rejection tests all call.
- Run `node --test --test-timeout=60000 src/services/model/pi-ai.test.ts`; it exits 0.
- `npm run verify` exits 0. This story closes the coupled unit.
- Proof: `PASS EPIC-102`, and Hermetic coverage lines 59, 65, 66, 72 and the closing clause of line 73.
