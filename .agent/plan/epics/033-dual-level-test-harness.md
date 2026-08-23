# EPIC 033 — Dual-level test harness

Status: **draft**. It is the fourth epic of the phase 1b band that replaces Koa with Hono. It sits
after EPIC 032, which delivers the Hono application, and before EPIC 034, which delivers the Node
adapter. It edits test files and one test helper. It edits no production module.

**Human action required before execution.** Keep `@types/koa` and `@types/koa__cors` in
`package.json` until EPIC 035 completes. The koa middleware still typechecks while the port runs, so
an early removal breaks `npm run typecheck`. `scripts/lane-check.sh:41` locks the manifest, so no
story in this epic edits it.

## Goal

The transport suite runs at two levels, and each level states what it proves.

Today one harness serves every transport test. `test/helpers/agent.ts` opens a real listening socket
for each application under test, and `test/helpers/app.ts` routes 48 test files through that
same socket. 57 test files therefore open a socket to assert a JSON body.

After this epic, 5 test files open a socket. The other 53 run on the Hono Fetch pipeline with no
socket and no port.

| Level | Entry point        | What it proves                                                               | Files |
| ----- | ------------------ | ---------------------------------------------------------------------------- | ----- |
| 1     | `app.request()`    | middleware, routing, authentication, CORS, preflight, idempotency, envelopes | 53    |
| 2     | a listening socket | Node header handling, ephemeral ports, wire bytes, graceful shutdown         | 5     |

## Non-goals

- **No change to the 6 direct handler tests.** `src/http/server/blob/range.test.ts`,
  `src/http/server/credential/refusals.test.ts`, `src/http/server/event/wait.test.ts`,
  `src/http/server/node/unblock-node.test.ts`, `src/http/server/plan/refusals.test.ts` and
  `src/http/server/repository/refusals.test.ts` call handlers directly and touch no framework. They
  are untouched.
- **No new operation.** The registry, the path grammar and the schemas are unchanged.
- **No Koa removal.** `koa`, `@koa/cors` and `@koa/bodyparser` stay in `package.json`. EPIC 035 owns
  the removal, and S1 below owns the manifest edit.
- **No change to the Hono application.** EPIC 032 owns `src/http/server/**` production code. This
  epic reads that application and never edits it.
- **No new assertion.** A migration moves a file between levels. It adds no case and drops no case.

## Decisions

- **Two levels, and each has one job.** Level 1 calls `app.request()` on the Hono application. It
  needs no socket, no port and no adapter, so it is the default. Level 2 listens on an ephemeral
  loopback port and drives the application through the real Node adapter. It is the exception, and
  every level-2 file names the wire behaviour it proves.

- **`supertest` stays.** An earlier plan removed it. That was an error. Level 2 needs a real client
  over a real socket, and a Fetch-level harness proves nothing about the adapter. `supertest` and
  `@types/supertest` stay dev dependencies for the 5 level-2 files.

- **A migration moves a file, never a test.** A file whose assertions are all status, headers and
  parsed body moves to level 1. A file with one assertion about wire behaviour stays whole at level 2. Splitting a file to move three cases adds a file and buys nothing, and it puts the unchanged
  test count at risk.

- **`test/helpers/agent.ts` keeps its name and gains the level-1 entry point.** It exports three
  symbols after this epic:

  ```ts
  export function fetchAgent(app: Hono): Agent;
  export function loopbackServer(app: Hono): Promise<Server>;
  export function loopbackAgent(app: Hono): Promise<ReturnType<typeof request>>;
  ```

  `fetchAgent` is level 1. `loopbackAgent` is level 2, and `loopbackServer` is the primitive under
  it. `loopbackServer` keeps `server.unref()`, keeps `listen(0, "127.0.0.1")` and keeps the
  `WeakMap` cache keyed by the application. A leaked listening socket makes the suite
  non-hermetic, and the cache is what holds the socket count at one per application.

- **`fetchAgent` returns the request-builder shape the tree already calls.** `test/helpers/app.ts`
  exposes `get`, `post`, `put` and `del`, each chained with `.set(name, value)` and `.send(body)`,
  and each awaited to a response. `fetchAgent` returns that same shape over `app.request()`. That is
  why 44 files change zero lines: `createTestApp` swaps one call, and every caller keeps its syntax.

  The `Agent` contract is exact:

  ```ts
  export type AgentResponse = Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: unknown;
    text: string;
  }>;

  export type AgentRequest = PromiseLike<AgentResponse> & {
    set(name: string, value: string): AgentRequest;
    send(body: unknown): AgentRequest;
  };

  export type Agent = Readonly<{
    get(path: string): AgentRequest;
    post(path: string): AgentRequest;
    put(path: string): AgentRequest;
    del(path: string): AgentRequest;
  }>;
  ```

  `headers` keys are lower-case. A duplicate header joins with `", "`. `body` holds the parsed
  object for `application/json`, a `Buffer` for every other content type, and `{}` for an empty
  body. `text` holds the decoded body as UTF-8. `.send(body)` sets `content-type:
application/json` when the caller sets no content type.

