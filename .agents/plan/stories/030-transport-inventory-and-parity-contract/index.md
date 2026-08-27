# EPIC 030 — Transport inventory and parity contract — stories

Epic: `.agents/plan/epics/030-transport-inventory-and-parity-contract.md`
Prereq: EPIC 029 (sequence order).

The transport's observable behaviour is written down as product behaviour in the proposal, and every
row of it is pinned by a test that passes against the current stack before any replacement exists.

## Dispatch order

1. `01-the-proposal-states-the-parity-contract.md` — documentation only, no source change.
2. `02-the-handler-result-inventory.md` — P21 to P25.
3. `03-body-parsing-parity.md` — P3 to P6.
4. `04-cors-parity.md` — P8 to P11.
5. `05-path-and-header-parity.md` — P16 to P19.

Each story is one commit and passes `npm run verify` on its own. **There is no coupled pair.**
Stories 2 to 5 are mutually independent: each adds exactly one new `.test.ts` file, none imports
another, and none moves a pinned count. Story 1 comes first because the proposal is the source of
truth for the behaviour the others pin.

**Five stories cover the EPIC's five story bullets, one to one.** No bullet is split and none is
merged.

## What each story adds, and what it must not touch

Stories 2 to 5 add one file each and change **no production file**:

| Story | File added                                   | Rows                     |
| ----- | -------------------------------------------- | ------------------------ |
| 2     | `src/http/server/app.handler-result.test.ts` | P21-P25, P11 (preflight) |
| 3     | `src/http/server/app.parity-body.test.ts`    | P3-P6                    |
| 4     | `src/http/server/app.parity-cors.test.ts`    | P8-P11                   |
| 5     | `src/http/server/app.parity-path.test.ts`    | P16-P19                  |

**P11 has two owners, and that is deliberate.** Story 4 covers every non-`OPTIONS` answer — the four
refusals, a `200`, and a request with no `Origin` — plus the `403` that carries no `Vary` at all.
Story 2 covers the preflight, because Story 4 drives no `OPTIONS` request and `preflight.test.ts`
proves the middleware rather than the chain. Neither story alone covers the row.

## Proof ownership

Every line of the EPIC's copy-paste Proof has one owner.

| Proof line                                       | Owner   |
| ------------------------------------------------ | ------- |
| `src/http/server/app.handler-result.test.ts`     | Story 2 |
| `src/http/server/app.parity-body.test.ts`        | Story 3 |
| `src/http/server/app.parity-cors.test.ts`        | Story 4 |
| `src/http/server/app.parity-path.test.ts`        | Story 5 |
| the other 18 files, and the `PASS EPIC-030` echo | Story 5 |

Story 5 is last, so it runs the block verbatim and must print `PASS EPIC-030`. The eighteen
pre-existing files are regression guards: no story edits one, and Stories 2, 3 and 4 each re-run the
subset nearest their own change.

`git diff --name-only` for each of those four commits names exactly one `.test.ts` path. The **eight**
rows the EPIC marks `(exist)` — P1, P2, P7, P12, P13, P14, P15 and P20 — get no new test, and no
story edits the file that holds one. Eight existing rows plus seventeen newly covered rows is the
full surface of twenty-five.

## Facts (needed for implementation)

Every fact below was read from the tree or observed by running it, not inferred.

- **`docs/proposal/phase-1/transport.md` is 98 lines, not 62.** The EPIC's Decisions section says 62.
  `## Browser access` opens at line 74 and ends at 86; line 87 is blank; `## A held request` opens at 88. Story 1's insertion point is between 87 and 88, exactly where the EPIC places it. The line count
  is the only figure that is wrong, and it changes nothing about the edit.

- **`dispatch.ts` is 63 lines.** The EPIC's Decisions section cites `src/http/server/dispatch.ts:51`
  for `readHeaders`, and that is right — `readHeaders` is at `:51-63`. The parity table's
  `dispatch.test.ts:352` is the **test** file, which is 539 lines, so that citation holds too. The
  response-header sort itself is at `dispatch.ts:42-46`.

- **The handler tree is exactly 44 files, and the EPIC's three claims about it are all true.**
  Verified by scan: `/:\s*Handler\b/` selects 44 files under `src/http/server/*/*.ts`;
  `/\bstatus:\s*(\d+)/g` yields `[200]` for 43 of them and `[200, 206]` for
  `src/http/server/blob/show-blob.ts`; the union is `[200, 206]`; and `show-blob.ts` is the one file
  matching `/headers:\s*\{|,\s*headers\s*\}/`. Story 2 pins those two regular expressions — do not
  substitute a different rule.

- **`createTestApp` is hermetic by construction.** `test/helpers/app.ts:135-136` defaults
  `now: () => 0` and `schedule: () => () => {}`, `:110` defaults `token: "test-token"`, `:111`
  defaults `allowedHosts: ["kanthord.test"]`, `:112` defaults `allowedOrigins: []`. No added test
  overrides `now` or `schedule`, and none needs a temporary directory or a remote.

- **`app.get` / `app.post` set `Host` and `Authorization`; `app.raw` sets neither**
  (`test/helpers/app.ts:141-174`). Story 4's `401` test needs `app.raw`. Story 5's header-name
  literals need `app.get`. Mixing the two breaks both.

