# Story 2 - The result union and every producer and consumer

Epic: `.agents/plan/epics/031-fetch-native-response-model.md`
Depends on: Story 1.

## Change

### Result contract

- Edit `src/http/server/app.ts:38-46` before `Handler`.
- Add these exported status declarations in this exact order:

  ```ts
  export const handlerStatuses = [200, 204, 206, 304] as const;
  export const bodylessStatuses = [204, 304] as const;
  export type HandlerStatus = (typeof handlerStatuses)[number];
  export type BodylessStatus = (typeof bodylessStatuses)[number];
  export type BodyStatus = Exclude<HandlerStatus, BodylessStatus>;
  ```

- Add the result variants and union exactly:

  ```ts
  export type JsonResult = Readonly<{
    kind: "json";
    status: BodyStatus;
    body: unknown;
    headers?: Readonly<Record<string, string>>;
  }>;

  export type BytesResult = Readonly<{
    kind: "bytes";
    status: BodyStatus;
    bytes: Uint8Array;
    headers?: Readonly<Record<string, string>>;
  }>;

  export type EmptyResult = Readonly<{
    kind: "empty";
    status: BodylessStatus;
    headers?: Readonly<Record<string, string>>;
  }>;

  export type HandlerResult = JsonResult | BytesResult | EmptyResult;
  ```

- Keep the `Handler` signature at `src/http/server/app.ts:44-46` unchanged.
- Edit `src/http/server/app.test.ts:4-23` to import `handlerStatuses` and `bodylessStatuses`.
- Add one runtime test that deep-equals them to `[200, 204, 206, 304]` and `[204, 304]`.
- Add `kind: "json"` to every synthetic handler result at `src/http/server/app.test.ts:15-19,137-140`.

### Koa adapter and dispatch

- Add `src/http/server/koa-body.ts` with this export:

  ```ts
  export function koaBody(result: HandlerResult): unknown;
  ```

- Import `Buffer` from `node:buffer` and import `HandlerResult` as a type.
- Use an exhaustive `switch (result.kind)` with `json`, `bytes`, and `empty` cases and no default case.
- Return `result.body` for `json`.
- Return `Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)` for `bytes`.
- Return `undefined` for `empty`.
- Edit `src/http/server/dispatch.ts:5-9,33-48` inside `dispatchMiddleware`.
- Import `koaBody` from `./koa-body.ts` and retain Story 1's `compareBytewise` import.
- Use an exhaustive `switch (result.kind)` with `json`, `bytes`, and `empty` cases and no default case.
- For `json`, set `Content-Type` to `application/json; charset=utf-8`.
- For `bytes`, read `match.operation.responseMedia` and set it as `Content-Type`.
- If that field is absent, throw `httpError("internal-error", `bytes result for ${operationId} requires responseMedia`)`.
- For `empty`, set no default content type.
- After the variant default, apply result headers in `compareBytewise` order so a handler header wins.
- After result headers, assign `context.status = result.status`.
- Assign `context.body = koaBody(result)` only when `result.kind !== "empty"`.
- Do not assign `context.body` for 204 or 304.

### Dispatch tests

- Edit every synthetic result in `src/http/server/dispatch.test.ts:50,73-76,239,251-254,279-282,300-303,317-320,334-337,349-353,383,395-398,415,464-481`.
- Add `kind: "json"` to JSON results.
- Change the async fixture at line 415 from status 201 to status 200 and keep its awaited-body assertion.
- Replace the binary fixture at `src/http/server/dispatch.test.ts:361-378` with a `blob.show` bytes result.
- Return `{ kind: "bytes", status: 200, bytes: Uint8Array.from([1, 2, 3]) }` without a content-type header.
- Request `/v1/blob/x`, assert bytes `[1, 2, 3]`, and assert content type equals `findOperation("blob.show")?.responseMedia`.
- Add a JSON content-type test that asserts `application/json; charset=utf-8` exactly.
- Extend the existing result-header test at lines 346-359 with `Content-Type: application/vnd.test+json`.
- Assert that the handler content type overrides the JSON default.
- Add a raw response helper in `src/http/server/dispatch.test.ts` using `node:http` and `loopbackServer`.
- The helper must return status, `rawHeaders`, and `Buffer.concat(chunks)` without text decoding.
- Use a direct Koa app with `routeMiddleware` and `dispatchMiddleware` for raw dispatch tests.
- Before routing, set `context.state.actor = BOOTSTRAP_ACTOR_FIXTURE` in one test middleware.
- Add a header-order test with insertion order `X_c`, `X-a`, then `X-B` in the result object.
- Filter the raw name positions and assert the exact emitted list equals `["X-B", "X-a", "X_c"]`.
- Add one 204 test and one 304 test with `empty` stub results.
- For each result, assert the exact status, zero response bytes, and absent `content-type` and `content-length` names.
- Add a `system.status` bytes stub with no `responseMedia`.
- Assert status 500 and this exact envelope:

  ```ts
  {
    error: {
      code: "internal-error",
      message: "bytes result for system.status requires responseMedia",
    },
  }
  ```

