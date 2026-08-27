---
epic: .agents/plan/epics/033-dual-level-test-harness.md
opened: 2026-08-25
opener: test-engineer
base-ref: 5166d3ad1027dccb14acdacd1c5414d669b16a0a
---

# Implementation cycle — 033-dual-level-test-harness

Pulled from EPIC: `.agents/plan/epics/033-dual-level-test-harness.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   test/helpers/agent.test.ts \
>   test/helpers/app.test.ts \
>   test/helpers/socket-budget.test.ts \
>   src/http/server/app.test.ts \
>   src/http/server/auth.test.ts \
>   src/http/server/authorize.test.ts \
>   src/http/server/dispatch.test.ts \
>   src/http/server/envelope.test.ts \
>   src/http/server/host.test.ts \
>   src/http/server/idempotency.test.ts \
>   src/http/server/idempotency-key.test.ts \
>   src/http/server/idempotency-response.test.ts \
>   src/http/server/origin.test.ts \
>   src/http/server/preflight.test.ts \
>   src/http/server/route.test.ts \
>   src/http/server/shutdown.test.ts \
>   src/http/server/shutdown-socket.test.ts \
>   src/http/server/blob/show-blob.test.ts \
>   src/http/server/blob/range.test.ts \
>   src/http/server/event/list-event.test.ts \
>   src/http/server/event/wait.test.ts \
>   src/http/server/system/health.test.ts \
>   src/http/server/system/status.test.ts \
>   src/http/server/system/db.test.ts \
>   src/http/server/actor/registration.test.ts \
>   src/http/server/credential/register-provider.test.ts \
>   src/http/server/node/claim-node.test.ts \
>   src/http/server/plan/import-plan.test.ts \
>   src/http/server/project/show-project-graph.test.ts \
>   src/http/server/repository/register-repository.test.ts \
>   src/main.claim.test.ts \
>   && echo "PASS EPIC-033"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
>
> - **The pass count rises by exactly 21.** Record the baseline at the base commit of this epic with
>   `node --test 2>&1 | grep -m1 '^# pass'`, and record the same value after story 7. The second value
>   equals the first plus 21: 1 from story 1, 14 from story 2, 4 from story 6 and 2 from story 7.
>   Stories 3, 4 and 5 add 0 and drop 0. Any other delta is a blocker, and the failing story is the
>   one whose named count does not match.
>
> - **Group A changes zero lines.** After story 3, `git diff --stat <base>..HEAD -- <the 44 group-A
paths>` reports no changed file. This is the check, not the pass count.
>
> - **The group membership is recomputed, not assumed.** Before story 4, run
>   `grep -rlE 'loopback(Agent|Server)' --include='*.test.ts' src test` and
>   `grep -rl createTestApp --include='*.test.ts' src test`. The two lists define groups A, B and C,
>   less the 5 rows of the level-2 table. `src/http/server/blob/show-blob.test.ts` matches the second
>   grep and is level 2, so it joins no group.
>   `src/main.claim.test.ts` matches the second grep on a string literal and belongs to no group.
>
> - **Every EPIC 030 parity test still passes**, at the level EPIC 030 declares, with the same
>   expected values.
>
> - **Ephemeral-port resolution is proved, and `test/helpers/agent.test.ts` owns it.** The existing
>   case `binds the loopback address and never the wildcard` asserts `address.address === "127.0.0.1"`.
>   The story-1 case asserts `typeof address.port === "number"` and `address.port > 0`. An ephemeral
>   port has no exact value, so the property is the assertion; nothing else in the suite may assert a
>   port number.
>
> - **The Host header a client sends with no override is `127.0.0.1:<port>`, and
>   `src/http/server/host.test.ts:48` owns it.** That case exists today and keeps its name and its
>   assertion.
>
> - **A binary 206 range response is proved on the wire, and `src/http/server/blob/show-blob.test.ts`
>   owns it.** `Range: bytes=0-4` answers 206, `content-range: bytes 0-4/10`, and a body equal to
>   `Buffer.from("01234")` byte for byte. Those cases exist today and take no edit.
>
> - **Graceful shutdown is proved, and `src/http/server/shutdown-socket.test.ts` owns it.** Its 3
>   story-6 cases are the only owners. The drain is asserted by order, never by a delay.
>
> - **Two `set-cookie` values survive the wire, and the story-6 case in
>   `test/helpers/agent.test.ts` owns it.** The assertion is
>   `assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"])`. Level 1 cannot own this, and
>   the `Agent` contract joins the two values by rule 1, so no level-1 file may assert `set-cookie`.
>
> - **Level 1 opens no listening socket, and case 14 of story 2 owns it.** It captures
>   `process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length` before and after a
>   `fetchAgent` request and asserts the two numbers are equal. The literal is `TCPServerWrap`, in
>   that exact case.
>
> - **Every level-2 server stays unref'd, and case 14 of story 2 owns that too.**
>   `process.getActiveResourcesInfo()` reports only a resource that keeps the event loop alive, so an
>   unref'd listener never appears in it. The case therefore runs after the file's level-2 servers
>   exist and still finds no `TCPServerWrap`. No requirement asserts the state of the whole suite
>   after the whole run: `node --test` runs each file in its own process, and the daemon tests listed
>   in the Goal hold ref'd sockets by design.
>
> - **No test depends on a wall clock, a shared temporary directory, or an ambient git
>   configuration.** A test that needs a clock uses `test/helpers/virtual-clock.ts`. A test that needs
>   a home uses its own `mktemp` directory and removes it.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — pin the level-2 primitive · Story 1 (ephemeral-port case)

**Cycle.** Executed Story 1 in full (`test/helpers/agent.test.ts`, one new case). First TE turn of this EPIC: no prior RED outstanding. Lane note for the loop — every path this EPIC edits (`src/**/*.test.ts`, `test/helpers/**`) is denied to the software-engineer by `scripts/lane-check.sh`; the SE lane owns only `src/**` non-test files, of which this EPIC touches none. So each story's change set is test-engineer work made in-turn; nothing below opens a seam.

**Test written.**

- file: `test/helpers/agent.test.ts` (edited) — suite: `test/helpers/agent.test` — methods: `reports an assigned ephemeral port`
- asserts: `(await loopbackServer(new Koa())).address()` yields a non-null object whose narrowed `port` is `typeof number` and `> 0`; no exact port asserted. The four existing cases keep name and body byte-for-byte; the new case sits fifth.

**Characterization + sensitivity.** The case passed on first run — intended: it pins shipped level-2 behaviour (`loopbackServer` already listens with `listen(0, "127.0.0.1")`). Sensitivity proved by probe, not assumed: against an unbound `createServer()`, `typeof address` still reads `"object"` (so the type assert alone would be vacuous) but `assert.notEqual(address, null)` rejects with `Expected "actual" to be strictly unequal to: null` — the case distinguishes bound from unbound sockets, and the port predicates reject any zero/non-numeric placeholder.

**Verification.**

- command: `node --test test/helpers/agent.test.ts` → exit 0 — `ℹ tests 5 / ℹ pass 5 / ℹ fail 0`
- command: `npm run typecheck` → exit 0
- command: `npm run verify` → exit 0 — full suite `tests 5285 / pass 5285 / fail 0`, final line `kanthord: verify db status ok`
- pass-count delta vs EPIC 032 close (5284): **+1 = exactly Story 1's named count**
- diff discipline: `git status --short` shows exactly `test/helpers/agent.test.ts` (+11 lines); `test/helpers/agent.ts` untouched per story constraint

**Next Task.** Story 2 (`02-add-the-level-1-fetch-agent.md`) — `fetchAgent`/`Agent`/`AgentRequest`/`AgentResponse` land in `test/helpers/agent.ts` with its 14 contract cases in `test/helpers/agent.test.ts`. Both files are test-engineer lane, so that story is also executed in-turn; no software-engineer action exists anywhere in this EPIC unless a review blocker names a production file.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 033-dual-level-test-harness · lane audit: no SE-lane work exists in Stories 2–7

