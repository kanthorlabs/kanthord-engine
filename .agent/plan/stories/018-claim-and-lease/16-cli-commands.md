# Story 16 — The CLI commands, registered

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 14 and Story 15.

**Registration is this story's deliverable, not a file count.**

## Change

### The client gains a query, because `node list` needs one

`CallInput` at `src/cli/client.ts:12-16` carries `operationId`, `parameters` and `body`, and `buildRequest` at `:38-79` renders no query string. `node list` takes five filters, so the client cannot reach the route without one. This is a real gap, and it is closed here.

- `CallInput` gains `query?: Readonly<Record<string, string>>`.
- `DaemonClient.call` at `:28-34` gains a fourth parameter, `query?: Readonly<Record<string, string>>`, after `parameters`. Existing call sites pass three arguments and stay valid.
- `buildRequest` appends the query string after the path substitution at `:60`. **Iterate the keys in bytewise order through `Buffer.compare`**, skip an `undefined` value, and encode each value with `encodeURIComponent`. Bytewise key order makes the request URL of one input reproducible, which the CLI tests assert on.
- `call` at `:81-84` passes `input.query` through unchanged.

Add these assertions to `src/cli/client.test.ts`:

- `buildRequest appends no query string when query is absent` — the URL is unchanged.
- `buildRequest appends the query keys in bytewise order` — pass `{ state: "ready", kind: "task" }` and assert the URL ends `?kind=task&state=ready`.
- `buildRequest skips an undefined value`.
- `buildRequest percent-encodes a value` — a value holding a space.

### The five command files

`src/cli/node/index.ts` — the group registrar, in the exact pattern of `src/cli/project/index.ts`: find an existing `node` command, otherwise `program.command("node").description("manage nodes")`.

Five files, each exporting one `registerNodeX` function that takes `{ program, client, stdout, stderr, fail }` and guards against a duplicate registration with the `group.commands.some(...)` check of `src/cli/project/list.ts:17-19`. Each one calls its operation over HTTP through `client.call`, parses the response through the contract schema, and prints. **Each imports no command and no query.**

- `src/cli/node/list.ts` — `registerNodeList`, operation `node.list`. It takes the five filters as commander options: `--project <id>`, `--kind <kind>`, `--state <state>`, `--block-reason <reason>`, `--repository <id>`. It builds the `query` object from the options that are present, omitting every absent one, and passes it as the fourth `client.call` argument. It prints one line per node, in the order the daemon returned.
- `src/cli/node/show.ts` — `registerNodeShow`, operation `node.show`, one `<id>` argument.
- `src/cli/node/claim.ts` — `registerNodeClaim`, operation `node.claim`, one `<id>` argument, an empty body. It **prints the fence, the expiry, the heartbeat interval, the run id and the attempt number**, because the harness passes the fence back on every later call. It prints the objective fence and the objective run id on the same output.
- `src/cli/node/heartbeat.ts` — `registerNodeHeartbeat`, operation `node.heartbeat`, one `<id>` argument and a required `--fence <n>` option. **It mints a fresh `Idempotency-Key` per call.**
- `src/cli/node/release.ts` — `registerNodeRelease`, operation `node.release`, one `<id>` argument and a required `--fence <n>` option.

`node claim` and `node heartbeat` need an `Idempotency-Key` header. `buildRequest` sets no such header today, so add one more optional `CallInput` member, `idempotencyKey?: string`, written to `headers["Idempotency-Key"]` when present. `node heartbeat` supplies a fresh value from `dependencies.randomBytes` per invocation; `node claim` supplies one too. Take `randomBytes` through the register input, as `registerConfigGenerate` already does at `src/cli/program.ts:66`.

### `src/cli/program.ts`

Import the five `registerNodeX` functions and call all five, beside `registerPlanImport` at `src/cli/program.ts:176`. Place the five calls after `registerPlanExport` at `:187-195`, in the order `list`, `show`, `claim`, `heartbeat`, `release`. **Without this edit the real composition root carries none of the five**, and a test that builds a program by hand proves nothing.

### `src/cli/inventory.ts`

`declaredCommands` at `src/cli/inventory.ts:6-71` is sorted by command path. Insert five entries, each in its sorted position between the `db status` entry at `:19-22` and the `plan export` entry at `:23-26`:

```ts
{ path: ["node", "claim"], operationIds: ["node.claim"] },
{ path: ["node", "heartbeat"], operationIds: ["node.heartbeat"] },
{ path: ["node", "list"], operationIds: ["node.list"] },
{ path: ["node", "release"], operationIds: ["node.release"] },
{ path: ["node", "show"], operationIds: ["node.show"] },
```

The EPIC 009 inventory parity assertion in `src/cli/inventory.test.ts` and `src/cli/parity.test.ts` then covers all five.

## Constraints

- `cli/` imports `domain/`, `http/contract/` and `cli/` only. It imports no command, no query and no service.
- Every operation id the five files call is already in the registry from Story 14 and Story 15. Add no registry row here.
- Change no existing `client.call` call site. The new parameters are optional and trailing.
- `node claim` sends an empty JSON body, `{}`. It does not omit the body: the contract declares `z.strictObject({})`.
- Do not add a `--ttl` option. The TTL is configuration.
- Do not print a token, a secret or a raw error body.

## Verify

Five new test files, `src/cli/node/list.test.ts`, `show.test.ts`, `claim.test.ts`, `heartbeat.test.ts` and `release.test.ts`, each in the exact harness pattern of `src/cli/project/list.test.ts`: a `Command`, `registerClientOptions`, a recording client stub, and captured `stdout`, `stderr` and `fail`.

Per file:

- `it calls its operation with the expected parameters and body` — assert the recorded `operationId`, `parameters` and `body`.
- `it prints the expected lines on success` — assert the exact captured stdout.
- `it prints the error code and calls fail on a refusal` — assert the exact captured stderr and one `fail` call.

Plus, per named case:

- `node list passes only the supplied filters` — invoke with `--state ready --kind task` and assert the recorded `query` is exactly `{ state: "ready", kind: "task" }`. Invoke with no option and assert the recorded `query` is `undefined` or `{}`, and assert the same object either way.
- `node list prints one line per node in the returned order`.
- `node claim prints the fence, the expiry, the heartbeat interval, the run id and the attempt number` — assert all five appear in the captured stdout, and assert the objective fence and objective run id appear too.
- `node claim sends an empty body` — assert the recorded body is `{}`, not `undefined`.
- `node heartbeat mints a different Idempotency-Key on two consecutive calls` — invoke twice against a recording client that captures the header, and assert the two values differ.
- `node heartbeat and node release require a fence` — invoke with no `--fence` and assert commander refuses.

`src/cli/program.test.ts`:

- `buildProgram registers node list, node show, node claim, node heartbeat and node release` — assert over the **commander command tree** of the program `buildProgram` returns, by walking the `node` group's `commands` and comparing the name list, **not** over the file list.

`src/cli/inventory.test.ts` and `src/cli/parity.test.ts`:

- the existing EPIC 009 parity assertions pass over the five new entries, with no assertion of a total count added.

Run:

- `node --test src/cli/node/list.test.ts src/cli/node/show.test.ts src/cli/node/claim.test.ts src/cli/node/heartbeat.test.ts src/cli/node/release.test.ts src/cli/client.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through the five `src/cli/node/*.test.ts` files. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:214-215`.
