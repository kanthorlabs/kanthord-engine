# Story 19 — The composition root and the CLI

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Stories 7, 9, 10, 11, 15, 18.

Without this story `src/http/server/dispatch.ts` answers `501` from the real composition root while an injected test app answers `200`.

## Change

### `src/main.ts`

Build the four callables in this order, inside the existing `try` block after `const events = new SqliteEventLog(...)` at `:165` and before `const handlers = {` at `:213`. The order is forced: each one takes the previous.

1. `aggregateInitiative` bound with `{ plan, events, clock, instanceId }`.
2. `closeObjective` bound with `{ plan, execution, events, clock, aggregateInitiative: boundAggregateInitiative, instanceId }`.
3. `reportObjective` bound with `{ plan, lease, execution, events, clock, instanceId }`.
4. `reportOutcome` bound with `{ storage, plan, lease, execution, events, clock, reportObjective: boundReportObjective, closeObjective: boundCloseObjective, instanceId }`.

`instanceId` is the daemon instance identity of `016-readiness-applied.md:55`. The value at `src/main.ts:136` is minted inline into `publishIdentity`; hoist it into a `const instanceId = ulid();` above `held.publishIdentity({ ... })` and pass the same constant to both, so the published identity and every daemon-attributed event name one instance.

Add the handler entry to the map at `:213-337`, after `"node.show"` at `:307-309`:

```ts
        "node.report": reportNodeHandler({
          reportOutcome: (input) => boundReportOutcome(input),
        }),
```

Pass `execution` into `showNode` at `:308`:

```ts
          showNode: (input) => showNode({ storage, plan, execution }, input),
```

`unimplementedFor(handlers)` at `:338` then holds `node.report` no longer.

### `src/cli/node/report.ts`, `src/cli/node/attest.ts`, `src/cli/node/close.ts`

Three new files in the pattern of `src/cli/project/show.ts`, each exporting one register function and each reusing the `nodeCommand(program)` group helper EPIC 018 created under `src/cli/node/`.

- `registerNodeReport` — `kanthord node report`, options `--id <id>`, `--outcome <outcome>`, `--fence <fence>`, `--object-id <oid>`, `--reason <reason>`. It sends `report` equal to `--outcome`.
- `registerNodeAttest` — `kanthord node attest`, options `--id <id>`, `--fence <fence>`, `--object-id <oid>`. It sends `report: "attested"`.
- `registerNodeClose` — `kanthord node close`, options `--id <id>`, `--acknowledge-partial`. It sends `report: "closed"` and `acknowledgePartial` as a boolean.

Each one refuses a missing `--id` with `kanthord: invalid-request: --id is required` on stderr and `fail()`, exactly as `src/cli/project/show.ts:26-30` does. Each calls `client.call("node.report", body, { id })`, prints the parsed `nodeReportResponse` through a shared printer, and maps a non-ok result to `kanthord: ${code}: ${message}`. `--fence` parses to an integer; a non-integer is the same `invalid-request` refusal shape.

**No command takes an owner option**, because the token identifies the actor.

### `src/cli/program.ts`

Import the three register functions beside the imports at `:5-26`, and call all three beside the five EPIC 018 registrations of `018-claim-and-lease.md:119`, each with `{ program, client, stdout, stderr, fail }`.

### `src/cli/inventory.ts:6`

Add three entries, each in the existing bytewise path order:

```ts
  { path: ["node", "attest"], operationIds: ["node.report"] },
  { path: ["node", "close"], operationIds: ["node.report"] },
  { path: ["node", "report"], operationIds: ["node.report"] },
```

Three commands naming one operation is legal; `["plan", "import"]` at `:27-30` names three operations.

## Constraints

- `cli/` imports `domain/`, `http/contract/` and `cli/` only. It imports no command and no query.
- Bind each command once. Do not construct a command inside a handler closure body beyond the call itself.
- Do not add an `owner` option, an `--actor` option or a token option; `registerClientOptions` at `src/cli/program.ts:60` already carries the token.
- Change no existing handler entry apart from the `showNode` dependency addition.

## Verify

- Create `src/cli/node/report.test.ts`, `src/cli/node/attest.test.ts` and `src/cli/node/close.test.ts`, each in the pattern of `src/cli/project/show.test.ts`, over a recording client fake.
  - Each asserts the operation id, the parameters and the exact request body for one success case.
  - Each asserts the missing `--id` refusal writes the exact stderr line and calls `fail()` once, with zero client calls.
  - `report.test.ts` asserts `--outcome rejected --reason r --fence 3` sends `{ report: "rejected", fence: 3, reason: "r" }` and that `--fence abc` refuses with `invalid-request` and zero client calls.
  - `attest.test.ts` asserts the body is `{ report: "attested", fence: 3, objectId: <oid> }`.
  - `close.test.ts` asserts `--acknowledge-partial` sends `{ report: "closed", acknowledgePartial: true }` and that its absence sends `false`.
  - Each asserts a non-ok result prints `kanthord: <code>: <message>` and calls `fail()`.
- Add to `src/cli/program.test.ts`: `it("buildProgram registers node report, node attest and node close", ...)` — assert over the commander command tree, reading the `node` group and its subcommand names, and **not** over the file list.
- `node --test src/cli/node/report.test.ts src/cli/node/attest.test.ts src/cli/node/close.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts` exits 0.
- Add to `src/main.test.ts`: `it("the production handler map implements node.report", ...)` — import the composition function of `src/main.ts` and assert `unimplementedFor(handlers)` does not contain `node.report`. The assertion imports the composition function and never `createTestApp`.
- `node --test src/main.test.ts src/http/server/dispatch.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/cli/node/report.test.ts`, `src/cli/node/attest.test.ts` and `src/cli/node/close.test.ts`. Hermetic coverage: `019-outcome-report.md:135` and `:180`.