- **`unimplementedFor(handlers)` is derived automatically** at `test/helpers/app.ts:130`, so binding
  one handler puts every other routed operation in `unimplemented` with no extra setup. Binding a
  **stubbed** id throws `BindingError` (`src/http/server/app.ts:151-177`) — `project.create` is
  `routed`, which is why Story 3 uses it for P6.

- **The two 501 messages differ, and both are pinned.** `dispatch.ts:20-24` answers
  `` `${operationId} ships in ${introducedIn}` `` for a **stubbed** operation, and `:26-32` answers
  `` `${operationId} is not implemented yet` `` for a **routed** operation with no bound handler.
  Story 3 asserts the second, for `project.create`. `dispatch.test.ts:88` already asserts the first.

- **`Vary: Origin` is written in a `finally` at `origin.ts:32-36` that sits outside the
  `if (origin !== undefined)` guard at `:19`.** So it is present with no `Origin` header, and absent
  only on the `403` thrown at `:20-25` before the `try`. Observed: the `403` carries no `vary` key at
  all — `response.headers["vary"]` is `undefined`, not `""`.

- **`Access-Control-Expose-Headers` is written only when the method is not `OPTIONS`**
  (`origin.ts:27-29`). Every request in Story 4 is a `GET`, so all four survival cases carry
  `"etag, accept-ranges, content-range"`. The preflight deliberately carries none, and Story 2 asserts
  the preflight answer.

- **Every `409` code requires a `details` argument.** `httpError` is overloaded so a `PreconditionCode`
  takes details as a required third argument (`src/http/contract/errors.ts:95-111`). Story 4 uses
  `httpError("lease-held", "held", { holder: "actor_01" })`.

- **A plain `Error` becomes `500 internal-error` with the message `"internal error"`**, and the
  original text never reaches the body (`src/http/server/envelope.ts:15-28`). The default
  `onInternalError` collector (`test/helpers/app.ts:118-124`) records it once, readable through
  `app.internalErrors()`.

- **The observed header-name lists, both used as literals in Story 5.** A `GET` through `app.get`
  records `["accept-encoding", "authorization", "connection", "host"]`; the same request with
  `X-Kanthord-Client` records those four plus `"x-kanthord-client"`. A `POST` carries a fifth name,
  `content-length`, even with no body sent — which is why no header-name assertion lives in Story 3.

- **`.set("X-Kanthord-Client", ["one", "two"])` puts the name on the wire twice and the handler
  records `"one, two"`.** Two separate `.set` calls overwrite instead. Node collapses the duplicate
  before `readHeaders` sees it, and `readHeaders`'s `Array.isArray` join at `dispatch.ts:61` covers
  the rest; the observable answer is the same either way, which is what P18 pins.

- **Both parity path values answer `200` and record the literal.** `/v1/blob/aa%2Fbb` records
  `{ hash: "aa%2Fbb" }` and `/v1/blob/aa%zz` records `{ hash: "aa%zz" }`. Nothing decodes a segment,
  and a malformed escape produces no refusal.

- **Story 5 must bind a bare recorder, not `showBlobHandler`.** The real handler validates against
  `blobHash` — `/^sha256:[0-9a-f]{64}$/` at `src/domain/blob.ts:5` — and would answer `400` for both
  path values.

- **All three empty-body cases record `{}` and answer `200`.** No body sent, `text/plain` with the
  payload `hello`, and `application/json` with a zero-length payload. Observed on
  `POST /v1/repository` with a bound recorder.

- **The JSON content type is `application/json; charset=utf-8`**, already pinned elsewhere at
  `src/http/server/idempotency-response.test.ts:44`. The `204` preflight has `response.text` of `""`
  and **no** `content-length` header.

- **The blob fixture template is `src/http/server/blob/show-blob.test.ts:9-24`**: content
  `Buffer.from("0123456789")`, hash `` `sha256:${createHash("sha256").update(content).digest("hex")}` ``,
  and a `handlerApp` helper binding `showBlobHandler({ showBlob })`. Story 2 mirrors it.
  `Range: bytes=0-4` on ten bytes yields `content-range: bytes 0-4/10` and `content-length: 5`
  (`src/http/server/blob/range.ts:23-33`).

- **The repo-root idiom for a scanning test is `new URL("../../../", import.meta.url).pathname`**,
  used at `src/http/contract/coverage.test.ts:496`, with `readdirSync(dir, { withFileTypes: true })`
  and `readFileSync`. `src/cli/inventory.test.ts:19-21` uses `resolve(import.meta.dirname, ...)` for a
  single file. Story 2 uses the first.

- **The recording-handler pattern is an in-place closure**, `dispatch.test.ts:247-261`. There is no
  shared HTTP recorder helper — `test/helpers/command-recorder.ts` is for CLI commands — and no story
  here adds one.

- **`src/http/server/preflight.test.ts:25-45` holds an `answerOf(response)` projection** that compares
  a whole answer over nine header names by `deepEqual`. Story 4 does not use it: it asserts three named
  headers per case, which is what the parity rows state, and a nine-header projection would pin
  headers no row names.

- **A story may edit `docs/proposal/`, and nothing else outside `.ts` and `.js`.**
  `scripts/lane-check.sh:99` grants that path to the software-engineer lane. Story 1 is therefore
  legal as written, and the test-engineer writes nothing for it.

- **The `AGENTS.md` test-boundary TODO does not block this epic.** It forbids opening another
  **phase-2** epic. This band is phase 1b, and the EPIC's Open items records the exemption. A reviewer
  must not report a pre-existing cross-layer test import as a defect of any story here.
