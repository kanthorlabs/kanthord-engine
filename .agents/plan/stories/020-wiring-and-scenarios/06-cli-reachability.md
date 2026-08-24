# Story 6 — Every declared CLI leaf reaches its operation

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 5.

This is the mechanism that catches a **misbound** command. `src/cli/parity.test.ts` compares two name lists, so a `node delete` leaf that exits zero and calls no action passes it, passes its own unit test, passes the composition sweep and passes every scenario that never invokes it.

## Change

### A new `src/cli/reachability.test.ts`

Suite name `"src/cli/reachability.test"`. It imports `createCommandRecorder` from `../../test/helpers/command-recorder.ts`, and `declaredCommands` from `./inventory.ts`.

Hold one argument row per entry of `declaredCommands`:

```ts
type Row = Readonly<{
  path: readonly string[];
  argv: readonly string[];
  operationIds: readonly string[];
  effect?: "migrate" | "serve" | "writeFile";
}>;
```

`argv` is the full leaf invocation with every required option supplied by a literal value. Use a fixed ULID literal for every id option, so two runs issue the same bytes. Take each required option from the leaf's own registrar; a leaf that refuses on a missing option records no request and fails this test, which is the intended signal.

Write these cases:

- `it("holds one argument row for every declared command", ...)` — assert the sorted row paths deep-equal `commandPaths()`. A `declaredCommands` entry with no argument row fails here, and the failure names the missing path.
- `it("every leaf issues exactly the operation ids its inventory row declares, in order", ...)` — for each row, build a fresh recorder, `await recorder.run(row.argv)`, and `assert.deepEqual(recorder.operationIds(), row.operationIds)`, naming the command path on failure. Compare against the row's own list and against the `declaredCommands` entry, so the two can never drift.
- `it("plan import issues plan.revisions, plan.validate, plan.import in that order", ...)` — assert the exact ordered triple. This is the request-order shape `008-project-and-plan.md:70` already uses.
- `it("repository register issues provider.list, repository.inspect, repository.register in that order", ...)` — assert the exact ordered triple.
- `it("node update issues node.show, plan.revisions, node.update in that order", ...)` — assert the exact ordered triple, per `017-per-node-graph-write.md` story `15-cli.md:40-57`.
- `it("event list issues event.list alone", ...)` — assert the single id, so the one command this epic ships is proved to reach its route by the same mechanism.
- `it("config generate, db migrate and serve issue no request and record their own effect once", ...)` — for each of the three, assert `operationIds()` is `[]` and the named effect counter is exactly `1`.
- `it("a leaf whose action is not registered fails and names the command path", ...)` — the proof case. Build a program-level fixture in which the `node delete` leaf is registered with its options and **no** action, run its argv through the same comparison function the second case uses, and assert the comparison reports a mismatch whose message holds `node delete`. Build that fixture locally in this file; edit no production registrar.

## Constraints

- **This test proves reach and never effect.** A handler behind a reached route stays the owning epic's subject. Assert no response body and no daemon state.
- **Hermetic.** No network, no server, no spawned process, no temporary directory.
- Every option value is a literal. Mint no id and read no clock, so the recorded requests are byte-identical across runs.
- A row whose leaf refuses before issuing a request is a defect in the row, not in the leaf. Supply every required option.

## Verify

- `node --test src/cli/reachability.test.ts` exits 0.
- Deleting the `.action(...)` body of `src/cli/node/delete.ts` makes the second case fail, and the failure names `node delete`. Restore it.
- Removing one entry from the row table makes the first case fail, and the failure names the missing path.
- `npm run verify` exits 0.
- Proof: `src/cli/reachability.test.ts`, `test/helpers/command-recorder.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:151`, `:152`, `:153`.
