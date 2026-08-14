# Story 4 — CLI inventory parity for the block

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 3.

EPIC 009 owns the mechanism. Each vertical epic added its own `declaredCommands` rows. This story asserts the whole set by name and retires the scalar counts that six epics would otherwise each edit.

## Change

### `src/cli/parity.test.ts`

Replace every count assertion with a name assertion. Four cases change.

- `it("programCommandPaths returns the fifteen inventory paths", ...)` at `:75-80` — rename to `"programCommandPaths returns exactly the declared paths, by name"`. Delete `assert.equal(paths.length, 15)`. Keep `assert.deepEqual(paths, commandPaths())`, and add one `assert.deepEqual` of `commandPaths()` against an exact ordered literal list of all thirty-three paths, bytewise sorted:

  ```ts
  const expectedCommandPaths: readonly string[] = [
    "actor list",
    "actor register",
    "actor revoke",
    "actor rotate",
    "actor show",
    "config generate",
    "credential register",
    "db migrate",
    "db status",
    "event list",
    "node attest",
    "node claim",
    "node close",
    "node create",
    "node delete",
    "node heartbeat",
    "node list",
    "node release",
    "node report",
    "node show",
    "node unblock",
    "node update",
    "plan export",
    "plan import",
    "project create",
    "project list",
    "project repository",
    "project show",
    "repository register",
    "repository show",
    "run",
    "serve",
    "status",
  ];
  ```

  That list holds the fifteen phase-1 paths plus the eighteen of the block. Take the exact ordering from the assertion diff rather than by hand, and state no count anywhere in the file.

  **`repository register` and `repository show` are in that list because `src/cli/inventory.ts` declares them today.** `declaredCommands` holds fifteen paths at the close of phase 1, and an earlier draft of this literal held thirteen of them, so the literal disagreed with the prose by two. `06-cli-reachability.md` corroborates the first of the two: it holds a case for `repository register` issuing `provider.list`, `repository.inspect` and `repository.register`. A literal short of `declaredCommands` fails `compareCommandSets` on a path the block never touched, which reads as a defect in this epic rather than in the inventory.

- `it("pins seventeen distinct ids across twelve calling entries", ...)` at `:112-122` — rename to `"every calling entry names at least one operation id"`. Delete both scalars. Assert instead that the sorted list of command paths whose `operationIds` is empty deep-equals the exact literal `["config generate", "db migrate", "serve"]`.

- `it("reaches five ids only as a step of another command", ...)` at `:124-138` — keep the mechanism and update the expected literal to the step-only ids after the block. Take the list from the assertion diff. Delete the word "five" from the test name.

- `it("only run reaches a stubbed operation", ...)` at `:100-110` — unchanged. The block adds no `stubbed` operation.

### Two new cases in the same file

- `it("every operation id every command names resolves through findOperation", ...)` — iterate `declaredCommands`, iterate each `operationIds` member, and assert `findOperation(id)` is defined, naming the command path and the id on failure. This strengthens the existing `:92-98` case, which names the id alone; keep both.

- `it("the routed operations that no command names are exactly the eight accepted ones", ...)` — compute

  ```ts
  const named = new Set(
    declaredCommands.flatMap((entry) => entry.operationIds),
  );
  const uncovered = registry
    .filter((entry) => entry.status === "routed")
    .map((entry) => entry.operationId)
    .filter((id) => !named.has(id))
    .sort(byBytes);
  ```

  and assert it deep-equals exactly:

  ```ts
  [
    "blob.show",
    "edge.list",
    "project.status",
    "provider.remove",
    "provider.rename",
    "provider.setDefault",
    "provider.show",
    "system.health",
  ];
  ```

  Add one case asserting `event.list` and `node.unblock` are each absent from `uncovered`: Story 3 ships `kanthord event list`, and EPIC 019 ships `kanthord node unblock` beside its `routed` flip of that row. A ninth id fails the assertion, so a new route with no command becomes a decision rather than an oversight.

### `src/cli/inventory.test.ts`

Replace the scalar in `"declares exactly fifteen commands"` and in `"commandPaths holds fifteen distinct strings"` with the same name-based comparison, and replace `"flattens to seventeen distinct operation ids"` with an exact sorted literal list of the distinct ids. Take each literal from the assertion diff. Leave the bytewise-sort case, the segment-grammar case, the P1-E1 scan case and the seven-unnamed-paths case as they are, except where a new command changes their expected literal; update those literals from the diff too.

## Constraints

- **State no command count and no operation-id count in either file.** Every assertion names members.
- Add no command and no inventory row here. Story 3 added the only row this epic owns.
- A command in the inventory that `buildProgram` does not register is a defect returned to its epic. Do not register a missing command here.

## Verify

- `node --test src/cli/parity.test.ts src/cli/inventory.test.ts src/cli/program.test.ts` exits 0.
- Deleting the `["node", "claim"]` entry from `src/cli/inventory.ts` makes `compareCommandSets` report `missingFromInventory: ["node claim"]`, and the failure names the path. Restore the entry.
- Adding a fabricated `["node", "zeta"]` entry with `operationIds: ["node.zeta"]` fails the `findOperation` case naming `node.zeta`. Remove it.
- `npm run verify` exits 0.
- Proof: `src/cli/parity.test.ts`, `src/cli/inventory.test.ts`, `src/cli/program.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:157`, `:159`.