**Cycle.** Response to the last TEST-ENGINEER turn. That turn executed Story 1 in-turn (green, `+1` case) and named Story 2 as next. It left no failing test and no production seam: Story 2 edits only `test/helpers/agent.ts` and `test/helpers/agent.test.ts`, both denied to this role.

**Lane audit (probe-verified).**

- `bash scripts/lane-check.sh software-engineer test/helpers/agent.ts` → exit 1 — "test helpers are the test-engineer lane"
- `bash scripts/lane-check.sh software-engineer test/helpers/app.ts` → exit 1 — same reason
- `bash scripts/lane-check.sh software-engineer src/http/server/auth.test.ts` → exit 1 — "a test file is not the software-engineer lane"

**OPEN:**

- OPEN: `test/helpers/agent.ts` + `test/helpers/agent.test.ts` — story 2 needs `fetchAgent`/`Agent`/`AgentRequest`/`AgentResponse` added to the helper and its 14 contract cases appended; both paths are test-engineer lane, so this role cannot implement.
- OPEN: `test/helpers/app.ts`, `test/helpers/app.test.ts`, `src/http/server/blob/show-blob.test.ts` — story 3's level-1 swap of `createTestApp` plus `createSocketTestApp`; all three paths are TE lane.
- OPEN: group B (`src/http/server/auth.test.ts`, `envelope.test.ts`, `idempotency-key.test.ts`, `idempotency-response.test.ts`, `origin.test.ts`, `preflight.test.ts`) — story 4 migration; every `src/**/*.test.ts` path is TE lane.
- OPEN: group C (`src/http/server/authorize.test.ts`, `dispatch.test.ts`, `route.test.ts`) — story 5 migration; same denial.
- OPEN: `src/http/server/shutdown-socket.test.ts` (new) + 1 case in `test/helpers/agent.test.ts` — story 6; TE lane.
- OPEN: `test/helpers/socket-budget.test.ts` (new) — story 7; TE lane.

**Files changed.** None. The EPIC states it "edits test files and two test helpers ... no production module"; the probes confirm no software-engineer path exists anywhere in Stories 2–7. A TE hand-off naming helper or test paths does not move them into this lane, so nothing remains for this role to implement. The tree is untouched by this turn.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: the three lane denials above were reproduced by running `scripts/lane-check.sh` (exit 1 per path).
- VERIFIED: `.agents/plan/stories/**` is empty on disk — the EPIC carries its stories inline, so task ids follow the EPIC numbering.
- UNVERIFIED: whether `/work` should skip software-engineer turns entirely for this EPIC; that routing decision belongs to the human.

ATTEMPT-FAILED: story-2 — all paths the task edits (`test/helpers/agent.ts`, `test/helpers/agent.test.ts`) are denied to software-engineer by `scripts/lane-check.sh`; nothing else in the story sits in lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the level-1 fetch agent · Story 2 (fetchAgent + 14 contract cases)

**Cycle.** Executed Story 2 in full. Both of its files sit in the test-engineer lane (`AGENTS.md`: every file under `test/helpers/**` is TE-owned), exactly as the prior software-engineer lane audit recorded; no seam opens to the software engineer anywhere in this EPIC. Story 1's case still passes inside today's run (19 = 5 existing + 14 new).

**Test written.**

- file: `test/helpers/agent.test.ts` (edited) — suite: `test/helpers/agent.test` — methods appended in story order: `reports a response header name in lower case`, `joins two values of one header name with ', ', set-cookie included`, `parses a JSON content type into body`, `buffers a non-JSON content type into body`, `keeps an empty body as {}`, `decodes text as UTF-8`, `sets content-type application/json when .send passes an object`, `keeps a content-type the caller set before .send`, `sends a string payload verbatim and sets no content type`, `delays dispatch until the first await, so .set after the call reaches the app`, `serves both awaits of one request from one application call`, `reaches the application with the OPTIONS method through options()`, `routes delete() and del() both through the DELETE method`, `leaves process.getActiveResourcesInfo() with no new TCPServerWrap`
- asserts: the 14 contract rules of the EPIC Decisions — lower-case headers with duplicates joined `", "` including `set-cookie`; JSON content type → parsed object, non-JSON → `Buffer`, empty body → `{}` with the empty check ordered before `JSON.parse` even under a JSON content type; `text` UTF-8; `.send(object)` defaults `application/json` only when unset while `.send(string)` goes verbatim with no content type; dispatch lazy until first await and memoized (one handler call, identical response object); `options`/`delete`/`del` method mapping; hermeticity pair — no `TCPServerWrap` appears around a `fetchAgent` request, and the case runs last so the file's level-2 servers already exist.
- file: `test/helpers/agent.ts` (edited) — added `AgentResponse` / `AgentRequest` / `Agent` types and `fetchAgent<E extends Env>(app: Hono<E>)` per the Decisions (lazy memoized dispatch over `app.request`, duplicate-header join incl. `set-cookie`, three-way body rule, `.buffer()` identity). The five existing cases keep name and body byte-for-byte.
- diff discipline: `git diff -U0 -- test/helpers/agent.ts` touches only the import block (+1) and appends after `loopbackAgent`; `loopbackServer` and `loopbackAgent` are byte-for-byte unchanged.

**RED proof.**

- command: `node --test test/helpers/agent.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './agent.ts' does not provide an export named 'fetchAgent'`

**GREEN proof.**

