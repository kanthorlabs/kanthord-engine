# EPIC 033 — Dual-level test harness

Status: **draft**. It is the fourth epic of the phase 1b band that replaces koa with hono. It sits
after EPIC 032, which delivers the hono application and the koa bridge, and before EPIC 034, which
delivers the node adapter. It depends on no later epic. It edits test files and two test helpers. It
edits no production module.

**Human action required before execution.** Two manifest facts must hold, and
`scripts/lane-check.sh:41` locks the manifest, so no story in this epic edits it.

- `npm install` must run once. `hono` 4.13.3 and `@hono/node-server` 2.1.1 sit in `package.json` and
  in `package-lock.json`, and `node_modules/hono` is absent.
- `supertest`, `@types/supertest`, `@types/koa` and `@types/koa__cors` stay in `package.json` until
  EPIC 035 completes. Level 2 needs `supertest`, and the koa bridge of EPIC 032 needs the koa types.

## Goal

The transport suite runs at two levels, and each level states what it proves.

Today one harness serves every transport test. `test/helpers/agent.ts` opens a real listening socket
for each application under test, and `test/helpers/app.ts` routes 48 test files through that same
socket. 57 test files therefore open a socket through that helper to assert a JSON body.

After this epic, 5 test files open a socket through that helper. The other 53 run on the hono Fetch
pipeline with no socket and no port.

Every count in this epic counts a file that opens a socket **through
`test/helpers/agent.ts`**. Other test files open a socket by other means, and this epic changes
none of them: `src/http/server/start.test.ts`, the nine `src/main.*.test.ts` daemon tests,
`src/services/config/startup.test.ts`, `src/services/home-lock/startup.test.ts`,
`test/helpers/cli.test.ts`, `test/helpers/daemon.test.ts`, `test/helpers/port.test.ts`,
`test/helpers/remote/http.test.ts` and `test/helpers/remote/ssh.test.ts`.

| Level | Entry point        | What it proves                                                               | Files |
| ----- | ------------------ | ---------------------------------------------------------------------------- | ----- |
| 1     | `hono.request()`   | middleware, routing, authentication, CORS, preflight, idempotency, envelopes | 53    |
| 2     | a listening socket | node header handling, ephemeral ports, wire bytes, graceful shutdown         | 5     |

## Non-goals

- **No change to the 6 direct handler tests.** `src/http/server/blob/range.test.ts`,
  `src/http/server/credential/refusals.test.ts`, `src/http/server/event/wait.test.ts`,
  `src/http/server/node/unblock-node.test.ts`, `src/http/server/plan/refusals.test.ts` and
  `src/http/server/repository/refusals.test.ts` call handlers directly and touch no framework. They
  are untouched.
- **No new operation.** The registry, the path grammar and the schemas are unchanged.
- **No koa removal.** `koa`, `@koa/cors` and `@koa/bodyparser` stay in `package.json`. EPIC 035 owns
  the removal, and S1 below owns the manifest edit.
- **No change to the hono application.** EPIC 032 owns `src/http/server/**` production code. This
  epic reads that application and never edits it.
- **No adapter swap.** `loopbackServer` keeps `createServer(app.callback())` over the koa bridge of
  EPIC 032. EPIC 034 story 3 swaps it to the node adapter, after this epic. No story here changes
  how the level-2 server is built.
- **No new assertion in a migrated file.** A migration moves a file between levels. It adds no case
  and drops no case. Story 1, story 2, story 6 and story 7 add cases, and each names its exact
  count.

## Decisions

- **Two levels, and each has one job.** Level 1 calls `hono.request()` on the hono application. It
  needs no socket, no port and no runtime adapter, so it is the default. Level 2 listens on an
  ephemeral loopback port and drives the application over a real socket through whatever node path
  the product ships at that moment. It is the exception, and every level-2 file names the wire
  behaviour it proves.

- **This epic depends on no later epic, and it changes no server construction.** EPIC 032 ships
  `src/http/server/koa-bridge.ts`, so `createApp` returns `{ app: Koa, hono: Hono<AppEnv> }` and
  `loopbackServer(app: Koa)` keeps working unchanged. Level 2 therefore needs nothing from EPIC 034.
  EPIC 034 story 3 owns the swap from the bridge to the node adapter, and it runs after this epic.
  Level 2 proves the shipped node path at every point in the band, because the bridge is shipped
  production code until EPIC 034 story 3 deletes it, in the same commit that takes its last caller.