- **Hermeticity is stronger after this epic.** The count of test files that open a listening socket
  falls from 57 to 5. Story 6 asserts that count, so the split cannot regress in silence.

- **Four existing files stay at level 2, and one is new.**

| File                                      | Level | Reason                                                                                            |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `test/helpers/agent.test.ts`              | 2     | it covers both helpers, so it asserts the loopback bind address, the port and the `WeakMap` cache |
| `src/http/server/host.test.ts`            | 2     | one case asserts the Host header `127.0.0.1:<port>` that ephemeral-port resolution produces       |
| `src/http/server/idempotency.test.ts`     | 2     | one case sends `Idempotency-Key` twice over a raw socket, which the Fetch `Headers` type forbids  |
| `src/http/server/blob/show-blob.test.ts`  | 2     | it asserts 206 range bodies as exact `Buffer` values on the wire                                  |
| `src/http/server/shutdown-socket.test.ts` | 2     | new: graceful shutdown with an open connection                                                    |

- **The 53 level-1 files, in three groups.** Group A is the 44 files that reach the harness only
  through `createTestApp`. Group B is the 6 files that call `loopbackAgent` and never call
  `createTestApp`. Group C is the 3 files that call both.

| Group | File                                                           | Reason for level 1                               |
| ----- | -------------------------------------------------------------- | ------------------------------------------------ |
| B     | `src/http/server/auth.test.ts`                                 | status and error envelope only                   |
| B     | `src/http/server/envelope.test.ts`                             | status and error envelope only                   |
| B     | `src/http/server/idempotency-key.test.ts`                      | status and error envelope only                   |
| B     | `src/http/server/idempotency-response.test.ts`                 | status, headers and JSON body only               |
| B     | `src/http/server/origin.test.ts`                               | CORS response headers only                       |
| B     | `src/http/server/preflight.test.ts`                            | preflight response headers only                  |
| C     | `src/http/server/authorize.test.ts`                            | status and error envelope only                   |
| C     | `src/http/server/dispatch.test.ts`                             | status and JSON body only                        |
| C     | `src/http/server/route.test.ts`                                | status, routing and error envelope only          |
| A     | `src/http/server/app.test.ts`                                  | status and JSON body only                        |
| A     | `src/http/server/actor/list-actor.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/actor/register-actor.test.ts`                 | status and JSON body only                        |
| A     | `src/http/server/actor/registration.test.ts`                   | status and JSON body only                        |
| A     | `src/http/server/actor/revoke-actor.test.ts`                   | status and JSON body only                        |
| A     | `src/http/server/actor/rotate-actor-token.test.ts`             | status and JSON body only                        |
| A     | `src/http/server/actor/show-actor.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/credential/inspect-provider.test.ts`          | status and JSON body only                        |
| A     | `src/http/server/credential/list-provider.test.ts`             | status and JSON body only                        |
| A     | `src/http/server/credential/read-catalog.test.ts`              | status and JSON body only                        |
| A     | `src/http/server/credential/register-provider.test.ts`         | status and JSON body only                        |
| A     | `src/http/server/credential/remove-provider.test.ts`           | status and JSON body only                        |
| A     | `src/http/server/credential/rename-provider.test.ts`           | status and JSON body only                        |
| A     | `src/http/server/credential/set-default-provider.test.ts`      | status and JSON body only                        |
| A     | `src/http/server/credential/show-provider.test.ts`             | status and JSON body only                        |
| A     | `src/http/server/edge/list-edge.test.ts`                       | status and JSON body only                        |
| A     | `src/http/server/event/list-event.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/node/claim-node.test.ts`                      | status and JSON body only                        |
| A     | `src/http/server/node/create-node.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/node/delete-node.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/node/heartbeat-node.test.ts`                  | status and JSON body only                        |
| A     | `src/http/server/node/list-node.test.ts`                       | status and JSON body only                        |
| A     | `src/http/server/node/list-project-node.test.ts`               | status and JSON body only                        |
| A     | `src/http/server/node/release-node.test.ts`                    | status and JSON body only                        |
| A     | `src/http/server/node/report-node.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/node/show-node.test.ts`                       | status and JSON body only                        |
| A     | `src/http/server/node/update-node.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/plan/export-plan.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/plan/import-plan.test.ts`                     | status and JSON body only                        |
| A     | `src/http/server/plan/list-revision.test.ts`                   | status and JSON body only                        |
| A     | `src/http/server/plan/validate-plan.test.ts`                   | status and JSON body only                        |
| A     | `src/http/server/project/create-project.test.ts`               | status and JSON body only                        |
| A     | `src/http/server/project/list-project.test.ts`                 | status and JSON body only                        |
| A     | `src/http/server/project/replace-project-repositories.test.ts` | status and JSON body only                        |
| A     | `src/http/server/project/show-project-graph.test.ts`           | status and JSON body only                        |
| A     | `src/http/server/project/show-project.test.ts`                 | status and JSON body only                        |
| A     | `src/http/server/repository/inspect-repository.test.ts`        | status and JSON body only                        |
| A     | `src/http/server/repository/list-repository.test.ts`           | status and JSON body only                        |
| A     | `src/http/server/repository/register-repository.test.ts`       | status and JSON body only                        |
| A     | `src/http/server/repository/show-repository.test.ts`           | status and JSON body only                        |
| A     | `src/http/server/system/db.test.ts`                            | status and JSON body only                        |
| A     | `src/http/server/system/health.test.ts`                        | status and JSON body only                        |
| A     | `src/http/server/system/status.test.ts`                        | status and JSON body only                        |
| A     | `test/helpers/app.test.ts`                                     | it covers `createTestApp`, which becomes level 1 |

