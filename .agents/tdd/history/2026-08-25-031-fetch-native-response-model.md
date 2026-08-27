---
epic: .agents/plan/epics/031-fetch-native-response-model.md
opened: 2026-08-25
opener: test-engineer
base-ref: 7d46f69e29574b54c86ce3cfbdee44521aa49986
---

# Implementation cycle — 031-fetch-native-response-model

Pulled from EPIC: `.agents/plan/epics/031-fetch-native-response-model.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/server/app.test.ts \
>   src/http/server/app.handler-result.test.ts \
>   src/http/server/app.parity-body.test.ts \
>   src/http/server/app.parity-cors.test.ts \
>   src/http/server/app.parity-path.test.ts \
>   src/http/server/bytewise.test.ts \
>   src/http/server/dispatch.test.ts \
>   src/http/server/envelope.test.ts \
>   src/http/server/idempotency.test.ts \
>   src/http/server/idempotency-response.test.ts \
>   src/http/server/invalid-request.test.ts \
>   src/http/server/preflight.test.ts \
>   src/http/server/query.test.ts \
>   src/http/server/route.test.ts \
>   src/http/server/single.test.ts \
>   src/http/server/start.test.ts \
>   src/http/server/blob/range.test.ts \
>   src/http/server/blob/show-blob.test.ts \
>   src/http/server/actor/*.test.ts \
>   src/http/server/credential/*.test.ts \
>   src/http/server/edge/*.test.ts \
>   src/http/server/event/*.test.ts \
>   src/http/server/node/*.test.ts \
>   src/http/server/plan/*.test.ts \
>   src/http/server/project/*.test.ts \
>   src/http/server/repository/*.test.ts \
>   src/http/server/system/*.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/contract/system.test.ts \
>   src/main.test.ts \
>   && echo "PASS EPIC-031"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`. `typecheck` is the mechanism for the status-to-variant rule.
> - **A blob 200 and a blob 206 stay byte-exact.** The full-payload answer equals the stored content
>   byte for byte, and the range answer equals the same slice `parseRange` names. Both are asserted
>   through the daemon, with a payload that holds a non-UTF-8 byte, so a JSON serialization of the
>   bytes fails the test instead of passing it.
> - **A 204 response and a 304 response carry no body**, asserted by absence rather than by an empty
>   string. The test reads the raw response and asserts that no `content-type` header and no
>   `content-length` header are present, and that the body has zero bytes.
> - **`compareBytewise` and `Buffer.compare` agree.** `bytewise.test.ts` compares the two over a
>   string set that holds non-ASCII code points, a shared prefix, and a pair whose bytewise order is
>   the reverse of their code-unit order. It asserts the sign of every pair by exact value.
> - **The bytewise response header order is unchanged.** An HTTP field name is an ASCII token only
>   (RFC 9110), and Node throws `ERR_INVALID_HTTP_TOKEN` for anything else, so this row cannot use a
>   non-ASCII name. A stub handler returns valid token names whose bytewise order differs from their
>   case-insensitive order — for example `X-B`, `X-a` and `X_c` — and the test asserts the emitted
>   order by exact list.
> - **No production file under `src/http/server/**` imports `node:buffer`, except `koa-body.ts`.** The
>   test reads every `.ts` file under the tree, excludes `*.test.ts` and `koa-body.ts`, and asserts an
>   empty offender list by value.
> - **No production file under `src/http/server/**` calls `Buffer.compare`.** The import rule does not
>   reach the global `Buffer`, and two of the nine comparison sites read it that way. The same test
>   asserts a second empty offender list, over the text `Buffer.compare`, with no exception.
> - **The blob content type comes from the registry.** The emitted `Content-Type` for `blob.show`
>   equals `responseMedia` of the registry entry, read from the registry inside the test rather than
>   written as a literal.
> - **A `bytes` result for an operation with no `responseMedia` fails.** The dispatch test asserts the
>   500 envelope and asserts that the message names the operation id.
> - **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — a bytewise helper with no Buffer · Story 1 · Task `01-bytewise-helper-with-no-buffer`

**Cycle.** RED for Task `01-bytewise-helper-with-no-buffer` (`src/http/server/bytewise.test.ts` + the `query.test.ts` / `single.test.ts` pins) — first Task of the first Story of EPIC `031-fetch-native-response-model`; this discussion file had no prior turns.