- command: `node --test test/helpers/agent.test.ts` → exit 0 — `ℹ tests 19 / ℹ pass 19 / ℹ fail 0` (exactly story-named +14 over Story 1's 5)
- command: `npm run typecheck` → exit 0
- command: `npx eslint test/helpers/agent.ts test/helpers/agent.test.ts` → exit 0
- command: `node --test test/helpers/app.test.ts` → exit 0, 4/4 (consumer sanity; its level-1 swap is Story 3)

**Runtime probes recorded (re-verified this toolchain, not cited from memory).**

- Node 24.17: a constructed `Response.headers` accepts repeated `set-cookie` appends and iterates once per value — the builder's join-on-repeated-key is load-bearing for rule 1.
- Hono 4.13.3: `app.request()` returns `Response | Promise<Response>`; a synchronous chain yields a bare `Response`. The first GREEN attempt failed 11 cases with `TypeError: app.request(...).then is not a function`; normalizing through `Promise.resolve` fixed it, re-run green above.

**Pass-count ledger.** Baseline 5284 (EPIC 032 close) → 5285 after Story 1 (+1) → expected 5299 after this story (+14); the full-suite delta re-check happens at the Verification gate.

**Next Task.** Story 3 — `createTestApp` runs at level 1 via `fetchAgent(hono)`, plus `createSocketTestApp(overrides?)` and the `show-blob.test.ts` retarget; again TE-lane only (`test/helpers/app.ts`, `test/helpers/app.test.ts`, `src/http/server/blob/show-blob.test.ts`), adds exactly 0 cases.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 033-dual-level-test-harness · Story 3 blocked: all three paths are TE lane

**Cycle.** Response to the last TEST-ENGINEER turn (Story 2 green; next Task named = Story 3). The stories are now expanded on disk (`.agents/plan/stories/033-dual-level-test-harness/`), and `03-move-create-test-app-to-level-1.md` names exactly three files under Change — every one is test-engineer lane. There is no RED outstanding and no production seam anywhere in the story, so nothing else sits in this role's lane to implement.

**OPEN:**

- OPEN: `test/helpers/app.ts` — replace the supertest type import with `Agent`/`AgentRequest`, import `fetchAgent` beside retained `loopbackAgent` and the `App` type from `src/http/server/app.ts`; retype `TestApp.raw` to `Agent` and `get`/`post`/`put`/`del`/`drive`/`driveRaw` returns to `AgentRequest`; extract private `createTestAppWithAgent(overrides, createAgent)` with the story's exact signature; export `createTestApp(overrides?)` via `fetchAgent(created.hono)` and new `createSocketTestApp(overrides?)` via `loopbackAgent(created.app)`.
- OPEN: `test/helpers/app.test.ts` — swap Supertest type names for `Agent`/`AgentRequest` at their existing sites; keep the 4 case names and every assertion unchanged.
- OPEN: `src/http/server/blob/show-blob.test.ts` — change the `createTestApp` import site and the `handlerApp` call to `createSocketTestApp` with the same overrides; no other line changes.

**Lane probes (re-run this turn).**

- `bash scripts/lane-check.sh software-engineer test/helpers/app.ts` → exit 1 — "test helpers are the test-engineer lane"
- `bash scripts/lane-check.sh software-engineer test/helpers/app.test.ts` → exit 1 — "test helpers are the test-engineer lane"
- `bash scripts/lane-check.sh software-engineer src/http/server/blob/show-blob.test.ts` → exit 1 — "a test file is not the software-engineer lane"

Stories 4–7 likewise name only `src/**/*.test.ts` and `test/helpers/**` paths (`04` group B, `05` group C, `06` shutdown-socket + agent.test case, `07` socket-budget.test); the EPIC header states it edits no production module, so no later story opens work to this role either.

**Files changed.** None — tree untouched by this turn.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: `.agents/plan/stories/033-dual-level-test-harness/` holds 7 story files plus `index.md`; Story 3's Change section names exactly the three paths above and its Constraints forbid editing any production file or manifest.
- VERIFIED: `git status --short` shows only TE-lane edits (`test/helpers/agent.ts`, `test/helpers/agent.test.ts`) plus memory/history files — consistent with Stories 1–2 having been TE in-turn work.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — move createTestApp to level 1 · Story 3 — blocked on a planning defect

**Cycle.** Executed Story 3 in turn (all three named paths are TE lane). The three story-named edits are complete and green. Full-suite verification then exposed 5 failing EPIC 030 parity assertions in two files that EPIC 033's tables never classify, and no implementation can satisfy the EPIC's three binding constraints for them at once. Raised `OPEN:` for the human; details and evidence below.

**Changes made (all TE-lane).**

- file: `test/helpers/app.ts` (edited) — supertest import replaced by `Agent`/`AgentRequest` from `./agent.ts`; `App` type imported beside `createApp`; `TestApp.raw` typed `Agent`; `get`/`post`/`put`/`del`, `drive`, `driveRaw` return `AgentRequest`; factory body extracted into private `createTestAppWithAgent(overrides, createAgent)` with the story-exact signature; exported `createTestApp` calls `fetchAgent(created.hono)`; new exported `createSocketTestApp(overrides?)` calls `loopbackAgent(created.app)`.
- file: `test/helpers/app.test.ts` (edited: zero lines) — contains no Supertest type name (verified by full read), so the story's conditional edit is empty; 4 case names untouched.
- file: `src/http/server/blob/show-blob.test.ts` (edited) — import site and `handlerApp` call renamed to `createSocketTestApp`; no other line.
- file: `test/helpers/agent.ts` (edited, harness repair — see Finding 2/3): dispatch defers `app.request` by one microtask (`Promise.resolve().then(() => app.request(...))`) so application invocation leaves the caller's synchronous stack, matching supertest's I/O-deferred semantics; `.send()` payload dropped for GET/HEAD because undici forbids a body on those methods and level 1 cannot express one.

**Story-3-scoped verification (green).**

- `node --test test/helpers/app.test.ts src/http/server/blob/show-blob.test.ts src/http/server/app.test.ts src/http/server/dispatch.test.ts` → exit 0 — `ℹ tests 83 / ℹ pass 83 / ℹ fail 0`
- `npm run typecheck` → exit 0 (also completes the EPIC's structural proof: supertest's return satisfies `Agent`; both factories satisfy `Promise<TestApp>`)
- `npx eslint` over the four edited files → exit 0

**Full-gate verification (red — the reason for this turn).**

- command: `npm run verify`
- exit: 1 — `ℹ tests 5299 / ℹ pass 5294 / ℹ fail 5` (total matches the story-2 ledger exactly: 5284 + 1 + 14 + 0)
- failures, verbatim:
  - `app.handler-result.test.ts:230` — `undefined !== '10'` (response `content-length`)
  - `app.handler-result.test.ts:247` — `undefined !== '5'` (206 response `content-length`)
  - `app.parity-path.test.ts:44` — actual `'one,two'` expected `'one, two'` (duplicate request header join)
  - `app.parity-path.test.ts:53` — actual `['authorization','host','x-kanthord-client']` expected `['accept-encoding','authorization','connection','host','x-kanthord-client']`
  - `app.parity-path.test.ts:65` — actual `['authorization','host']` expected `['accept-encoding','authorization','connection','host']`

**Findings.**

1. - status:OPEN - action:YES - two parity files are unclassified - `src/http/server/app.parity-path.test.ts` and `src/http/server/app.handler-result.test.ts` appear in no EPIC 033 table: not among the 44 group-A paths, not among the 5 level-2 rows - fix: add both to the level-2 table as rows 6–7, retarget each to `createSocketTestApp` (one-line change per file), and amend story 7 to a budget of 7 with both paths in the asserted list - why: EPIC 032 story 16 runs their blob rows "through the full bridge", and P18/P19/P24 pin node-write artifacts — `content-length` is computed by `@hono/node-server`'s `getRequestListener` on write, not by the Fetch pipeline (`render.ts` builds `new Response(body, {status, headers})`); `accept-encoding`/`connection` are node:http client defaults; the `", "` duplicate join is HTTP wire semantics that undici Headers coalesces to `","`.
2. - status:FIXED - action:YES - fetchAgent dispatched on the caller's stack - `.then` attachment executed the handler synchronously, so concurrent long-poll registrations fired before the test stored their resolvers (`list-event.test.ts` "two waiting requests resolve independently" hung 60 s) - fix: defer `app.request` by one microtask inside `dispatch()`; lazy-until-first-`then` and memoization contracts preserved - why: level 2 always deferred through socket I/O; the level-1 harness must not change when registration side effects run.
3. - status:FIXED - action:YES - `.send()` on GET crashed undici - `Request with GET/HEAD method cannot have body` at `list-event.test.ts:722` (group A, zero-line file) - fix: drop the payload for GET/HEAD in `dispatch()`; the case's assertion (handler answers 200 ignoring junk) holds unchanged - why: the Fetch pipeline structurally cannot carry a GET body.

**Why blocked, not fixed.** Constraint A: parity tests pass "with the same expected values" — values include the three wire artifacts above. Constraint B: recomputed group A changes zero lines — the recompute greps place both files in it. Constraint C: story 7 locks the socket budget at exactly the 5 named rows. Level 1 falsifies A without header fabrication, which would corrupt what level 1 proves; level 2 violates B and C. Only a plan amendment (Finding 1) resolves this; the amendment is outside every lane.

**State left behind.** All edits stay in the working tree; the 5 parity failures remain visible as evidence. To restore the pre-story-3 green state instead, revert `test/helpers/app.ts` and the `show-blob.test.ts` import to `createTestApp` — stories 1–2 remain intact either way.

**Open to Software Engineer.**

- none — no production seam exists in this EPIC; the blocker names locked plan files, which only the human may amend.

END: TEST-ENGINEER

## TEST-ENGINEER — move createTestApp to level 1 · Story 3 completed after plan amendment

**Cycle.** Resumed Story 3 on Ulrich's binding directive after the plan amendment resolved the `OPEN:` raised last turn. Re-read the amended story (`03-move-create-test-app-to-level-1.md`) before editing: its Change section now carries seven sections (three original + array-header form, parity-path literal update, handler-result retarget) and its Verify section names the numstat budget and the six-path diff list. Kept every existing tree edit — `test/helpers/app.ts`, the empty-but-checked `test/helpers/app.test.ts`, `src/http/server/blob/show-blob.test.ts`, and the two harness repairs in `test/helpers/agent.ts` (microtask-deferred dispatch, GET/HEAD body drop). Made the three remaining edits below. No case added, none removed.

**Changes made (all TE-lane).**

- file: `test/helpers/agent.ts` (edited) — widened `AgentRequest.set` to `(name: string, value: string | readonly string[])`; request headers moved from `Map<string, string>` to a Fetch `Headers`; string value calls `headers.set`, array value calls `headers.delete(name)` then `headers.append(name, element)` per element — never `headers.set` with an array; dispatch passes the `Headers` instance straight into `RequestInit` (undici combines two appends to `"one, two"`, which is what P18 pins); `send()`'s content-type guard switched to `headers.has`.
- file: `src/http/server/app.parity-path.test.ts` (edited, stays level 1) — removed both `as unknown as string` casts (lines 41, 49); removed `"accept-encoding"` and `"connection"` from the three P19 arrays; line 44 keeps `"one, two"` unchanged; arrays now exactly `["authorization", "host", "x-kanthord-client"]`, `["authorization", "host"]`, `["authorization", "host"]`.
- file: `src/http/server/app.handler-result.test.ts` (edited, becomes level-2 row 6) — import plus all four call sites renamed `createTestApp` → `createSocketTestApp`; zero assertion changes; the exact `content-length` assertions at :230/:247 stand unrelaxed and now pass over a real socket; file not split.

**Verification.**

- command: `node --test test/helpers/app.test.ts src/http/server/blob/show-blob.test.ts src/http/server/app.test.ts src/http/server/app.parity-path.test.ts src/http/server/app.handler-result.test.ts` → exit 0 — `ℹ tests 64 / ℹ pass 64 / ℹ fail 0`; the five previously failing parity assertions all pass at their amended levels.
- command: `git diff --numstat -- src/http/server/app.parity-path.test.ts` → exactly `2	8` (two cast lines rewritten in place, six deleted expectation entries), inside the story budget.
- command: `npm run typecheck` → exit 0.
- command: `npm run verify` → exit 0 — `ℹ tests 5299 / ℹ pass 5299 / ℹ fail 0`, final line `kanthord: verify db status ok`. Pass count matches the ledger exactly: 5284 baseline +1 (story 1) +14 (story 2) +0 (story 3) = 5299, no case added or dropped.

**Diff-scope disclosure.** `git diff --name-only` over the story's six named paths lists five (all above; `test/helpers/app.test.ts` legitimately empty — it contains no Supertest type name). The tree additionally holds one pre-existing edit outside those paths: `src/http/server/dispatch.test.ts` drops one supertest-only `.parse((incoming, callback) => …)` chain onto `app.get("/v1/health")` — the level-1 `AgentRequest` contract has no `parse`, so typecheck cannot pass with the old form and the edit is retained under the KEEP directive. `dispatch.test.ts` is group C, not group A, so the group-A zero-line gate is unaffected; stories 4–5 will rewrite that file wholesale anyway.

**Next Task.** Story 4 — group B (`auth`, `envelope`, `idempotency-key`, `idempotency-response`, `origin`, `preflight`) moves to level 1: `loopbackAgent` → `fetchAgent(hono)`, drop the `await`s, `preflight.test.ts` swaps `request.Response` for `AgentResponse`. Adds exactly 0 cases. TE lane throughout; before it, the gate requires recomputing group membership with the two greps.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 033-dual-level-test-harness · Story 4 blocked: every named path is TE lane

**Cycle.** Response to the last TEST-ENGINEER turn (Story 3 green after the plan amendment; next Task named = Story 4). Story 4's Change section names only the six group-B files under `src/http/server/`. There is no RED outstanding, no production seam, and no `src/**` non-test path anywhere in the story, so nothing sits in this role's lane to implement. The tree is untouched by this turn.

**OPEN:**

- OPEN: `src/http/server/auth.test.ts`, `src/http/server/envelope.test.ts`, `src/http/server/idempotency-key.test.ts`, `src/http/server/idempotency-response.test.ts`, `src/http/server/origin.test.ts` — at each helper import replace `loopbackAgent` with `fetchAgent`, remove only the await resolving the helper, keep response awaits, and pass the `hono` half where `createApp` builds the application; every path is `src/**/*.test.ts`, test-engineer lane.
- OPEN: `src/http/server/preflight.test.ts` — the same migration plus the story's type swap (`request.Response` → `AgentResponse`, supertest type import replaced) where those names still appear; same denial.

The two inventory greps the gate requires before story 4 run in the test-engineer's own turn. Stories 5–7 likewise name only `src/**/*.test.ts` and `test/helpers/**` paths (`05` group C, `06` shutdown-socket + agent.test case, `07` socket-budget.test), and the EPIC header states it edits no production module, so no later story opens work to this role either unless a review blocker names a production file.

**Lane probes (re-run this turn).**

- `bash scripts/lane-check.sh software-engineer src/http/server/auth.test.ts` → exit 1 — "a test file is not the software-engineer lane"
- `bash scripts/lane-check.sh software-engineer src/http/server/envelope.test.ts` → exit 1 — same
- `bash scripts/lane-check.sh software-engineer src/http/server/idempotency-key.test.ts` → exit 1 — same
- `bash scripts/lane-check.sh software-engineer src/http/server/idempotency-response.test.ts` → exit 1 — same
- `bash scripts/lane-check.sh software-engineer src/http/server/origin.test.ts` → exit 1 — same
- `bash scripts/lane-check.sh software-engineer src/http/server/preflight.test.ts` → exit 1 — same

**Files changed.** None — tree untouched by this turn.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: the six denials above were reproduced by running `scripts/lane-check.sh` (exit 1 per path) against the exact paths Story 4's Change section names.
- VERIFIED: `git status --short` shows the working tree holding only TE-lane edits from Stories 1–3 (`test/helpers/**`, five `src/**/*.test.ts` files) plus plan/memory/history files — no SE-lane file modified.

ATTEMPT-FAILED: story-4 — all six paths the task edits are `src/**/*.test.ts`, denied to software-engineer by `scripts/lane-check.sh`; nothing else in the story sits in lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — move group B to level 1 · Story 4 executed

**Cycle.** Executed Story 4 in turn (every path it names is TE lane; the prior software-engineer turn recorded the denial and changed nothing). Ran both gate-mandated inventory greps before editing. No case added, none removed.

**Membership recompute (binding step before the edit).**

- `grep -rlE 'loopback(Agent|Server)' --include='*.test.ts' src test` → 11 files.
- `grep -rl createTestApp --include='*.test.ts' src test` → 51 files today. Disclosure for story 7's benefit: this grep also matches `createSocketTestApp`, so `show-blob.test.ts` and `app.handler-result.test.ts` appear in it as substrings — consistent with the amended plan's level-2 rows 5–6.
- Recomputed group B (direct `loopbackAgent` importers with no `createTestApp`, less the six level-2 rows): `auth.test.ts`, `origin.test.ts`, `preflight.test.ts`, `idempotency-key.test.ts`.
- EPIC rows `envelope.test.ts` and `idempotency-response.test.ts` match **neither** grep — EPIC 032 rewrote them into pure unit tests that reach no helper. Per the story rule ("do not edit an EPIC row absent from the result") they take no edit and join no group. Remaining grep-1 hits after migration are exactly the 4 group-C files plus the 3 level-2 files that keep sockets by design.

**Changes made (all TE-lane).**

- file: `src/http/server/auth.test.ts` (edited) — import `loopbackAgent` → `fetchAgent`; every `(await loopbackAgent(X))` → `fetchAgent(X)`; `buildApp`/`buildRecordingApp` hand out the fixture's own `Hono<AppEnv>` instead of wrapping it with `koaFromHono`; the now-unused `koa` type import and `koa-bridge.ts` import deleted. Zero assertion lines touched.
- file: `src/http/server/origin.test.ts` (edited) — same migration shape; `buildApp` returns `hono`; all 20 call sites swapped by one literal replacement. Zero assertion lines touched.
- file: `src/http/server/preflight.test.ts` (edited) — same migration shape, plus the two story-named edits at `answerOf`: `import type request from "supertest"` replaced by an `AgentResponse` type import from `test/helpers/agent.ts`, and the `request.Response` annotation replaced by `AgentResponse`. `buildApp` returns `hono`. Zero assertion lines touched.
- file: `src/http/server/idempotency-key.test.ts` (edited) — mechanical rules could not apply as-is: its `raw body preservation (vendor probe)` describe drove a koa + `@koa/bodyparser` rig through `loopbackAgent`, and no rule migrates a koa-only fixture to a Fetch pipeline. Resolution keeps the constraint set intact without fabricating logic: `probeApp()` now drives the **production** `bodyMiddleware` exactly the way `body.test.ts` does — install a contract-typed `RouteMatch` (`Operation` from `http/contract`), bind one handler, terminal handler echoes `{ raw: optional(c, "rawBody") ?? null }`. The three case names, requests (`.post("/")` + `.set(Content-Type)` + `.send(...)` literals), status assertions and `response.body.raw` assertions are verbatim unchanged; each `null` now comes from a real production branch (non-admitted media type leaves `rawBody` unset; GET is skipped by the body-method gate) rather than from fixture code, and case 1 pins byte-exact delivery through `fetchAgent.send(string)` into production raw-body capture. The describe label stays byte-for-byte per the keep-every-suite-name constraint. `@koa/bodyparser`'s last consumer is gone; the manifest entry sits untouched until EPIC 035 per S1/S2.

**Verification.**

- command: `node --test src/http/server/{auth,envelope,idempotency-key,idempotency-response,origin,preflight}.test.ts` → exit 0 — `ℹ tests 109 / ℹ pass 109 / ℹ fail 0`
- per-file case counts, unchanged pre- to post-story: auth 13, envelope 13, idempotency-key 45, idempotency-response 9, origin 19, preflight 10; `git diff | grep -cE '^[+-].*\it\('` over the four edited files → `0`
- recompute re-run: no recomputed group-B file names `loopbackAgent` (grep 1 residue = app/dispatch/route/authorize [group C] + host/idempotency/agent.test [level 2])
- command: `npm run typecheck` → exit 0
- command: `npx eslint` over the four edited files → exit 0
- command: `npm run verify` → exit 0 — `ℹ tests 5299 / ℹ pass 5299 / ℹ fail 0`, final line `kanthord: verify db status ok`. Pass count equals Story 3's close exactly (5284 + 1 + 14 + 0 + 0): Story 4 adds 0 and drops 0, as named.
- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`

**Next Task.** Story 5 — group C (`authorize.test.ts`, `dispatch.test.ts`, `route.test.ts`) applies the story-4 edit where both paths converge on level 1; adds exactly 0 cases. Note for that turn: `dispatch.test.ts` already carries the retained supertest `.parse()` drop from Story 3, so its diff will not be a pure literal swap.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 033-dual-level-test-harness · Story 5 blocked: all three named paths are TE lane

**Cycle.** Response to the last TEST-ENGINEER turn (Story 4 green, +0 cases; next Task named = Story 5). Story 5's Change section names only `src/http/server/authorize.test.ts`, `src/http/server/dispatch.test.ts` and `src/http/server/route.test.ts`, plus the two inventory greps that run in the editor's own turn. Every edit path is a test file — denied to this role by `scripts/lane-check.sh`, and a TE hand-off naming a test path does not move it into this lane. There is no RED outstanding and no production seam anywhere in the story, so nothing sits in this role's lane to implement. The tree is untouched by this turn.

**OPEN:**

- OPEN: `src/http/server/authorize.test.ts` + `src/http/server/route.test.ts` — at each helper import replace `loopbackAgent` with `fetchAgent`; remove only the await that resolved the helper; keep the awaits that resolve responses; pass the `hono` half where `createApp` builds the application; keep every suite name, case name, request and assertion unchanged.
- OPEN: `src/http/server/dispatch.test.ts` — the same migration; the file additionally carries the TE-retained supertest `.parse()` drop from Story 3 in the working tree (`git status` shows it modified), so its diff will not be a pure literal swap.

**Lane probes (re-run this turn).**

- `bash scripts/lane-check.sh software-engineer src/http/server/authorize.test.ts` → exit 1 — "a test file is not the software-engineer lane"
- `bash scripts/lane-check.sh software-engineer src/http/server/dispatch.test.ts` → exit 1 — same
- `bash scripts/lane-check.sh software-engineer src/http/server/route.test.ts` → exit 1 — same

Stories 6–7 likewise name only test-lane paths (`src/http/server/shutdown-socket.test.ts` + a case in `test/helpers/agent.test.ts`; `test/helpers/socket-budget.test.ts`) and the EPIC header states it edits no production module, so no later story opens work to this role either unless a review blocker names a production file.

**Files changed.** None.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: the three denials above were reproduced by running `scripts/lane-check.sh` against the exact paths Story 5's Change section names.
- VERIFIED: no `DEBATE_GUIDELINE:` block exists in the discussion file; its last engineer turn is TEST-ENGINEER (Story 4 executed).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — move group C to level 1 · Story 5 — clean migrations landed; two misinventoried files need a human amendment

**Cycle.** Executed Story 5 in turn (every path it names is TE lane; the prior software-engineer turn recorded that denial and changed nothing). Ran both inventory greps before editing. Migrated every recomputed group-C member whose cases have a level-1 expression. Two files cannot satisfy the story and Story 7 at once under the current tables; `OPEN:` below with evidence. Handoff gate re-verified first (`npm run verify:handoff` → `VERIFY: PASS`, exit 0). No case added, none removed.

**Membership recompute (binding step before the edit).**

- `grep -rlE 'loopback(Agent|Server)' --include='*.test.ts' src test` → 7 files.
- `grep -rl createTestApp --include='*.test.ts' src test` → 51 files (matches `createSocketTestApp` as a substring; `src/main.claim.test.ts` matches on a string literal only).
- Recomputed group C = in both lists, less the six level-2 rows = `app.test.ts`, `authorize.test.ts`, `dispatch.test.ts`, `route.test.ts`. The EPIC's fixed rows put `app.test.ts` in group A and cap group C at 3 files; the operational rule wins per the EPIC ("a group row that no longer matches is not a defect of the story"), so all four fell to this story.

**Changes made (all TE-lane). Zero assertion lines touched anywhere (`git diff | grep -E '^[+-].*assert'` over the three files → empty; `it(` churn 0).**

- file: `src/http/server/authorize.test.ts` (edited) — import `loopbackAgent` → `fetchAgent`; `await loopbackAgent(koaFromHono(hono))` → `fetchAgent(hono)`; unused `koaFromHono` import deleted. Both paths level 1. numstat 2/3.
- file: `src/http/server/route.test.ts` (edited) — same migration across its 6 call sites; `buildApp` returns the fixture's own `Hono<AppEnv>` instead of wrapping it with `koaFromHono`; unused `koa` type and `koa-bridge` imports deleted. Both paths level 1. numstat 9/15.
- file: `src/http/server/dispatch.test.ts` (edited) — the four mechanical `loopbackAgent(koaFromHono(hono))` sites migrated to `fetchAgent(hono)`; import line now `{ fetchAgent, loopbackServer }`. The local `rawResponse` helper and its three callers keep `loopbackServer` untouched — see B2. numstat 6/18 including the retained Story-3 `.parse()` drop.

**Story-scoped verification (green).**

- command: `node --test src/http/server/authorize.test.ts src/http/server/dispatch.test.ts src/http/server/route.test.ts` → exit 0 — `ℹ tests 50 / ℹ pass 50 / ℹ fail 0`; per-file case counts unchanged from pre-story.
- command: `npm run typecheck` → exit 0; `npx eslint` over the three edited files → exit 0.

**Full-gate verification (green, but it proves the wrong thing — see Findings).**

- command: `npm run verify`
- exit: 0 — `ℹ tests 5299 / ℹ pass 5299 / ℹ fail 0`, final line `kanthord: verify db status ok`. Pass count equals Story 4's close exactly: 5284 + 1 + 14 + 0 + 0 + 0. Story 5 adds 0 and drops 0, as named.
- Post-edit residue: grep 1 = `app.test.ts`, `dispatch.test.ts`, `host.test.ts` (L2), `idempotency.test.ts` (L2), `test/helpers/agent.test.ts` (L2). A Story-7-style import scan today already returns 6 paths, of which 2 are outside the allow list; Story 6 adds a seventh (`shutdown-socket.test.ts`). Budget 6 cannot hold.

**Findings.**

- B1 - status:OPEN - action:YES - app.test.ts holds a wire-only case no table classifies - its case `an http/1.0 request with no Host header answers the exact host-forbidden message through the bridge, not a bare 400` (line 547) sends a raw HTTP/1.0 request line without a Host through `loopbackServer(created.app)` + `rawHttp10`; the Fetch pipeline structurally cannot express it, because `hono.request()` builds a Request whose URL always carries an authority - fix: add `src/http/server/app.test.ts` to the EPIC level-2 table as row 7 and to Story 7's allow list with the budget raised to 7 (pass-count arithmetic unaffected; the file is untouched) - why: keeping the case is the only correct outcome, the EPIC forbids editing it (group A row), and Story 7 counts its import, so stories 5–7 as written are mutually unsatisfiable for this file.
- B2 - status:OPEN - action:YES - dispatch.test.ts keeps three socket cases the story has no rule for - its local `rawResponse` helper serves `koaFromHono(hono)` over `loopbackServer` and asserts on node `rawHeaders` (204 and 304 empty results carry no content-type/content-length name; third case reads status + JSON body); level 1's `AgentResponse` carries no `rawHeaders`, so migrating those assertions changes assertion code, which the story forbids - fix: either amend Story 5 to migrate the trio to `fetchAgent(hono)` with the absence assertions rewritten as header-map lookups (`koa-bridge.test.ts:133` already owns the unique wire value "a 204 answer carries no body bytes, no content-length and no content-type", so nothing is lost), or add `dispatch.test.ts` to the level-2 rows beside B1 with the budget at 8 - why: the EPIC row "status and JSON body only" mis-describes these three cases at the base commit this epic measured; both resolutions need a locked-plan edit only the human can make.

**Why blocked, not self-resolved.** B1 admits no level-1 expression at all. B2 admits one only by breaking the story's own no-assertion-change constraint. The precedent of this cycle's Story 3 applies: the defect sits in locked plan files, so it goes to the human with evidence. All cleanly migratable work is landed and green, so the amendment resumes from a half-migrated `dispatch.test.ts` plus two one-line table edits, whichever option you pick.

**State left behind.** Working tree keeps Stories 1–4 intact plus this story's three file edits; full suite 5299/0 fail. No stub, no skip, no disabled test.

**Open to Software Engineer.**

- none — no production seam exists in this EPIC; the blockers name locked plan files, which only the human may amend.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 033-dual-level-test-harness · Story 5 remainder blocked: its only open path is TE lane

**Cycle.** Response to the last TEST-ENGINEER turn (Story 5 half-landed with B1/B2; Ulrich resolved both by amending the EPIC and stories). Re-read the amended Story 5 before acting: `authorize.test.ts` and `route.test.ts` already landed green in that same TE turn, so the remainder is the authorized rawHeaders trio inside `src/http/server/dispatch.test.ts` — a test file, denied to this role. No RED is outstanding and no production seam exists anywhere in the amended story: the exception rewrites assertion access paths onto the `AgentResponse` contract inside the same test file, and the EPIC header still reads "edits no production module". Stories 6–7 likewise name only TE-lane paths. Nothing sits in this role's lane to implement. The tree is untouched by this turn.

**OPEN:**

- OPEN: `src/http/server/dispatch.test.ts` — migrate the three `rawResponse(koaFromHono(hono), "GET", "/v1/status")` call sites to `fetchAgent(hono).get("/v1/status")`, delete the local `rawResponse` helper and its now-unused imports, express the 204/304 assertions as status + `response.text === ""` + absent `"content-type"`/`"content-length"` keys in the joined lower-case `headers`, and deep-equal the bytes-result body against the same value; test-engineer lane.
- OPEN: `src/http/server/shutdown-socket.test.ts` (new, 3 cases) + 1 case in `test/helpers/agent.test.ts` — Story 6; both paths TE lane.
- OPEN: `test/helpers/socket-budget.test.ts` (new, 2 cases) — Story 7; TE lane.

**Lane probes (re-run this turn).**

- `bash scripts/lane-check.sh software-engineer src/http/server/dispatch.test.ts` → exit 1 — "a test file is not the software-engineer lane"
- `bash scripts/lane-check.sh software-engineer src/http/server/shutdown-socket.test.ts` → exit 1 — same
- `bash scripts/lane-check.sh software-engineer test/helpers/socket-budget.test.ts` → exit 1 — "test helpers are the test-engineer lane"

**Files changed.** None.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: the amended `05-move-group-c-to-level-1.md` carries the "authorized rawHeaders exception" subsection and its Change section names no non-test path; the amended `07-assert-the-socket-budget.md` creates `test/helpers/socket-budget.test.ts` only.
- VERIFIED: the three denials above reproduced via `scripts/lane-check.sh`.
- VERIFIED: the discussion file holds no `DEBATE_GUIDELINE:` block; its last engineer turn is TEST-ENGINEER (Story 5).

ATTEMPT-FAILED: story-5 — the only unlanded edit (the dispatch.test.ts rawHeaders trio) targets a test file denied to software-engineer by `scripts/lane-check.sh`; nothing else in the amended story sits in lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Completed the EPIC in turn on Ulrich's amended plan: Story 5 remainder (the authorized `dispatch.test.ts` rawHeaders exception), then Story 6, then Story 7, in dependency order — every path TE lane, no production seam exists anywhere in this EPIC (reconfirmed by the SE lane audits of record). No RED was outstanding; each story verified below before the next began.

**Changes made this cycle-segment (all TE-lane).**

- file: `src/http/server/dispatch.test.ts` (edited) — the authorized exception only: three `rawResponse(koaFromHono(hono), "GET", "/v1/status")` call sites → `fetchAgent(hono).get("/v1/status")`; the `RawResponse` type and `rawResponse` helper deleted; the imports only that helper needed removed (`node:http` request, `AddressInfo`, `Koa`, `koaFromHono`, `loopbackServer`). Assertion churn confined to the exception, same expected values: zero body bytes read as `response.text === ""`; header absence read off `Object.keys(response.headers)` (lower-case by Agent rule 1); the bytes-result case deep-equals `response.body` directly against the identical envelope. Zero `it(` churn — 34 cases, names unchanged.
- file: `src/http/server/shutdown-socket.test.ts` (new) — suite `src/http/server/shutdown-socket.test`; local `deferred<T>()`, `closeServer(server)` (rejects on callback error), `portOf(server)`; exactly 3 cases: (1) graceful drain ordered by the four events it sequences itself — `[handler-entered, shutdown-started, handler-released, response-complete]` — awaiting the response before the close promise, recording nothing in the close callback, asserting `server.listening === false` afterwards; (2) a fetch to the exact loopback port after `closeServer` starts rejects with `cause.code === "ECONNREFUSED"`; (3) `server.listening` true → close → false and `address()` null. Fresh application and bridge per case; every server closed.
- file: `test/helpers/agent.test.ts` (edited) — appended case 20, `preserves two set-cookie values over the socket`: hono app appending `a=1`,`b=2` → `koaFromHono` → `await loopbackAgent(bridge)` → `assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"])`. Nineteen prior cases byte-for-byte unchanged.
- file: `test/helpers/socket-budget.test.ts` (new) — suite `test/helpers/socket-budget.test counts files that reach test/helpers/agent.ts`; one `socketFiles(root)` scan reading `<root>/src` and `<root>/test` each with its own recursive `readdir`, keeping `*.test.ts` whose **import declarations only** (story regex) name `loopbackAgent|loopbackServer|createSocketTestApp`, repository-relative paths, `Buffer.compare` bytewise sort; exactly 2 cases: `keeps the socket file count at seven`, `keeps the exact level-2 allow list` (deep-equal to the 7 amended rows).

**Per-story verification.**

- Story 5: `node --test src/http/server/{authorize,dispatch,route}.test.ts` → exit 0 — 50/50 (pre-story case counts held); post-edit inventory: grep 1 residue = `app.test.ts`, `host.test.ts`, `idempotency.test.ts`, `agent.test.ts` — exactly the level-2 rows, no group-C file names `loopbackAgent`; `git diff | grep -E '^[+-]'` over assert lines shows only the three authorized rewrites.
- Story 6: `node --test src/http/server/shutdown-socket.test.ts test/helpers/agent.test.ts src/http/server/shutdown.test.ts` → exit 0 — 33/33 (shutdown-socket exactly 3; agent.test exactly 20; shutdown 10).
- Story 7: `node --test test/helpers/socket-budget.test.ts` → exit 0 — 2/2, reporting the exact seven paths.
- `npm run typecheck` → exit 0; `npx eslint` over the four touched files → exit 0.

**EPIC verification gate.**

- Gates: `npm run verify` → exit 0 — full suite `ℹ tests 5305 / ℹ pass 5305 / ℹ fail 0`, final line `kanthord: verify db status ok`.
- `typecheck` (`npm run typecheck`) → exit 0.
- `unit` (`npm test`) → exit 0 — `ℹ tests 5305 / ℹ pass 5305 / ℹ fail 0`.
- Pass-count ledger: base 5284 (EPIC 032 close) +1 (s1) +14 (s2) +0 (s3) +0 (s4) +0 (s5) +4 (s6) +2 (s7) = **5305 = base +21 exactly**. Count artifact note: on this toolchain `npm test` routes through `scripts/run-tests.mjs` and the reporter emits `ℹ` lines, so the gate text's `grep -m1 '^# pass'` matches nothing; the `ℹ pass` line above is the artifact used throughout this cycle.
- Group A zero-line check vs base `5166d3ad1027dccb14acdacd1c5414d669b16a0a`: numstat over the 45 group-A paths reports exactly one changed file, `src/http/server/app.parity-path.test.ts` at precisely `2 added / 8 deleted`.

**Proof.** The EPIC's Proof block, verbatim → exit 0, final line quoted: `"PASS EPIC-033"` — `ℹ tests 486 / ℹ pass 486 / ℹ fail 0` within the block, including the graceful-drain, connection-refusal, listener-close, two-cookie, exact-count and exact-allow-list cases.

**Tasks closed.** 7 across 7 Stories — 1 pin-the-level-2-primitive, 2 add-fetch-agent, 3 move-createTestApp-to-level-1, 4 group-B-to-level-1, 5 group-C-to-level-1 (amended exception applied), 6 level-2-wire-cases, 7 assert-the-socket-budget. No Story outstanding; no story file unexpanded.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test <33-file Proof block> && echo "PASS EPIC-033") — "PASS EPIC-033"
- stories: 7/7 complete
- date: 2026-08-26
- state: local-uncommitted

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — routing 4 action:YES finding(s) to the TDD loop; 2 action:NO finding(s) recorded for the human.
BLOCKER: exact binary response bytes — `test/helpers/agent.ts` decodes through `Response.text()` before rebuilding the `Buffer`, so invalid UTF-8 cannot round-trip; the helper must read the response bytes once and derive `text` from those bytes, and the non-JSON body case must assert the story's `[0, 255]` fixture instead of `"hello"` (story 2 lines 31-38, 77)
BLOCKER: contract tests omit named assertions — `test/helpers/agent.test.ts` checks only duplicate `set-cookie`, not the story-named duplicate ordinary-header (`X-A`) assertion, and sets/asserts only one late `.set` header where two are named (story 2 lines 72-75, 83, 89)
BLOCKER: JSON content-type matching is case-sensitive — `mediaType.endsWith("json")` without case normalization sends mixed-case JSON content types down the binary path; normalize before classification and add direct mixed-case coverage (story 2 lines 35-38)
BLOCKER: shutdown test detaches the response promise — `src/http/server/shutdown-socket.test.ts` discards the request promise and waits on a separately resolved deferred, so a rejected request can hang the case; retain and await the chained response promise directly before the close promise (story 6 lines 28-36)
INFO: GET/HEAD payloads silently discarded — `.send()` on GET/HEAD omits the payload because undici forbids it; reviewer marks NEEDS-HUMAN: define method-specific `.send()` behavior, then amend either the contract or the affected level assignment
INFO: new test imports vs Architecture matrix — `test/helpers/agent.test.ts`, `src/http/server/idempotency-key.test.ts` and `src/http/server/shutdown-socket.test.ts` add vendor/unrelated production imports outside the allowed test boundary; reviewer marks NEEDS-HUMAN: reconcile the EPIC with the binding test boundary

## TEST-ENGINEER — review blockers · regression tests and repairs for AUTO_REVIEW: FAIL

**Cycle.** Review-failure cycle on the 4 routed BLOCKERs. All four name test-engineer lane paths only — `test/helpers/agent.ts`, `test/helpers/agent.test.ts`, `src/http/server/shutdown-socket.test.ts` (lane probes re-run this turn: all three DENIED to software-engineer, exit 1) — so nothing opens to the software engineer; the regressions and their repairs are TE work in this turn, RED first, then green, per this EPIC's standing single-turn pattern (the Story-2 turn recorded RED proof then GREEN proof together). The 2 INFO lines are left untouched for the human.

**Test written.** Both red-capable regressions edit existing cases in place, so every gate count stays at its EPIC-close value.

- file: `test/helpers/agent.test.ts` (edited) — suite: `test/helpers/agent.test` — case `buffers a non-JSON content type into body`: fixture swapped from `"hello"` to story-2-named raw bytes `[0, 255]`; asserts byte-exact `Buffer.from([0, 255])`.
- file: `test/helpers/agent.test.ts` (edited) — same suite — case `parses a JSON content type into body`: added direct mixed-case coverage; a second route answers `content-type: Application/JSON` and its body must parse to `{ reached: true }`.
- asserts: invalid UTF-8 round-trips byte-exact through `fetchAgent`'s `body`, and JSON classification ignores media-type case (story-2 line 37: "ignoring parameters and case").
  **RED proof.**
- command: `node --test test/helpers/agent.test.ts`
- exit: 1 — failures verbatim:
  - `✖ buffers a non-JSON content type into body` — `+ [0, 239, 191, 189] / - [255]`: byte 255 was decoded to U+FFFD by `res.text()` and re-encoded as `EF BF BD`, proving the text round-trip corrupts binary bodies.
  - `✖ parses a JSON content type into body` — actual `Buffer(16) [123, 34, …]` vs expected object: mixed-case `Application/JSON` fell down the binary path.

**Not red-expressible — honest classification of the other two blockers.**

- B2 (contract tests omit named assertions): the story-named assertions pin behaviour the helper already ships; no state makes them fail without deliberately breaking the helper. Remedy is coverage completion, landed in place in `test/helpers/agent.test.ts`: the duplicate-header case now appends `X-A: one`/`X-A: two` beside `Set-Cookie` and asserts both joins (`x-a === "one, two"`, `set-cookie === "a=1, b=2"`; story-2 lines 73–75), and the lazy-dispatch case now `.set`s two late headers (`x-lazy`, `x-second`) and asserts both reach the application after the zero-call await (lines 83, 89). First-run pass intended — characterization/coverage. Sensitivity proven by runtime probe on this toolchain: undici yields a repeated ordinary header pre-joined (`x-a → "one, two"` in one entry) but yields `set-cookie` once per value, so the new assertion fails under any last-value-wins regression while the builder's join-on-repeated-key stays load-bearing for `set-cookie`.
- B4 (shutdown drain detaches the response promise): the subject is the existing case's await topology, not pinned output, so no failing test can demonstrate it. Repair landed in place in `src/http/server/shutdown-socket.test.ts`, exactly story-6 lines 28–36: `const answer = agent.get("/drain").then(…)` retains the chained response promise and the case awaits it directly before awaiting the close promise; the separately resolved `answer` deferred and the `void`-discarded chain are gone, so a rejected request now surfaces at the case's own `await` instead of hanging on a deferred only success resolves. The four-event order, the `server.listening` close proof and all assertions are unchanged.

**Repairs (all TE lane; zero cases added or dropped anywhere).**

- file: `test/helpers/agent.ts` (edited) — response read once as bytes (`res.arrayBuffer()`); `text` derived from those bytes by UTF-8 decode; non-JSON `body` built from the bytes (`Buffer.from(bytes)`); media type lower-cased before the `endsWith("json")` classification; empty rule keyed on zero bytes first, as before. Story-2 lines 31–38 exactly.

**GREEN proof and verification.**

- command: `node --test test/helpers/agent.test.ts src/http/server/shutdown-socket.test.ts src/http/server/shutdown.test.ts` → exit 0 — `ℹ tests 33 / ℹ pass 33 / ℹ fail 0` (20 + 3 + 10; per-file counts unchanged)
- command: `npm run typecheck` → exit 0
- command: `npx eslint test/helpers/agent.ts test/helpers/agent.test.ts src/http/server/shutdown-socket.test.ts` → exit 0
- command: `npm run verify` → exit 0 — full suite `ℹ tests 5305 / ℹ pass 5305 / ℹ fail 0`, final line `kanthord: verify db status ok`. Ledger intact: base 5284 +21 = 5305; repairs add 0.

**EPIC verification gate.**

- Gates: `npm run verify` → exit 0 — full suite `ℹ tests 5305 / ℹ pass 5305 / ℹ fail 0`, final line `kanthord: verify db status ok`.

**Proof.** The EPIC's Proof block verbatim → exit 0 — `ℹ tests 486 / ℹ pass 486 / ℹ fail 0` within the block, including the drain, refusal, listener-close, two-cookie, exact-count and exact-allow-list cases; final line quoted: `"PASS EPIC-033"`.

**Tasks closed.** 7 across 7 Stories — 1 pin-the-level-2-primitive, 2 add-fetch-agent, 3 move-createTestApp-to-level-1, 4 group-B-to-level-1, 5 group-C-to-level-1, 6 level-2-wire-cases, 7 assert-the-socket-budget. No Story outstanding; review repairs touch no Task scope and change no case count.

**Open to Software Engineer.**

- none — all three blocker paths are test-engineer lane (probes above); no production seam exists in this EPIC.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test <33-file Proof block> && echo "PASS EPIC-033") — "PASS EPIC-033"
- stories: 7/7 complete
- date: 2026-08-26
- state: local-uncommitted

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 033-dual-level-test-harness · no SE-lane work: cycle sits at IMPLEMENTATION_READY_FOR_REVIEW

**Cycle.** Response to the last TEST-ENGINEER turn. That turn resolved all four review BLOCKERs in TE lane (`test/helpers/agent.ts`, `test/helpers/agent.test.ts`, `src/http/server/shutdown-socket.test.ts`), re-ran Gates and Proof green, re-emitted IMPLEMENTATION_READY_FOR_REVIEW, and recorded "Open to Software Engineer: none". Ulrich resolved the two INFO findings by plan amendment only — Story 2 now carries the GET/HEAD no-body dispatch clause and EPIC Open item S9 records the framework-import convention; Story 2's Change section re-read this turn still names test-helper paths alone, so the amendments open no production work. No RED is outstanding, all 7 Stories are closed, and the EPIC header states it edits no production module. Nothing sits in this role's lane to implement.

**Lane probe (re-run this turn).**

- `bash scripts/lane-check.sh software-engineer test/helpers/agent.ts` → exit 1 — "test helpers are the test-engineer lane"

**Files changed.** None — tree untouched by this turn. The working tree holds the TE's story edits plus the amended plan files, local-uncommitted as the READY record states.

**Build check.**

- typecheck: exit 0

**Assumptions.**

- VERIFIED: the discussion file holds no DEBATE_GUIDELINE block newer than the last engineer turn — its only two matches are prior turns' absence notes; the last turn is TEST-ENGINEER ending `END: TEST-ENGINEER`.
- VERIFIED: EPIC Open items carries S9 (status:FIXED) recording the framework-import convention; the amended Story 2 on disk carries the GET/HEAD clause with a test-only Change section.
- No ATTEMPT-FAILED emitted: no active Task fails for this role — the implementation phase is complete and the cycle awaits human review.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Post-review confirmation pass: all 7 Stories were green at the previous READY emission, the four review BLOCKERs were repaired in TE lane, and the human amended the plan to resolve both INFO findings. Handoff verification gate first: the software-engineer's last turn (a no-op audit) claims `typecheck: exit 0`; independently re-verified with `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`. Amendment checks on disk: Story 2 carries the GET/HEAD no-body dispatch clause (line 31); EPIC Open item S9 records the framework-import convention (status:FIXED). No `DEBATE_GUIDELINE:` block newer than the last engineer turn exists (both matches are prior turns' absence notes). Re-confirmed every Task still green by running both gate commands below in full this turn — no case added or dropped anywhere.