### Blob result

- Edit `src/http/server/blob/show-blob.ts:1,14-49` inside `showBlobHandler`.
- Remove the `node:buffer` import.
- Build `const content = Uint8Array.from(record.content)`.
- Return `{ kind: "bytes", status: 200, bytes: content, headers }` for the full answer.
- Return `{ kind: "bytes", status: 206, bytes: content.subarray(...), headers }` for the range answer.
- Remove `Content-Type` from the local headers object.
- Keep `Accept-Ranges`, `Cache-Control`, `ETag`, and `Content-Range` values unchanged.
- Edit `src/http/server/blob/show-blob.test.ts:9-17,27-137,197-216`.
- Use `Buffer.from([0x00, 0x80, 0xff, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36])` as `content`.
- Replace string range expectations with `content.subarray(0, 5)`, `content.subarray(7)`, and `content.subarray(5)`.
- Keep all existing status and header assertions.
- Read the expected content type from `findOperation("blob.show")?.responseMedia` inside the test.
- Assert the 200 response body deep-equals `content`.
- Assert the `bytes=0-4` response body deep-equals `content.subarray(0, 5)`.
- These two full-chain assertions must include `0x80` or `0xff`, so JSON serialization fails.

### JSON handler producers

- Add `kind: "json"` to each returned result in these actor handlers:
- `src/http/server/actor/list-actor.ts:9-14` in `listActorHandler`.
- `src/http/server/actor/register-actor.ts:16-36` in `registerActorHandler`.
- `src/http/server/actor/revoke-actor.ts:11-23` in `revokeActorHandler`.
- `src/http/server/actor/rotate-actor-token.ts:13-28` in `rotateActorTokenHandler`.
- `src/http/server/actor/show-actor.ts:10-24` in `showActorHandler`.
- Add `kind: "json"` to each returned result in these credential handlers:
- `src/http/server/credential/inspect-provider.ts:17-33` in `inspectProviderHandler`.
- `src/http/server/credential/list-provider.ts:11-17` in `listProviderHandler`.
- `src/http/server/credential/read-catalog.ts:15-31` in `readCatalogHandler`.
- `src/http/server/credential/register-provider.ts:13-34` in `registerProviderHandler`.
- `src/http/server/credential/remove-provider.ts:10-25` in `removeProviderHandler`.
- `src/http/server/credential/rename-provider.ts:13-37` in `renameProviderHandler`.
- `src/http/server/credential/set-default-provider.ts:15-30` in `setDefaultProviderHandler`.
- `src/http/server/credential/show-provider.ts:12-26` in `showProviderHandler`.
- Add `kind: "json"` to `src/http/server/edge/list-edge.ts:10-22` in `listEdgeHandler`.
- Add `kind: "json"` to `src/http/server/event/list-event.ts:18-51` in `listEventHandler`.
- Add `kind: "json"` to each returned result in these node handlers:
- `src/http/server/node/claim-node.ts:12-36` in `claimNodeHandler`.
- `src/http/server/node/create-node.ts:13-38` in `createNodeHandler`.
- `src/http/server/node/delete-node.ts:13-37` in `deleteNodeHandler`.
- `src/http/server/node/heartbeat-node.ts:12-37` in `heartbeatNodeHandler`.
- `src/http/server/node/list-node.ts:15-30` in `listNodeHandler`.
- `src/http/server/node/list-project-node.ts:12-24` in `listProjectNodeHandler`.
- `src/http/server/node/release-node.ts:12-37` in `releaseNodeHandler`.
- `src/http/server/node/report-node.ts:15-40` in `reportNodeHandler`.
- `src/http/server/node/show-node.ts:9-23` in `showNodeHandler`.
- `src/http/server/node/unblock-node.ts:13-29` in `unblockNodeHandler`.
- `src/http/server/node/update-node.ts:13-38` in `updateNodeHandler`.
- Add `kind: "json"` to each returned result in these plan handlers:
- `src/http/server/plan/export-plan.ts:10-22` in `exportPlanHandler`.
- `src/http/server/plan/import-plan.ts:13-44` in `importPlanHandler`.
- `src/http/server/plan/list-revision.ts:12-24` in `listRevisionHandler`.
- `src/http/server/plan/validate-plan.ts:15-39` in `validatePlanHandler`.
- Add `kind: "json"` to each returned result in these project handlers:
- `src/http/server/project/create-project.ts:13-32` in `createProjectHandler`.
- `src/http/server/project/list-project.ts:10-17` in `listProjectHandler`.
- `src/http/server/project/read-project-status.ts:11-25` in `readProjectStatusHandler`.
- `src/http/server/project/replace-project-repositories.ts:15-39` in `replaceProjectRepositoriesHandler`.
- `src/http/server/project/show-project-graph.ts:10-22` in `showProjectGraphHandler`.
- `src/http/server/project/show-project.ts:9-23` in `showProjectHandler`.
- Add `kind: "json"` to each returned result in these repository handlers:
- `src/http/server/repository/inspect-repository.ts:17-37` in `inspectRepositoryHandler`.
- `src/http/server/repository/list-repository.ts:10-17` in `listRepositoryHandler`.
- `src/http/server/repository/register-repository.ts:15-39` in `registerRepositoryHandler`.
- `src/http/server/repository/show-repository.ts:11-25` in `showRepositoryHandler`.
- Add `kind: "json"` to each returned result in these system handlers:
- `src/http/server/system/db.ts:8-11` in `dbHandler`.
- `src/http/server/system/health.ts:8-13` in `healthHandler`.
- `src/http/server/system/status.ts:8-13` in `statusHandler`.
- Do not change any status, body expression, command call, query call, or result header.