**Test written.**

- file: `src/http/server/bytewise.test.ts` (new) — suite: `src/http/server/bytewise.test` — methods: `sorts the fixture set into the exact bytewise order`, `agrees with Buffer.compare on the sign of every fixture pair`, `orders the private-use character before the emoji while JavaScript orders the reverse`, `calls Buffer.compare in no production file under src/http/server`
- asserts: the fixtures `a`, `aa`, `\u00e9`, `\uE000`, `\u{1F600}` sorted from reverse wire order deep-equal `["a", "aa", "\u00e9", "\uE000", "\u{1F600}"]`; every fixture pair's `Math.sign(compareBytewise(left, right))` equals the `Buffer.compare` sign (self-pairs exactly `0`); JavaScript default sort orders `\u{1F600}` before `\uE000` while both byte comparators order `\uE000` first; and a recursive scan of production `.ts` files under `src/http/server` (excluding `*.test.ts`) yields an exact `Buffer.compare` offender list equal to `[]`.
- file: `src/http/server/query.test.ts` (edited) — `orders keys bytewise regardless of wire order` gains `%F0%9F%98%80=2&%EE%80%80=1` through `encodeURIComponent`; asserts key order `["\uE000", "\u{1F600}"]`. ASCII assertions kept.
- file: `src/http/server/single.test.ts` (edited) — `orders keys bytewise in the result` supplies computed keys `\u{1F600}` before `\uE000`; asserts result key list `["\uE000", "\u{1F600}"]`. ASCII assertions kept. These two edits are regression pins demanded by the Story; they pass against today's `Buffer.compare` consumers, so their RED sensitivity lives entirely in the new suite above.

**RED proof.**

- command: `node --test src/http/server/bytewise.test.ts src/http/server/query.test.ts src/http/server/single.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/bytewise.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/bytewise.test.ts` (13 pass / 1 fail — the two consumer-pin suites stay green)
- stub probe: `src/http/server/bytewise.ts` — clean (`tsc --noEmit` exit 0 with the stub; no error in my test files). With the stub in place all four tests failed for behavioral reasons, including the source fence listing exactly `['src/http/server/dispatch.ts', 'src/http/server/idempotency-key.ts', 'src/http/server/idempotency-response.ts', 'src/http/server/invalid-request.ts', 'src/http/server/query.ts', 'src/http/server/single.ts']` — six offenders today, `[]` only after all nine comparison sites move to the helper. Stub deleted before this turn; the tree holds no trace.
- cross-check: `node --test src/http/server/dispatch.test.ts src/http/server/idempotency-key.test.ts src/http/server/idempotency-response.test.ts src/http/server/invalid-request.test.ts` → **86 pass / 0 fail**, untouched.

**Open to Software Engineer.**

- Seam my tests import: `src/http/server/bytewise.ts` (new) exporting `compareBytewise(left: string, right: string): number` — one module-level encoder, first differing byte decides, encoded length difference on a prefix. Implement it per the Story file's Change section, then make the nine named comparison sites in `dispatch.ts`, `query.ts`, `single.ts`, `invalid-request.ts`, `idempotency-response.ts` and `idempotency-key.ts` call it instead of `Buffer.compare`, deleting the four `node:buffer` imports the Story lists (`idempotency-key.ts` keeps its `Buffer.byteLength` calls). All paths verified granted to your lane by `scripts/lane-check.sh`.
- My source fence fails until **every** one of the nine sites is off `Buffer.compare` — partial replacement stays red. Do not edit `bytewise.test.ts`, `query.test.ts` or `single.test.ts`; they are mine and already pin the target behaviour. Finish with `npm run typecheck`; I run the Story Verify suites and the handoff gate next turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 1 · a bytewise helper with no Buffer

**Cycle.** GREEN for Task `01-bytewise-helper-with-no-buffer` (`src/http/server/bytewise.test.ts` + the `query.test.ts` / `single.test.ts` pins).

**Files changed.**

