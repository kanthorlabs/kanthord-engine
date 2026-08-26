# Story 3 — Move createTestApp to level 1

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Depends on: Story 2.

## Change

### `test/helpers/app.ts`

- Replace the Supertest type import at the import block with `Agent` and `AgentRequest` imports.
- Import `fetchAgent` and retain `loopbackAgent` from `test/helpers/agent.ts`.
- Import the `App` type beside `createApp` from `src/http/server/app.ts`.
- At `TestApp`, type `raw` as `Agent`.
- At `TestApp`, type `get`, `post`, `put`, and `del` returns as `AgentRequest`.
- Change `drive` and `driveRaw` return types to `AgentRequest`.
- Preserve each method switch and its unsupported-method error unchanged.
- Extract the existing factory body into private `createTestAppWithAgent` with this exact signature:

```ts
async function createTestAppWithAgent(
  overrides: TestAppOverrides | undefined,
  createAgent: (created: App) => Agent | Promise<Agent>,
): Promise<TestApp>;
```

- Keep every current override default and returned `TestApp` method in that private helper.
- Export `createTestApp(overrides?)` as a call using `fetchAgent(created.hono)`.
- Export `createSocketTestApp(overrides?)` as a call using `loopbackAgent(created.app)`.
- Both exported factories return `Promise<TestApp>` and accept the same `TestAppOverrides`.
- Await the callback result before constructing `TestApp`; this supports both agent implementations.
- Do not expose the private callback or transport selector.

### `test/helpers/app.test.ts`

- Replace any Supertest type name with `Agent` or `AgentRequest` at its existing type site.
- Keep the four case names and every assertion unchanged.
- Add no case and add no socket-specific assertion.

### `src/http/server/blob/show-blob.test.ts`

- Change the import at the current `createTestApp` import site to `createSocketTestApp`.
- Change `handlerApp` to call `createSocketTestApp` with the same overrides.
- Change no other line, case name, request, or assertion in this file.

### `test/helpers/agent.ts` — the array header form

- Widen `AgentRequest.set` to `set(name: string, value: string | readonly string[]): AgentRequest`.
- Hold the request headers in a Fetch `Headers`, never in a `Map`.
- For a string value, call `headers.set(name, value)`; a repeated `.set` on one name replaces.
- For an array value, call `headers.delete(name)`, then `headers.append(name, element)` per element.
- Do not call `headers.set(name, array)`. That stringifies the array to `one,two`.
- Two appends on one name read back as `one, two`, which EPIC 030 row P18 pins.
- Change no other member of the `Agent` contract.

### `src/http/server/app.parity-path.test.ts`

- Remove the `as unknown as string` cast at `:41` and at `:49`. Pass the array directly.
- Remove `"accept-encoding"` and `"connection"` from the expected array at `:53`.
- Remove the same two entries from the expected array at `:65` and from the one at `:74`.
- Keep every remaining entry in its current order.
- Change line 44 not at all. It keeps `"one, two"`.
- Rewrite the two case names that count the header names the case asserts. In the case at `:47`,
  `five` becomes `three`. In the case at `:60`, `four` becomes `two`. Change no other word of
  either name.
- Change no other case name, no request, and no other assertion.

The three expected arrays become exactly:

```ts
["authorization", "host", "x-kanthord-client"];
["authorization", "host"];
["authorization", "host"];
```

### `src/http/server/app.handler-result.test.ts`

- Change the `createTestApp` import to `createSocketTestApp`.
- Change all four `createTestApp` call sites to `createSocketTestApp` with the same overrides.
- Change no case name, no request, and no assertion.

## Constraints

- Add exactly zero cases and remove exactly zero cases.
- Group A changes zero lines, except `src/http/server/app.parity-path.test.ts`.
- That one exception has a budget of 3 assertion expressions and 6 deleted expectation lines.
- Do not relax the `content-length` assertions at `app.handler-result.test.ts:230` and `:247`.
- Do not split `app.handler-result.test.ts`. EPIC 030 rows P21 to P25 bind to that one path.
- Keep `TestApp.raw.options`, `TestApp.raw.delete`, `.send`, `.set`, and `.buffer` available.
- Keep all override defaults, error capture, authorization headers, host headers, and `cancelWaits` behavior.
- Do not edit `createApp`, the Koa bridge, `loopbackAgent`, or any package manifest.

## Verify

- Run `node --test test/helpers/app.test.ts src/http/server/blob/show-blob.test.ts src/http/server/app.test.ts src/http/server/app.parity-path.test.ts src/http/server/app.handler-result.test.ts`.
- The command preserves all existing case names and assertions.
- The `Range: bytes=0-4` case still returns 206, `bytes 0-4/10`, and `Buffer.from("01234")`.
- Run `npm run typecheck`; both factories satisfy `Promise<TestApp>`.
- Run the group-A gate against the commit this story starts from:

```bash
git diff --name-only <story-3-base>..HEAD
```

- That command lists exactly six paths: `test/helpers/app.ts`, `test/helpers/app.test.ts`,
  `test/helpers/agent.ts`, `src/http/server/blob/show-blob.test.ts`,
  `src/http/server/app.parity-path.test.ts`, and `src/http/server/app.handler-result.test.ts`.
- Any seventh path is a group-A edit and fails this story.
- Run `git diff --numstat <story-3-base>..HEAD -- src/http/server/app.parity-path.test.ts`.
- That command reports exactly `4` added and `10` deleted: 6 deleted expectation lines, the two
  cast lines rewritten in place, and the two case names rewritten in place.
- Run `npm run verify`; it exits 0 with no pass-count change from Story 2.
- Proof: delivers the `test/helpers/app.test.ts`, `src/http/server/app.test.ts`, and
  `src/http/server/blob/show-blob.test.ts` lines.
- Proof: delivers the binary 206 wire gate and the group-A zero-line gate.