### Result assertions and synthetic handlers

- Edit direct result assertions in `src/http/server/system/db.test.ts:102-114`.
- Edit direct result assertions in `src/http/server/system/health.test.ts:124-136`.
- Edit direct result assertions in `src/http/server/system/status.test.ts:111-123`.
- Add `kind: "json"` to each expected result object.
- Add `kind: "json"` to synthetic handlers in `src/http/server/authorize.test.ts:44-46,114-122,144,177-180`.
- Add `kind: "json"` to `nodeListHandler` in `src/http/server/actor/registration.test.ts:88-95`.
- Add `kind: "json"` to the helper handler in `test/helpers/app.test.ts:7-11`.
- Add `kind: "json"` to EPIC 030 recorders in `src/http/server/app.parity-body.test.ts` at `recordingApp`.
- Add `kind: "json"` to the `system.db` recorder in `src/http/server/app.parity-cors.test.ts` at `corsApp`.
- Add `kind: "json"` to the `blob.show` recorder in `src/http/server/app.parity-path.test.ts` at `recordingApp`.

### EPIC 030 handler inventory

- Edit `src/http/server/app.handler-result.test.ts` at `HANDLERS`, `Scanned`, `scanHandlers`, and the P21-P25 tests.
- Import `handlerStatuses`, `findOperation`, `HandlerContext`, and `BOOTSTRAP_ACTOR_FIXTURE` as required by these assertions.
- Change the P24 content fixture to the same ten-byte non-UTF-8 fixture used by `show-blob.test.ts`.
- Keep the frozen 44-path table and its current `[200]` or `[200, 206]` status values.
- Assert `handlerStatuses` deep-equals `[200, 204, 206, 304]`.
- Keep the scanned handler status union assertion equal to `[200, 206]`.
- This pair proves that no bound handler answers 204 or 304.
- Change the payload scan regex to `/\b(?:body|bytes)\s*[,:}]/` after removing `context.body` reads.
- Rename the P25 assertion to `every handler returns a payload value` and keep its offender list equal to `[]`.
- Keep the negative fixture JSON result and add `kind: "json"` to its source text.
- Update P23's synthetic JSON result with `kind: "json"` and retain its exact content-type assertion.
- Invoke `showBlobHandler` directly for both full and range contexts.
- Use `findOperation("blob.show")!`, `{ hash }`, empty query, `body: undefined`, and `BOOTSTRAP_ACTOR_FIXTURE` in both contexts.
- Use empty headers for the full context and `{ range: "bytes=0-4" }` for the range context.
- Assert each direct result has `kind === "bytes"`, `result.bytes.constructor === Uint8Array`, and `Buffer.isBuffer(result.bytes) === false`.
- Assert direct full bytes equal `Uint8Array.from(content)` and range bytes equal `Uint8Array.from(content.subarray(0, 5))`.
- Keep the P24 full-chain 200 and 206 assertions byte-exact.
- Read P24's expected content type from `findOperation("blob.show")?.responseMedia`.
- Keep P22's exact header-producing path equal to `src/http/server/blob/show-blob.ts`.
- Keep the preflight P25 assertion and add exact `content-type` absence beside existing `content-length` absence.

