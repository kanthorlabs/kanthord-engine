# Story 16 — The CLI commands, registered

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: Story 14 and Story 15.

**Registration is this story's deliverable, not a file count.**

## Change

### The client gains a query, because `node list` needs one

`CallInput` at `src/cli/client.ts:12-16` carries `operationId`, `parameters` and `body`, and `buildRequest` at `:38-79` renders no query string. `node list` takes five filters, so the client cannot reach the route without one. This is a real gap, and it is closed here.

- `CallInput` gains two members:

  ```ts
  query?: Readonly<Record<string, string | undefined>>;
  idempotencyKey?: string;
  ```

  **`string | undefined` and not `string`.** A caller builds the query from commander options, most of which are absent, and `Record<string, string>` cannot express an absent value — so "skip an `undefined` value" would be unreachable code under that type. The optional-value form is what makes the skip rule real.

- `DaemonClient.call` at `:28-34` stops growing positional parameters. It takes **one options object** for the two new facts:

  ```ts
  call(
    operationId: string,
    body: unknown,
    parameters?: Readonly<Record<string, string>>,
    options?: Readonly<{
      query?: Readonly<Record<string, string | undefined>>;
      idempotencyKey?: string;
    }>,
  ): Promise<CallResult>;
  ```

  A fourth and fifth positional parameter would make every future addition a positional guess at a call site. Existing call sites pass two or three arguments and stay valid.

- `buildRequest` appends the query string after the path substitution at `:60`. Sort the keys with `Buffer.compare` over the key names, **skip every entry whose value is `undefined`**, encode each key and each value with `encodeURIComponent`, and join with `&` after a single `?`. When every value is skipped, append **nothing** — not a bare `?`. Bytewise key order makes the URL of one input reproducible, which the CLI tests assert on.
- `buildRequest` writes `headers["Idempotency-Key"] = input.idempotencyKey` when the member is present, beside the two headers it already sets at `:63-66`.
- `call` at `:81-84` passes both new members through unchanged.

**The generated key is pinned.** `node claim` and `node heartbeat` each mint one per invocation as `randomBytes(16).toString("hex")` — 16 bytes, lowercase hex, 32 characters. Take `randomBytes` through the register input, as `registerConfigGenerate` already does at `src/cli/program.ts:66`, so the tests inject a counting stub and the value is never read from ambient randomness.

Add these assertions to `src/cli/client.test.ts`:

- `buildRequest appends no query string when query is absent` — the URL is unchanged.
- `buildRequest appends the query keys in bytewise order` — pass `{ state: "ready", kind: "task" }` and assert the URL ends `?kind=task&state=ready`.
- `buildRequest skips an undefined value`.
- `buildRequest percent-encodes a value` — a value holding a space.

### The five command files

`src/cli/node/index.ts` — the group registrar, in the exact pattern of `src/cli/project/index.ts`: find an existing `node` command, otherwise `program.command("node").description("manage nodes")`.

Five files, each exporting one `registerNodeX` function that takes `{ program, client, stdout, stderr, fail }` and guards against a duplicate registration with the `group.commands.some(...)` check of `src/cli/project/list.ts:17-19`. Each one calls its operation over HTTP through `client.call`, parses the response through the contract schema, and prints. **Each imports no command and no query.**

- `src/cli/node/list.ts` — `registerNodeList`, operation `node.list`. It takes the five filters as commander options: `--project <id>`, `--kind <kind>`, `--state <state>`, `--block-reason <reason>`, `--repository <id>`. It builds the `query` object from the options that are present, omitting every absent one, and passes it as the fourth `client.call` argument. It prints one line per node, in the order the daemon returned.
- `src/cli/node/show.ts` — `registerNodeShow`, operation `node.show`, a required `--id <id>` option.
- `src/cli/node/claim.ts` — `registerNodeClaim`, operation `node.claim`, a required `--id <id>` option, an empty body. It **prints the fence, the expiry, the heartbeat interval, the run id and the attempt number**, because the harness passes the fence back on every later call. It prints the objective fence and the objective run id on the same output.
- `src/cli/node/heartbeat.ts` — `registerNodeHeartbeat`, operation `node.heartbeat`, a required `--id <id>` option and a required `--fence <n>` option. **It mints a fresh `Idempotency-Key` per call.**
- `src/cli/node/release.ts` — `registerNodeRelease`, operation `node.release`, a required `--id <id>` option and a required `--fence <n>` option.