- **EPIC 034 lands before story 5.** Level 2 cannot serve a Hono application until the Node adapter
  exists. Stories 1, 2, 3, 4 and 6 need no adapter, because level 1 calls `app.request()` directly.
  The four retained level-2 files therefore keep the Koa path of EPIC 032 until story 5. Story 5 is
  the last commit of EPIC 033 and lands after EPIC 034. Koa is still present at that point, because
  EPIC 035 removes it.

- **`src/main.claim.test.ts` opens no socket.** It names `createTestApp` inside a string, as part of
  an import-shape assertion. It is untouched, and story 6 must not count it.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **`test/helpers/agent.ts` gains `fetchAgent`.** Add the level-1 entry point and the `Agent`,
   `AgentRequest` and `AgentResponse` types exactly as the Decisions state. Keep `loopbackServer`
   and `loopbackAgent` unchanged. Extend `test/helpers/agent.test.ts` with level-1 cases that pin
   the header lower-casing, the `", "` join for a duplicate header, the JSON parse, the `Buffer` for
   a non-JSON body, and the default `content-type` of `.send`.
2. **`createTestApp` runs at level 1.** In `test/helpers/app.ts`, replace `loopbackAgent(app)` with
   `fetchAgent(app)`, and change `TestApp` to name `Agent` and `AgentRequest` in place of the
   `supertest` types. Update `drive` and `driveRaw` return types. Group A changes zero lines. Update
   `test/helpers/app.test.ts` for the new types.
3. **Group B moves to level 1.** In each of the 6 files, replace the `loopbackAgent` import with
   `fetchAgent`, and drop the `await` that the promise-returning helper needed. Change no assertion.
4. **Group C moves to level 1.** Apply the same edit to `src/http/server/authorize.test.ts`,
   `src/http/server/dispatch.test.ts` and `src/http/server/route.test.ts`. Each also calls
   `createTestApp`, so the two paths converge on one level.
5. **Level 2 runs on the Node adapter.** Change `loopbackServer` to build the server from the EPIC
   034 adapter in place of `app.callback()`, and change the parameter type from `Koa` to `Hono`.
   Port `test/helpers/agent.test.ts`, `src/http/server/host.test.ts`,
   `src/http/server/idempotency.test.ts` and `src/http/server/blob/show-blob.test.ts` to the Hono
   application. Add `src/http/server/shutdown-socket.test.ts`, which asserts that a graceful
   shutdown drains one in-flight request, refuses a new connection, and closes the listener.