### Runtime source fence

- Edit `src/http/server/bytewise.test.ts` at `productionTypeScriptFiles` and its source-scan tests.
- Add a `node:buffer` offender scan over the same recursive production file list.
- Exclude only `src/http/server/koa-body.ts` from this scan.
- Assert the exact offender list equals `[]`.
- Keep the no-`Buffer.compare` offender assertion from Story 1.
- After Story 2 lands, Ulrich applies `.agents/plan/pending/031-s1-eslint-node-buffer.md` exactly at its specified site.

## Constraints

- Keep Koa and all ten middleware registrations in `src/http/server/app.ts:81-106` unchanged.
- Do not edit middleware behavior in `auth`, `authorize`, `envelope`, `host`, `idempotency`, `origin`, `preflight`, or `route`.
- Do not edit `StoredAnswer` in `src/http/server/idempotency-response.ts:3-7`.
- Do not add or remove registry operations.
- Do not change response body contents or blob header values.
- Use `Uint8Array` in `HandlerResult`; use `Buffer` only inside `koa-body.ts` and test oracle code.
- Do not add an empty result to a production handler.
- Keep every JSON handler at status 200 and the blob handler at statuses 200 and 206.
- Apply result headers after the variant content type.
- Assign no body for `empty`, including `undefined` or an empty string.
- Use only loopback HTTP. Use no wall clock, shared temporary directory, ambient Git configuration, or network host.
- The eslint edit is human-only because `scripts/lane-check.sh:47-49` blocks every agent lane.

## Verify

- Run the changed direct suites:

  ```bash
  node --test \
    src/http/server/app.test.ts \
    src/http/server/app.handler-result.test.ts \
    src/http/server/bytewise.test.ts \
    src/http/server/dispatch.test.ts \
    src/http/server/blob/show-blob.test.ts \
    src/http/server/system/db.test.ts \
    src/http/server/system/health.test.ts \
    src/http/server/system/status.test.ts
  ```

- `npm run typecheck` rejects body-bearing 204 or 304 results and empty 200 or 206 results by construction.
- `npm run verify` exits 0 after Ulrich applies the staged eslint rule.
- Run the EPIC Proof verbatim:

  ```bash
  node --test \
    src/http/server/app.test.ts \
    src/http/server/app.handler-result.test.ts \
    src/http/server/app.parity-body.test.ts \
    src/http/server/app.parity-cors.test.ts \
    src/http/server/app.parity-path.test.ts \
    src/http/server/bytewise.test.ts \
    src/http/server/dispatch.test.ts \
    src/http/server/envelope.test.ts \
    src/http/server/idempotency.test.ts \
    src/http/server/idempotency-response.test.ts \
    src/http/server/invalid-request.test.ts \
    src/http/server/preflight.test.ts \
    src/http/server/query.test.ts \
    src/http/server/route.test.ts \
    src/http/server/single.test.ts \
    src/http/server/start.test.ts \
    src/http/server/blob/range.test.ts \
    src/http/server/blob/show-blob.test.ts \
    src/http/server/actor/*.test.ts \
    src/http/server/credential/*.test.ts \
    src/http/server/edge/*.test.ts \
    src/http/server/event/*.test.ts \
    src/http/server/node/*.test.ts \
    src/http/server/plan/*.test.ts \
    src/http/server/project/*.test.ts \
    src/http/server/repository/*.test.ts \
    src/http/server/system/*.test.ts \
    src/http/contract/registry.test.ts \
    src/http/contract/system.test.ts \
    src/main.test.ts \
    && echo "PASS EPIC-031"
  ```

- The command prints `PASS EPIC-031`.
- Proof: delivers every remaining Proof file and the `PASS EPIC-031` marker.
- Proof: delivers byte-exact blob 200 and 206, bodyless 204 and 304, header order, and registry media coverage.
- Proof: delivers missing-`responseMedia`, source-fence, idempotency, contract, composition-root, and full regression coverage.