- `src/http/server/bytewise.ts` (new) — `compareBytewise(left: string, right: string): number`; one module-level `TextEncoder`, first differing byte decides, encoded-length difference on a prefix
- `src/http/server/dispatch.ts` (edited) — both sort callbacks (`dispatchMiddleware` result headers, `readHeaders`) call `compareBytewise`; `node:buffer` import deleted
- `src/http/server/query.ts` (edited) — key comparator replaced with `compareBytewise`; `node:buffer` import deleted
- `src/http/server/single.ts` (edited) — key comparator replaced with `compareBytewise`; `node:buffer` import deleted
- `src/http/server/invalid-request.ts` (edited) — `order` compares `path`, then `code`, then `message` via `compareBytewise`; `node:buffer` import deleted
- `src/http/server/idempotency-response.ts` (edited) — `captureAnswer` pair sort calls `compareBytewise(a[0], b[0])`; lower-casing, volatile-header removal and pair order untouched (no import existed)
- `src/http/server/idempotency-key.ts` (edited) — `recordKey` parameter-name sort calls `compareBytewise`; `Buffer.byteLength` and hash conversion untouched (no import existed)

**Seam (GREEN).** All nine comparison sites named by the Story now call the shared `compareBytewise`, so the fence test's production scan finds zero `Buffer.compare` occurrences under non-test files of `src/http/server`, and the exact-order/pin assertions hold because `TextEncoder` emits the same UTF-8 bytes `Buffer.from(value)` emits.

**Refactor.** None named for this Task; the Change section was applied whole as the green change.

**Build check.**

- typecheck: exit 0
- lane-check: clean on all seven files (`scripts/lane-check.sh software-engineer <path>`)

**Assumptions.**

- VERIFIED: `TextEncoder` orders identically to `Buffer.from` UTF-8 — runtime probe over prefix, shared-prefix, non-ASCII and `\uE000`/`\u{1F600}` pairs shows equal `Math.sign` values against `Buffer.compare`.
- VERIFIED: after the edit the string `Buffer.compare` survives under `src/http/server` only in test files; `blob/show-blob.ts` keeps its `node:buffer` import per the Story ("Story 2 removes that final production import") and contains no compare call.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the result union and every producer and consumer · Story 2 · Task `02-result-union-and-all-producers-consumers`

**Cycle.** Handoff gate first: SE's last turn claims `npm run typecheck` exit 0; `npm run verify:handoff` independently reports `VERIFY: PASS` (exit 0). Story 1 Task `01-bytewise-helper-with-no-buffer` confirmed GREEN — Story Verify suites (`bytewise`, `dispatch`, `idempotency-key`, `idempotency-response`, `invalid-request`, `query`, `single`) run **103 pass / 0 fail**. Then RED for Task `02-result-union-and-all-producers-consumers` (`src/http/server/**.test.ts` set named in the Story's Verify section).

**Test written.**