**EPIC verification gate.**

- Gates: `npm run verify` → exit 0 — `ℹ tests 5305 / ℹ pass 5305 / ℹ fail 0`, `eslint .` clean, final line `kanthord: verify db status ok`.
- `typecheck` (`npm run typecheck`) → exit 0 — re-verified independently via `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `unit` (`npm test`) → exit 0 — full suite executed inside `npm run verify` above: `ℹ tests 5305 / ℹ pass 5305 / ℹ fail 0`.
- Ledger intact: base 5284 (EPIC 032 close) +1 (s1) +14 (s2) +0 (s3) +0 (s4) +0 (s5) +4 (s6) +2 (s7) = **5305 = base +21 exactly**; the review repairs add 0.

**Proof.** The EPIC's Proof block verbatim (33 files) → exit 0 — `ℹ tests 486 / ℹ pass 486 / ℹ fail 0` within the block, including the drain, connection-refusal, listener-close, two-cookie, exact-count and exact-allow-list cases; final line quoted: `"PASS EPIC-033"`.

**Tasks closed.** 7 across 7 Stories — 1 pin-the-level-2-primitive, 2 add-fetch-agent, 3 move-createTestApp-to-level-1, 4 group-B-to-level-1, 5 group-C-to-level-1, 6 level-2-wire-cases, 7 assert-the-socket-budget. No Story outstanding; no story file unexpanded.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test <33-file Proof block> && echo "PASS EPIC-033") — "PASS EPIC-033"
- stories: 7/7 complete
- date: 2026-08-26
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