- **`supertest` stays.** An earlier plan removed it. That was an error. Level 2 needs a real client
  over a real socket, and a Fetch-level harness proves nothing about the wire. `supertest` and
  `@types/supertest` stay dev dependencies for the 5 level-2 files.

- **A migration moves a file, never a test.** A file whose assertions are all status, headers and
  parsed body moves to level 1. A file with one assertion about wire behaviour stays whole at level 2. Splitting a file to move three cases adds a file and buys nothing, and it puts the unchanged
  test count at risk.

- **`test/helpers/agent.ts` keeps its name and gains the level-1 entry point.** It exports three
  functions after this epic. The two level-2 functions keep their current bodies and their current
  parameter type:

  ```ts
  export function fetchAgent<E extends Env>(app: Hono<E>): Agent;
  export function loopbackServer(app: Koa): Promise<Server>;
  export function loopbackAgent(app: Koa): Promise<ReturnType<typeof request>>;
  ```

  `fetchAgent` is level 1. `loopbackAgent` is level 2, and `loopbackServer` is the primitive under
  it. `loopbackServer` keeps `createServer(app.callback())`, keeps `server.unref()`, keeps
  `listen(0, "127.0.0.1")` and keeps the `WeakMap` cache keyed by the application. A leaked
  listening socket makes the suite non-hermetic, and the cache is what holds the socket count at one
  per application.

  `fetchAgent` takes the `hono` half of the `App` that EPIC 032 returns, never the `app` half.
  `Hono<AppEnv>` is not assignable to `Hono`, so the parameter is generic over `Env`.

- **`fetchAgent` returns the request-builder shape the tree already calls.** `test/helpers/app.ts`
  exposes `get`, `post`, `put` and `del`, each chained with `.set(name, value)` and `.send(body)`,
  and each awaited to a response. `fetchAgent` returns that same shape over `hono.request()`. That
  is why 44 files change zero lines: `createTestApp` swaps one call, and every caller keeps its
  syntax.

  The `Agent` contract is exact. Every member below is present because a migrated file calls it, and
  the citation names the caller:

  ```ts
  export type AgentResponse = Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: any;
    text: string;
  }>;

  export type AgentRequest = Promise<AgentResponse> & {
    set(name: string, value: string): AgentRequest;
    send(body: unknown): AgentRequest;
    buffer(): AgentRequest;
  };

  export type Agent = Readonly<{
    get(path: string): AgentRequest;
    post(path: string): AgentRequest;
    put(path: string): AgentRequest;
    del(path: string): AgentRequest;
    delete(path: string): AgentRequest;
    options(path: string): AgentRequest;
  }>;
  ```

  | Member                       | Why it is in the contract                                                                                                                                                                                                                                                     |
  | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `options(path)`              | `src/http/server/app.test.ts:189` and `:224`, `src/http/server/origin.test.ts:268`, `src/http/server/preflight.test.ts:57` — 15 call sites                                                                                                                                    |
  | `delete(path)`               | `src/http/server/auth.test.ts:193` spells the method `delete`, not `del`                                                                                                                                                                                                      |
  | `del(path)`                  | `test/helpers/app.ts` exposes `del`, and 3 call sites use it                                                                                                                                                                                                                  |
  | `buffer()`                   | `src/http/server/dispatch.test.ts:371` asserts a binary body at level 1                                                                                                                                                                                                       |
  | `body: any`                  | 450 level-1 reads take a property off `body`, for example `src/http/server/idempotency-key.test.ts:417` reads `response.body.raw`. `unknown` fails every one of them. `eslint.config.js` enables no typed-lint preset, so it bans no `any`, and 10 test files use `any` today |
  | `Promise`, not `PromiseLike` | `src/http/server/event/list-event.test.ts:102` and `:114` declare the parameter `pending: Promise<unknown>` and pass a request into it                                                                                                                                        |

  Six rules complete the contract, and each one is pinned by a story-2 case.

  1. `headers` keys are lower-case. A duplicate header joins with `", "`, `set-cookie` included,
     because a Fetch `Headers` cannot report two values through this shape. No level-1 file asserts
     `set-cookie`; the level-2 case of story 6 owns it.
  2. `body` holds the parsed object for a JSON content type, a `Buffer` for every other content
     type, and `{}` for an empty body. `text` holds the decoded body as UTF-8.
  3. `.send(value)` with an object serializes with `JSON.stringify` and sets
     `content-type: application/json` when the caller set no content type.
  4. `.send(value)` with a string sends those bytes verbatim and sets no content type.
     `src/http/server/idempotency-key.test.ts:416` sends `'{ "a" : 1 }'` and asserts the exact bytes
     reach `rawBody`, and 4 other level-1 sites send malformed JSON as a string.
  5. **Dispatch is lazy and memoized.** No request reaches the application until the first `then`
     call, because `src/http/server/actor/registration.test.ts:173` chains `.set` twice after the
     method call. The response is then cached, because
     `src/http/server/event/list-event.test.ts:325-329` awaits one request object twice and asserts
     one handler call.
  6. `.buffer()` returns the same request and changes nothing. `body` already holds a `Buffer` for a
     non-JSON content type, per rule 2.

  `AgentRequest` is an object literal carrying `then`, `catch`, `finally` and
  `[Symbol.toStringTag]`, which is structurally assignable to `Promise<AgentResponse>`. It is not a
  `Promise` subclass, so `set`, `send` and `buffer` stay callable after construction.