- file: `src/http/server/app.test.ts` (edited) — suite unchanged — methods: `the handler status set and the bodyless status set are the exact closed lists` (new), plus `kind: "json"` on all three synthetic handler literals
- file: `src/http/server/app.handler-result.test.ts` (edited) — methods renamed/added: `the declared status set is the exact closed list and the tree answers 200 and 206 and nothing else` (asserts `handlerStatuses` deep-equal `[200, 204, 206, 304]` beside the scanned-union `[200, 206]` pin), `every handler returns a payload value` (regex now `\b(?:body|bytes)\s*[,:}]`), `showBlobHandler returns the bytes variant as a plain Uint8Array` (direct invocation over `findOperation("blob.show")!`; asserts `kind === "bytes"`, `bytes.constructor === Uint8Array`, `Buffer.isBuffer(bytes) === false`, full bytes equal `Uint8Array.from(content)`, range bytes equal `Uint8Array.from(content.subarray(0, 5))`), `a bytes result serializes byte-exact with an exact content-length and the registry media type` + range chain test (ten-byte non-UTF-8 fixture `Buffer.from([0x00, 0x80, 0xff, 0x30…0x36])`; content type read from `findOperation("blob.show")?.responseMedia` inside the test); preflight test gains exact `content-type` absence beside `content-length`; negative fixture source text carries `kind: "json"`
- file: `src/http/server/dispatch.test.ts` (edited) — new raw harness (`rawResponse` over `node:http` + `loopbackServer`: status, `rawHeaders`, undecoded `Buffer.concat(chunks)`; `directDispatchApp` = envelope → actor-state middleware → route → dispatch) — methods: `a handler's headers are emitted in bytewise order regardless of insertion order` (insertion `X_c`, `X-a`, `X-B` → emitted exactly `["X-B", "X-a", "X_c"]`), `a blob.show bytes result crosses the boundary byte-exact with the registry media type` (stub `{ kind: "bytes", status: 200, bytes: Uint8Array.from([1,2,3]) }`, no content-type header, `/v1/blob/x`, media type from the registry), `a json result answers exactly application/json; charset=utf-8`, `an empty result answers 204 … no content-type or content-length header`, `an empty result answers 304 …` (zero body bytes, absence by name list), `a bytes result for an operation with no responseMedia answers the internal-error envelope naming the operation id` (exact envelope `{error:{code:"internal-error",message:"bytes result for system.status requires responseMedia"}}`); header test extended with the `application/vnd.test+json` override; async fixture moved 201 → 200; every synthetic JSON result carries `kind: "json"`
- file: `src/http/server/bytewise.test.ts` (edited) — method: `imports node:buffer in no production file under src/http/server except koa-body` (offender list deep-equals `[]`, excluding only `src/http/server/koa-body.ts`)
- file: `src/http/server/blob/show-blob.test.ts` (edited) — ten-byte non-UTF-8 fixture; expectations become `content.subarray(0, 5)` / `subarray(7)` / `subarray(5)` / whole `content`; both content-type assertions read `findOperation("blob.show")?.responseMedia`
- files: `system/db.test.ts`, `system/health.test.ts`, `system/status.test.ts` (edited) — direct-result assertions expect `kind: "json"` in the deep-equal
- files: `authorize.test.ts` (6 literals), `actor/registration.test.ts` (`nodeListHandler`), `test/helpers/app.test.ts` (2 handlers), `app.parity-body.test.ts`, `app.parity-cors.test.ts`, `app.parity-path.test.ts` (recorders), `node/unblock-node.test.ts` (conformer sweep: kind-narrowing guard before `.body`) — synthetic results carry `kind: "json"`

**RED proof.**

- command: `node --test src/http/server/app.test.ts src/http/server/app.handler-result.test.ts src/http/server/bytewise.test.ts src/http/server/dispatch.test.ts src/http/server/blob/show-blob.test.ts src/http/server/system/db.test.ts src/http/server/system/health.test.ts src/http/server/system/status.test.ts`
- exit: non-zero — 60 pass / **8 fail**, each for the missing behaviour:
  - `SyntaxError: The requested module './app.ts' does not provide an export named 'handlerStatuses'` (kills `app.handler-result.test.ts`) and `… 'bodylessStatuses'` (kills `app.test.ts`)
  - `imports node:buffer in no production file under src/http/server except koa-body` — offender list `['src/http/server/blob/show-blob.ts'] !== []`
  - `a blob.show bytes result crosses the boundary byte-exact with the registry media type` — `204 !== 200` (today dispatch assigns the absent `body` and Koa rewrites the status)
  - `a bytes result for an operation with no responseMedia answers the internal-error envelope naming the operation id` — `204 !== 500`
  - `the handler formats the query result directly` ×3 (db/health/status) — actual result lacks `kind: 'json'`
  - plus `unblock-node.test.ts` `Error: the answer is not the json variant` (conformer guard)