### The exact output, and the exact refusal output

Every line is pinned. `kanthord: ` is the existing prefix, and every line ends with one `\n`, following `src/cli/project/list.ts:41-44`.

```
node list, per node:   kanthord: node <id> <kind> <state> <blockReason|-> <parentId|->
node list, empty:      kanthord: no node
node show:             kanthord: node <id> <kind> <state> <title>
node claim:            kanthord: claimed <nodeId> fence <fence> expires <expiresAt> heartbeat <heartbeatIntervalMs>ms
                       kanthord: run <runId> attempt <attemptNo|-> objective-run <objectiveRunId> objective-fence <objectiveFence>
node heartbeat:        kanthord: renewed <nodeId> fence <fence> expires <expiresAt>
node release:          kanthord: released <nodeId> state <state>
```

`node claim` prints **two** lines, in that order. A null `attemptNo` prints `-`, which is the objective-claim case. `expiresAt` prints the raw epoch-millisecond integer: a formatted date needs a timezone and this output is compared byte for byte.

**Every refusal prints one line and calls `fail` once**, exactly as `src/cli/project/list.ts:26-28` does:

```
kanthord: <code>: <message>
```

**`--fence` parsing is explicit.** Parse with `Number.parseInt(value, 10)`, and when the result is not a positive integer, print `kanthord: invalid-request: --fence must be a positive integer` and call `fail` **without** calling the daemon. Commander passes an option value as a string, so an unvalidated `--fence abc` would otherwise send `NaN` and be refused by the server instead of the client.

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

- `node list passes only the supplied filters` — invoke with `--state ready --kind task` and assert the recorded `query` is exactly `{ state: "ready", kind: "task" }` with `assert.deepEqual`.
- `node list with no option passes no query` — assert the recorded `options` argument is `undefined`. **One representation only**: an absent query is `undefined`, never `{}`. A command that supplies an empty object and one that supplies nothing must not both be legal, or the assertion cannot be exact.
- `node list prints one line per node in the returned order` — assert the exact multi-line stdout string against a literal.
- `node list prints the empty line when there is no node` — assert `kanthord: no node\n` exactly.
- `node claim prints its two lines exactly` — assert the full captured stdout against a literal two-line string, including `fence`, `expires`, `heartbeat`, `run`, `attempt`, `objective-run` and `objective-fence`.
- `node claim prints a dash for a null attempt number` — the objective-claim case, asserted against a literal.
- `node claim sends an empty body` — assert the recorded body is `{}`, not `undefined`.
- `node claim and node heartbeat each send an Idempotency-Key of 32 lowercase hex characters` — assert the captured header matches `/^[0-9a-f]{32}$/`.
- `node heartbeat mints a different Idempotency-Key on two consecutive calls` — invoke twice against a counting `randomBytes` stub that returns a different buffer per call, and assert the two captured headers differ.
- `node heartbeat and node release refuse a non-numeric fence without calling the daemon` — invoke with `--fence abc`; assert the exact stderr line, one `fail` call, and that the recording client captured **zero** calls. Repeat for `--fence 0` and `--fence -1`.
- `node heartbeat and node release require a fence` — invoke with no `--fence` and assert commander refuses.

`src/cli/program.test.ts`:

- `buildProgram registers node list, node show, node claim, node heartbeat and node release` — assert over the **commander command tree** of the program `buildProgram` returns, by walking the `node` group's `commands` and comparing the name list, **not** over the file list.

`src/cli/inventory.test.ts` and `src/cli/parity.test.ts`:

- the existing EPIC 009 parity assertions pass over the five new entries, with no assertion of a total count added.

Run:

- `node --test src/cli/node/list.test.ts src/cli/node/show.test.ts src/cli/node/claim.test.ts src/cli/node/heartbeat.test.ts src/cli/node/release.test.ts src/cli/client.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through the five `src/cli/node/*.test.ts` files. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:214-215`.