- **`createTestApp` runs at level 1, so it needs a level-2 twin.**
  `src/http/server/blob/show-blob.test.ts` reaches the socket only through `createTestApp`, and it is
  a level-2 file. Story 3 would therefore demote it in silence and leave the socket budget at 4.
  `test/helpers/app.ts` exports a second factory, `createSocketTestApp(overrides?)`, that builds the
  same application from the same overrides and returns the same `TestApp`, backed by
  `loopbackAgent(app)` over the `app` half instead of `fetchAgent(hono)` over the `hono` half.
  `show-blob.test.ts` is its only caller, and a second caller is a level-2 decision that belongs in
  the table above.

  The `supertest` agent satisfies `Agent` structurally: superagent exposes `get`, `post`, `put`,
  `del`, `delete` and `options`, its `Test` exposes `set`, `send`, `buffer` and `then`, and its
  `Response` exposes `status`, `headers`, `body` and `text`. Story 3 proves that by typecheck. Where
  a member does not line up, `createSocketTestApp` adapts that one member and nothing else.

- **Hermeticity is stronger after this epic.** The count of test files that open a listening socket
  through `test/helpers/agent.ts` falls from 57 to 5. Story 7 asserts the exact list of those 5
  files, so the split cannot regress in silence.

- **Four existing files stay at level 2, and one is new.**