6. **The socket budget is asserted.** Add `test/helpers/socket-budget.test.ts`. It reads every
   `*.test.ts` file under `src/` and `test/` with `readdir` recursive, counts the files whose source
   names `loopbackAgent` or `loopbackServer` in an import statement, and asserts the count equals 5.
   It asserts the exact file list, sorted, so a new socket test names itself.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  test/helpers/agent.test.ts \
  test/helpers/app.test.ts \
  test/helpers/socket-budget.test.ts \
  src/http/server/app.test.ts \
  src/http/server/auth.test.ts \
  src/http/server/authorize.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/envelope.test.ts \
  src/http/server/host.test.ts \
  src/http/server/idempotency.test.ts \
  src/http/server/idempotency-key.test.ts \
  src/http/server/idempotency-response.test.ts \
  src/http/server/origin.test.ts \
  src/http/server/preflight.test.ts \
  src/http/server/route.test.ts \
  src/http/server/shutdown.test.ts \
  src/http/server/shutdown-socket.test.ts \
  src/http/server/blob/show-blob.test.ts \
  src/http/server/blob/range.test.ts \
  src/http/server/event/list-event.test.ts \
  src/http/server/event/wait.test.ts \
  src/http/server/system/health.test.ts \
  src/http/server/system/status.test.ts \
  src/http/server/system/db.test.ts \
  src/http/server/actor/registration.test.ts \
  src/http/server/credential/register-provider.test.ts \
  src/http/server/node/claim-node.test.ts \
  src/http/server/plan/import-plan.test.ts \
  src/http/server/project/show-project-graph.test.ts \
  src/http/server/repository/register-repository.test.ts \
  src/main.claim.test.ts \
  && echo "PASS EPIC-033"
```

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **The total test count is unchanged.** Record the `node --test` pass count before story 1 and
  after story 6. The two numbers match, plus the cases story 1 and story 5 add. No migration drops
  an assertion, and no migration renames a test.
- **Every EPIC 030 parity test still passes**, at the same level EPIC 030 declares, with the same
  expected values.
- **A level-2 test proves ephemeral-port resolution.** `loopbackServer` binds `127.0.0.1`, never the
  wildcard, and `address().port` is above zero. The Host header a client sends with no override is
  `127.0.0.1:<port>`.
- **A level-2 test proves a binary 206 range response on the wire.** `Range: bytes=0-4` answers 206,
  `content-range: bytes 0-4/10`, and a body equal to `Buffer.from("01234")` byte for byte.
- **A level-2 test proves graceful shutdown.** One in-flight request completes with its full body, a
  connection opened after the shutdown starts is refused, and the listener closes.
- **A level-2 test proves duplicate response headers survive the adapter.** Two `set-cookie` values
  arrive as two values, not one joined value.
- **Level 1 needs no socket.** A level-1 test file that runs alone opens no listening handle.
  Assert with `process.getActiveResourcesInfo()` after the file completes.
- **No test depends on a wall clock, a shared temporary directory, or an ambient git
  configuration.** A test that needs a clock uses `test/helpers/virtual-clock.ts`. A test that needs
  a home uses its own `mktemp` directory and removes it.
- **The suite leaves no listening socket behind.** After the full run, assert that
  `process.getActiveResourcesInfo()` names no `TCPSERVERWRAP`. Every level-2 server keeps its
  `unref`.

## Open items

- S1 - status:OPEN - action:YES - keep supertest in the manifest - `package.json` lists `supertest`
  and `@types/supertest` as dev dependencies, and an earlier plan marked them for removal - fix:
  leave both entries in `package.json` unchanged through EPIC 035, and remove neither when Koa is
  removed - why: 5 level-2 files need a real client over a real socket, and `scripts/lane-check.sh`
  locks `package.json` so no story can state this.
- S2 - status:OPEN - action:YES - the Koa dev types outlive Koa - `@types/koa` and `@types/koa__cors`
  stay while the four retained level-2 files run on the Koa path, between EPIC 032 and story 5 -
  fix: remove both in EPIC 035, after story 5 lands, not before - why: removing them earlier breaks
  `typecheck` on the retained files, and `package.json` is locked.
- **Phase 1b is exempt from the `AGENTS.md` phase-2 test-boundary TODO.** That clause forbids
  opening another **phase-2** epic before the TODO closes. This epic is phase 1b.
- **The `AGENTS.md` test-boundary TODO stays open and unaffected.** The TODO names handler tests
  under `src/http/server/**` that import a query from `src/queries/**`, and query tests under
  `src/queries/**` that import a schema from `src/http/contract/**`. This epic edits the harness
  import in those handler tests and edits nothing else in them. It adds no such import, removes no
  such import, and touches no file under `src/queries/**`. The TODO is unchanged.
