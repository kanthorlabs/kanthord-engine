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

## Constraints

- Add exactly zero cases and remove exactly zero cases.
- Group A changes zero lines. Only `show-blob.test.ts` changes among shared-factory callers.
- Keep `TestApp.raw.options`, `TestApp.raw.delete`, `.send`, `.set`, and `.buffer` available.
- Keep all override defaults, error capture, authorization headers, host headers, and `cancelWaits` behavior.
- Do not edit `createApp`, the Koa bridge, `loopbackAgent`, or any package manifest.

## Verify

- Run `node --test test/helpers/app.test.ts src/http/server/blob/show-blob.test.ts src/http/server/app.test.ts`.
- The command preserves all existing case names and assertions.
- The `Range: bytes=0-4` case still returns 206, `bytes 0-4/10`, and `Buffer.from("01234")`.
- Run `npm run typecheck`; both factories satisfy `Promise<TestApp>`.
- Run the group-A gate against the commit this story starts from:

```bash
git diff --name-only <story-3-base>..HEAD
```

- That command lists exactly three paths: `test/helpers/app.ts`, `test/helpers/app.test.ts`, and
  `src/http/server/blob/show-blob.test.ts`.
- Any fourth path is a group-A edit and fails this story.
- Run `npm run verify`; it exits 0 with no pass-count change from Story 2.
- Proof: delivers the `test/helpers/app.test.ts`, `src/http/server/app.test.ts`, and
  `src/http/server/blob/show-blob.test.ts` lines.
- Proof: delivers the binary 206 wire gate and the group-A zero-line gate.