| File                                      | Level | Reason                                                                                                                                 |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test/helpers/agent.test.ts`              | 2     | it covers both helpers, so it asserts the loopback bind address, the port, the `WeakMap` cache and two `set-cookie` values on the wire |
| `src/http/server/host.test.ts`            | 2     | one case asserts the Host header `127.0.0.1:<port>` that ephemeral-port resolution produces                                            |
| `src/http/server/idempotency.test.ts`     | 2     | one case sends `Idempotency-Key` twice over a raw socket, which the Fetch `Headers` type forbids                                       |
| `src/http/server/blob/show-blob.test.ts`  | 2     | it asserts 206 range bodies as exact `Buffer` values on the wire, and it is the one caller of `createSocketTestApp`                    |
| `src/http/server/shutdown-socket.test.ts` | 2     | new: graceful shutdown with an open connection                                                                                         |

- **The level-2 allow list is the normative data, and the level-1 set is derived.** The 5 rows above
  are a closed set that this epic owns. Level 1 is then every other test file that reaches the
  transport through `createTestApp` or `fetchAgent`. Story 7 asserts the allow list, never the
  derived set.

- **The three groups below are the inventory measured at the base commit of this epic, and EPIC 032
  may move a file between them.** EPIC 032 rewrites `envelope.test.ts`, `origin.test.ts`,
  `host.test.ts`, `preflight.test.ts`, `auth.test.ts`, `route.test.ts`, `authorize.test.ts`,
  `body.test.ts`, `idempotency-key.test.ts`, `idempotency-response.test.ts`, `idempotency.test.ts`,
  `dispatch.test.ts` and `app.test.ts`. A file that EPIC 032 leaves with no `loopbackAgent` call
  needs no edit here, and a file that EPIC 032 gives a `loopbackAgent` call joins group B. Each
  story therefore states the edit as a rule over its group, and the implementing agent recomputes
  the membership with the two commands of the Verification gate. A group row that no longer matches
  is not a defect of the story.

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

- **`src/main.claim.test.ts` is not a harness file.** It names `createTestApp` inside a string, at
  `src/main.claim.test.ts:599`, as part of an import-shape assertion. It reaches neither helper. It
  does open sockets, through `reservePort` at `:249` and `launchDaemon` at `:12`, so it is not
  hermetic-by-Fetch and this epic makes no claim about it. It is untouched, and story 7 must not
  count it.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit. Every
story that adds a case names the exact count, because the Verification gate compares pass counts.

1. **`test/helpers/agent.test.ts` pins the level-2 primitive.** Add one case to the existing 4:
   `(await loopbackServer(new Koa())).address()` reports a `port` whose `typeof` is `number` and
   whose value is above 0. Keep the 4 existing case names and assertions. Add nothing else. Edit
   `test/helpers/agent.ts` not at all. **Adds exactly 1 case.**

2. **`test/helpers/agent.ts` gains `fetchAgent`.** Add `fetchAgent`, `Agent`, `AgentRequest` and
   `AgentResponse` exactly as the Decisions state, including the six rules and the six contract
   members. Keep `loopbackServer` and `loopbackAgent` byte for byte. Extend
   `test/helpers/agent.test.ts` with 14 level-1 cases, one per line below, in this order:

   1. a response header name is lower-case
   2. two values of one header name join with `", "`
   3. a JSON content type parses into `body`
   4. a non-JSON content type puts a `Buffer` in `body`
   5. an empty body is `{}`
   6. `text` holds the body decoded as UTF-8
   7. `.send(object)` sets `content-type: application/json`
   8. `.send(object)` keeps a `content-type` the caller set
   9. `.send(string)` sends those bytes verbatim and sets no content type
   10. `.set` called after the method call reaches the application, so dispatch is lazy
   11. awaiting one request twice calls the application once and returns the same response
   12. `options` reaches the application with the `OPTIONS` method
   13. `delete` and `del` both reach the application with the `DELETE` method
   14. a `fetchAgent` request leaves `process.getActiveResourcesInfo()` with no new `TCPServerWrap`

   **Adds exactly 14 cases.**

3. **`createTestApp` runs at level 1.** In `test/helpers/app.ts`, replace `loopbackAgent(app)` with
   `fetchAgent(hono)`, reading the `hono` half of the `App` that `createApp` returns. Change
   `TestApp.raw` to `Agent` and the four method return types to `AgentRequest`, in place of the
   `supertest` types. Update the `drive` and `driveRaw` return types to `AgentRequest`. Delete the
   `import type supertest from "supertest"` line. `TestApp.raw` must expose `options` and `delete`,
   because `src/http/server/app.test.ts:224` calls `app.raw.options`. Group A changes zero lines.
   Update `test/helpers/app.test.ts` only where a type name appears; keep its 4 case names.

   Add `createSocketTestApp(overrides?)` beside it, per the Decisions. Change the two lines of
   `src/http/server/blob/show-blob.test.ts` that name `createTestApp` to name
   `createSocketTestApp`. Change no assertion in that file, and change no other file.
   **Adds exactly 0 cases.**

4. **Group B moves to level 1.** In each group-B file, replace the `loopbackAgent` import with
   `fetchAgent`, drop the `await` that the promise-returning helper needed, and pass the `hono` half
   where the file builds an app through `createApp`. In `src/http/server/preflight.test.ts`, replace
   the `import type request from "supertest"` at `:5` and the `request.Response` annotation at `:25`
   with `AgentResponse`. Change no assertion. **Adds exactly 0 cases.**

5. **Group C moves to level 1.** Apply the story-4 edit to `src/http/server/authorize.test.ts`,
   `src/http/server/dispatch.test.ts` and `src/http/server/route.test.ts`. Each also calls
   `createTestApp`, so the two paths converge on one level. **Adds exactly 0 cases.**

6. **Level 2 gains the wire cases it is the only level able to prove.** Add
   `src/http/server/shutdown-socket.test.ts` with 3 cases: a graceful shutdown drains one in-flight
   request to its full body; a connection opened after the shutdown starts is refused; the listener
   closes. Each case builds its own application, so the `WeakMap` cache holds one server per case
   and a closed server never reaches another case. Add 1 case to `test/helpers/agent.test.ts`: an
   application that writes two `set-cookie` values answers with two values over the socket, read
   through `response.headers["set-cookie"]` as an array from `supertest`. Change
   `loopbackServer` not at all. **Adds exactly 4 cases.**

7. **The socket budget is asserted.** Add `test/helpers/socket-budget.test.ts` with 2 cases. It
   reads every `*.test.ts` file under `src/` and `test/` with `readdir` recursive, and collects the
   files whose source names `loopbackAgent`, `loopbackServer` or `createSocketTestApp` in an import
   statement. All three names are needed: `show-blob.test.ts` reaches the socket through the third
   one. `test/helpers/app.ts` names two of them and is not a `*.test.ts` file, so the scan skips it.
   Case 1
   asserts the count equals 5. Case 2 asserts the sorted list equals the 5 rows of the level-2
   table, by exact path, so a new socket test names itself. The test states in its suite name that
   it counts only files that reach `test/helpers/agent.ts`. **Adds exactly 2 cases.**

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

- **The pass count rises by exactly 21.** Record the baseline at the base commit of this epic with
  `node --test 2>&1 | grep -m1 '^# pass'`, and record the same value after story 7. The second value
  equals the first plus 21: 1 from story 1, 14 from story 2, 4 from story 6 and 2 from story 7.
  Stories 3, 4 and 5 add 0 and drop 0. Any other delta is a blocker, and the failing story is the
  one whose named count does not match.

- **Group A changes zero lines.** After story 3, `git diff --stat <base>..HEAD -- <the 44 group-A
paths>` reports no changed file. This is the check, not the pass count.

- **The group membership is recomputed, not assumed.** Before story 4, run
  `grep -rlE 'loopback(Agent|Server)' --include='*.test.ts' src test` and
  `grep -rl createTestApp --include='*.test.ts' src test`. The two lists define groups A, B and C,
  less the 5 rows of the level-2 table. `src/http/server/blob/show-blob.test.ts` matches the second
  grep and is level 2, so it joins no group.
  `src/main.claim.test.ts` matches the second grep on a string literal and belongs to no group.

- **Every EPIC 030 parity test still passes**, at the same level EPIC 030 declares, with the same
  expected values.

- **Ephemeral-port resolution is proved, and `test/helpers/agent.test.ts` owns it.** The existing
  case `binds the loopback address and never the wildcard` asserts `address.address === "127.0.0.1"`.
  The story-1 case asserts `typeof address.port === "number"` and `address.port > 0`. An ephemeral
  port has no exact value, so the property is the assertion; nothing else in the suite may assert a
  port number.

- **The Host header a client sends with no override is `127.0.0.1:<port>`, and
  `src/http/server/host.test.ts:48` owns it.** That case exists today and keeps its name and its
  assertion.

- **A binary 206 range response is proved on the wire, and `src/http/server/blob/show-blob.test.ts`
  owns it.** `Range: bytes=0-4` answers 206, `content-range: bytes 0-4/10`, and a body equal to
  `Buffer.from("01234")` byte for byte. Those cases exist today and take no edit.

- **Graceful shutdown is proved, and `src/http/server/shutdown-socket.test.ts` owns it.** Its 3
  story-6 cases are the only owners. The drain is asserted by order, never by a delay.

- **Two `set-cookie` values survive the wire, and the story-6 case in
  `test/helpers/agent.test.ts` owns it.** The assertion is
  `assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"])`. Level 1 cannot own this, and
  the `Agent` contract joins the two values by rule 1, so no level-1 file may assert `set-cookie`.