- characterization pins that pass today, sensitivity stated: the 204/304 wire-shape tests pass against Koa today (Koa strips those statuses already) — their RED is type-level (`kind: "empty"` fails today's `HandlerResult`); the header-order test pins Story 1's bytewise sort against insertion order; the JSON content-type test pins the exact string the variant must keep producing. The blob byte-exact tests use a non-UTF-8 fixture so any future JSON serialization of bytes fails them.
- stub probe: `src/http/server/app.ts` (temporary union declarations per the Story snippet, reverted via `git checkout` before this turn) — typecheck then reported **zero errors in test/helper files**; the 45 residual errors are exactly the SE seams: 43 JSON handler factories + `blob/show-blob.ts` returning the old shape, and `dispatch.ts:46` reading `.body` off what becomes the union. Probe gone; tree clean of it.

**Open to Software Engineer.**

- Seams my tests import: `src/http/server/app.ts` — exports `handlerStatuses`, `bodylessStatuses`, types `HandlerStatus`, `BodylessStatus`, `BodyStatus`, `JsonResult`, `BytesResult`, `EmptyResult`, and `HandlerResult` redeclared as their union, exactly as the Story file's Change section spells out.
- Seam: `src/http/server/koa-body.ts` (new) exporting `koaBody(result: HandlerResult): unknown` per the Story file.
- Seam: `src/http/server/dispatch.ts` — build the answer from `result.kind` (variant content type, sorted result headers after the default, status, `context.body = koaBody(result)` only when not `empty`), and throw the internal-error naming the operation id when a `bytes` result has no `responseMedia`.
- Seam: `src/http/server/blob/show-blob.ts` — return the `bytes` variant for 200/206, drop `node:buffer`, remove `"Content-Type"` from the local headers.
- Seam: the 43 JSON handler files grouped in the EPIC (actor 5, credential 8, edge 1, event 1, node 11, plan 4, project 6, repository 4, system 3) each add `kind: "json"` to returned results.
- Do not edit any `*.test.ts` or `test/helpers/**` — all are mine and already at the target shape. Finish with `npm run typecheck`; I run the Story Verify suites, the EPIC gates and the Proof next turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Story 2 · the result union and every producer and consumer

**Cycle.** GREEN for Task `02-result-union-and-all-producers-consumers` (the RED set: `app.test.ts`, `app.handler-result.test.ts`, `bytewise.test.ts`, `dispatch.test.ts`, `blob/show-blob.test.ts`, `system/{db,health,status}.test.ts`, plus conformer pins).

**Files changed.**

- `src/http/server/app.ts` (edited) — `handlerStatuses`, `bodylessStatuses`, `HandlerStatus`, `BodylessStatus`, `BodyStatus`, `JsonResult`, `BytesResult`, `EmptyResult`; `HandlerResult` redeclared as their union; `Handler` text unchanged
- `src/http/server/koa-body.ts` (new) — `koaBody(result: HandlerResult): unknown`; exhaustive `switch (result.kind)` (`json`→body, `bytes`→`Buffer.from(bytes.buffer, byteOffset, byteLength)`, `empty`→undefined), imports `Buffer` from `node:buffer`
- `src/http/server/dispatch.ts` (edited) — exhaustive `switch (result.kind)`: `json` sets `application/json; charset=utf-8`, `bytes` sets `match.operation.responseMedia` or throws `httpError("internal-error", \`bytes result for ${operationId} requires responseMedia\`)`, `empty`sets none; then result headers in`compareBytewise`order, then status, then`context.body = koaBody(result)`only when not`empty`
- `src/http/server/blob/show-blob.ts` (edited) — `Uint8Array.from(record.content)`, returns `kind: "bytes"` with `bytes` for 200/206, drops `node:buffer` import and the local `"Content-Type"` header; other header values unchanged
- 43 JSON handlers (edited) — one `kind: "json",` insertion each, exactly the sites tsc enumerated before the edit (actor 5, credential 8, edge 1, event 1, node 11, plan 4, project 6, repository 4, system 3); applied as one uniform mechanical insertion per file after tsc proved one result literal per file, re-verified by typecheck returning to zero errors

**Seam (GREEN).** Every handler now returns a discriminated variant so the union typechecks, and dispatch builds the whole answer from `result.kind` — variant content type, bytewise-sorted result headers over it, explicit status, body assigned through the Koa adapter only for body-bearing variants — which is what the RED assertions pin (closed status lists, exact JSON media string, handler-header override, raw 204/304 with absent `content-type`/`content-length` and zero body bytes, registry-media blob bytes, internal-error envelope naming the operation id).

**Refactor.** None named for this Task; the Change section applied whole as the green change.

**Build check.**

- typecheck: exit 0 (43 enumerated TS2322 errors before the handler sweep, 0 after)
- lane-check: clean on all 48 touched production files including new `koa-body.ts`
- `eslint src/http/server`: clean

**Assumptions.**

- VERIFIED: installed Koa 3.2.1 keeps an already-set Content-Type when the body is a plain object if it matches `/\bjson\b/i` (`node_modules/koa/lib/response.js` json branch), so both the variant default and a handler's overriding header survive the final body assignment under the Story's ordering — read before relying on it.
- VERIFIED: after the edit, `node:buffer` appears in exactly one production file under `src/http/server` (`koa-body.ts`) and `Buffer.compare` in none — both source fences of `bytewise.test.ts` hold by construction.
- Runtime wire behaviour (byte-exact blob 200/206, raw 204/304 shapes) rides on the Story Verify suites the TE runs next turn; I ran no test runner.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Handoff gate first: the software-engineer's last turn claims `npm run typecheck` exit 0; `npm run verify:handoff` independently reports `VERIFY: PASS — npm run typecheck is clean`. Story 2 Task `02-result-union-and-all-producers-consumers` confirmed GREEN — its Verify suites run **100 pass / 0 fail**. Story 1's Verify suites re-run **109 pass / 0 fail**. Both Stories' Tasks are green, so the full EPIC gate ran end-to-end this turn.

- `typecheck` (`npm run typecheck`): exit 0 — inside the verified `npm run verify` chain
- `unit` (`npm test`): exit 0 — full suite, same chain
- `Gates:` `npm run verify` → exit 0 (`format && typecheck && test && lint && verify-db-status`, `&&`-chained; final line `kanthord: verify db status ok`)
- Hermetic coverage beyond the Proof, all passing inside it: blob 200/206 byte-exact over a non-UTF-8 payload (`show-blob.test.ts`, `app.handler-result.test.ts`); raw 204/304 with absent `content-type`/`content-length` names and zero body bytes (`dispatch.test.ts`); `compareBytewise` ≡ `Buffer.compare` sign-by-sign over non-ASCII fixtures (`bytewise.test.ts`); bytewise header order emitted exactly `["X-B", "X-a", "X_c"]` (`dispatch.test.ts`); `node:buffer` production fence excepting only `koa-body.ts`, plus the no-exception `Buffer.compare` fence (`bytewise.test.ts`); blob content type read from the registry, never a literal (`show-blob.test.ts`, `app.handler-result.test.ts`, `dispatch.test.ts`); the missing-`responseMedia` 500 envelope naming the operation id (`dispatch.test.ts`). No wall clock, shared temp dir, or ambient git config anywhere in the cycle.

**Proof.**

- command: the EPIC's verbatim Proof — `node --test src/http/server/app.test.ts src/http/server/app.handler-result.test.ts src/http/server/app.parity-body.test.ts src/http/server/app.parity-cors.test.ts src/http/server/app.parity-path.test.ts src/http/server/bytewise.test.ts src/http/server/dispatch.test.ts src/http/server/envelope.test.ts src/http/server/idempotency.test.ts src/http/server/idempotency-response.test.ts src/http/server/invalid-request.test.ts src/http/server/preflight.test.ts src/http/server/query.test.ts src/http/server/route.test.ts src/http/server/single.test.ts src/http/server/start.test.ts src/http/server/blob/range.test.ts src/http/server/blob/show-blob.test.ts src/http/server/actor/*.test.ts src/http/server/credential/*.test.ts src/http/server/edge/*.test.ts src/http/server/event/*.test.ts src/http/server/node/*.test.ts src/http/server/plan/*.test.ts src/http/server/project/*.test.ts src/http/server/repository/*.test.ts src/http/server/system/*.test.ts src/http/contract/registry.test.ts src/http/contract/system.test.ts src/main.test.ts && echo "PASS EPIC-031"`
- exit 0 — `tests 623 / suites 75 / pass 623 / fail 0`, success string printed verbatim: `"PASS EPIC-031"`

**Tasks closed.** 2 across 2 Stories — `01-bytewise-helper-with-no-buffer` (Story 1), `02-result-union-and-all-producers-consumers` (Story 2); no Story outstanding, no Story unexpanded.

Human note (EPIC Open items, not a gate failure): S1 — the eslint `node:buffer` ban under `src/http/server/**` — stays staged in `.agents/plan/pending/031-s1-eslint-node-buffer.md` for Ulrich's hand, because `scripts/lane-check.sh` denies `*.config.*` to every agent lane. `npm run verify` is green without it; the runtime source fences carry the rule until it lands.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/server/*.test.ts set per EPIC 031 && echo "PASS EPIC-031") — "PASS EPIC-031"
- stories: 2/2 complete
- date: 2026-08-25
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