- **Level 1 opens no listening socket, and case 14 of story 2 owns it.** It captures
  `process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length` before and after a
  `fetchAgent` request and asserts the two numbers are equal. The literal is `TCPServerWrap`, in
  that exact case.

- **Every level-2 server stays unref'd, and case 14 of story 2 owns that too.**
  `process.getActiveResourcesInfo()` reports only a resource that keeps the event loop alive, so an
  unref'd listener never appears in it. The case therefore runs after the file's level-2 servers
  exist and still finds no `TCPServerWrap`. No requirement asserts the state of the whole suite
  after the whole run: `node --test` runs each file in its own process, and the daemon tests listed
  in the Goal hold ref'd sockets by design.

- **No test depends on a wall clock, a shared temporary directory, or an ambient git
  configuration.** A test that needs a clock uses `test/helpers/virtual-clock.ts`. A test that needs
  a home uses its own `mktemp` directory and removes it.

## Open items

- S1 - status:OPEN - action:YES - keep supertest in the manifest - `package.json` lists `supertest`
  and `@types/supertest` as dev dependencies, and an earlier plan marked them for removal - fix:
  leave both entries in `package.json` unchanged through EPIC 035, and remove neither when koa is
  removed - why: 5 level-2 files need a real client over a real socket, and `scripts/lane-check.sh`
  locks `package.json` so no story can state this.
- S2 - status:OPEN - action:YES - the koa dev types outlive koa - `@types/koa` and `@types/koa__cors`
  serve `test/helpers/agent.ts`, `src/http/server/start.ts` and `src/http/server/koa-bridge.ts`
  through the whole of this epic - fix: remove both in EPIC 035, not before - why: removing them
  earlier breaks `typecheck` on `loopbackServer`. EPIC 034 story 3 takes the last koa name out of
  `src/` and `test/`, so the two packages sit unused from that point, and `package.json` is locked
  against every lane until a human removes them.
- S3 - status:FIXED - action:YES - `node_modules` was stale - `hono` 4.13.3 and `@hono/node-server`
  2.1.1 sat in `package.json` and `package-lock.json`, and `node_modules/hono` and
  `node_modules/@hono/node-server` were absent - fix: `npm install` has run; it added 2 packages and
  changed neither `package.json` nor `package-lock.json`, and `npm run verify` is clean afterwards -
  why: every story from EPIC 032 story 1 onward fails on an unresolved import, and no agent lane may
  touch the manifest.
- S4 - status:FIXED - action:YES - EPIC 034 story 3 named a factory that cannot serve level 2 -
  `listen` at `src/http/server/start.ts:11` returns `ListeningServer`, which carries `port` and
  `close` only, and `loopbackServer` needs the raw `node:http.Server` for `supertest(server)`,
  `server.address()`, `server.unref()` and the `WeakMap` cache - fix: in EPIC 034 story 3, build the
  level-2 server with `createServer(getRequestListener(hono.fetch))` or with
  `createAdaptorServer({ fetch: hono.fetch })` from `@hono/node-server` 2.1.1, and keep the existing
  `listen(0, "127.0.0.1")`, `unref()` and cache lines unchanged - why: `listen` exposes no server
  object, so the story as written cannot compile, and both named factories return a
  `node:http.Server` without listening. EPIC 034 story 3 now names `getRequestListener`, and EPIC 034
  carries the decision that explains why.
- S5 - status:FIXED - action:YES - EPIC 034 lost the oracle it claimed - EPIC 034 said the level-2
  harness is the regression oracle for the adapter swap, and EPIC 034 story 3 edits that same
  harness in the same epic - fix: state in EPIC 034 that `src/http/server/start.test.ts` and the nine
  `src/main.*.test.ts` daemon tests are the oracle, and that story 3 is a harness follow-on that
  must keep every level-2 case name and assertion - why: a harness cannot be the oracle for a change
  to itself. EPIC 034 now names the oracle in its Decisions, and its Verification gate asserts the
  nine daemon tests are undiffed.
- S8 - status:FIXED - action:YES - EPIC 032 story 15 stated five values, not a case count - the
  story named five bridge behaviours without saying how many `it` blocks carry them, and the EPIC 032
  Verification gate named a sixth with no owner - fix: EPIC 032 story 15 now enumerates exactly 6
  cases for `src/http/server/koa-bridge.test.ts`, the gate assigns case 5 and case 6 to it and the
  envelope half of the Host row to `src/http/server/app.test.ts`, and the EPIC 034 gate reads
  "falls by exactly 6" - why: EPIC 034 story 3 deletes that file, so its case count is the oracle for
  the one pass-count fall in the band, and a count left to the implementing agent is not deterministic.
- **Phase 1b is exempt from the `AGENTS.md` phase-2 test-boundary TODO.** That clause forbids
  opening another **phase-2** epic before the TODO closes. This epic is phase 1b.
- **The `AGENTS.md` test-boundary TODO stays open and unaffected.** The TODO names handler tests
  under `src/http/server/**` that import a query from `src/queries/**`, and query tests under
  `src/queries/**` that import a schema from `src/http/contract/**`. This epic edits the harness
  import in those handler tests and edits nothing else in them. It adds no such import, removes no
  such import, and touches no file under `src/queries/**`. The TODO is unchanged.
