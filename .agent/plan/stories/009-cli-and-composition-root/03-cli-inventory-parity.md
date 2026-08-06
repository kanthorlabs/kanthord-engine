# Story 03 — CLI inventory parity

Epic: `.agent/plan/epics/009-cli-and-composition-root.md`
Depends on: Story 01 (`buildProgram`), Story 02 (`declaredCommands`).

Land it after Story 05 and Story 06, because the equality it asserts is only true once `status` and `run` exist in the program.

## Change

### 1. `src/cli/parity.ts` (new) — the comparator

`src/http/contract/parity.ts:1-89` is the shape to mirror: a pure comparator, so a drift case is asserted without mutating the real program.

```ts
import type { Command } from "commander";

export type CommandSetDifference = Readonly<{
  missingFromProgram: readonly string[];
  missingFromInventory: readonly string[];
}>;

export function programCommandPaths(program: Command): readonly string[];

export function compareCommandSets(
  declared: readonly string[],
  actual: readonly string[],
): CommandSetDifference;
```

- `programCommandPaths` walks `program.commands` recursively. A node with no child contributes one path, `[...ancestors, node.name()].join(" ")`; a node with children contributes its children and **not itself**, because `db`, `credential`, `project`, `plan` and `repository` are group factories that take no action of their own (`src/cli/db/index.ts:9`). The root program contributes nothing. The result is sorted bytewise through `Buffer.compare`.
- `compareCommandSets` returns the two set differences, each sorted bytewise. Both empty means parity.

## Constraints

- Neither function reads `process`, the registry or the file system. The comparator is pure so a drift test can feed it a hand-built list.
- A commander option is not a command. `programCommandPaths` reads `program.commands` only, never `program.options`.
- Parity between the inventory and the registry is **one way**: every declared command names a registered operation, and no assertion requires an operation to have a command. Thirty-nine of the fifty-three registry entries are deliberately not CLI commands.

## Verify

```bash
node --test src/cli/parity.test.ts
```

### `src/cli/parity.test.ts` (new)

The program under test is `buildProgram(fakeDependencies())`, built with the same fake bag as `src/cli/program.test.ts`.

**Parity**

- `compareCommandSets(commandPaths(), programCommandPaths(buildProgram(fake)))` deep-equals `{ missingFromProgram: [], missingFromInventory: [] }`. This one assertion carries both directions.
- `programCommandPaths(buildProgram(fake))` has fourteen entries and deep-equals `commandPaths()`.
- A group name never appears: the result contains no `"db"`, `"credential"`, `"project"`, `"plan"` or `"repository"` entry.

**The registry crossing**

- **No command calls an operation absent from the registry.** For every id in every entry's `operationIds`, `findOperation(id)` is defined. A typo anywhere in the nineteen ids fails here. This is the EPIC's third parity clause, and it needs the full call list of Story 02 rather than a terminal id.
- Every such operation's `status` is `"routed"`, with exactly one exception: `run.start`, whose `status` is `"stubbed"`. Asserted as a filter, not as a hand-listed pair — `declaredCommands.filter((e) => e.operationIds.some((id) => findOperation(id)!.status === "stubbed")).map((e) => e.path.join(" "))` deep-equals `["run"]`.
- Seventeen ids across twelve entries, all distinct. Pinning the count is what catches an id dropped from a multi-call entry. Five of the seventeen — `provider.list`, `repository.inspect`, `repository.list`, `plan.validate` and `plan.revisions` — are reached only as a step of another command and are the whole reason the field is a list.

**The drift cases** — each feeds the comparator directly, so the real program is never mutated.

- A command in the inventory and not in the program: `compareCommandSets([...commandPaths(), "zeta"], programCommandPaths(program))` returns `missingFromProgram: ["zeta"]` and an empty `missingFromInventory`.
- A command in the program and not in the inventory: `compareCommandSets(commandPaths(), [...programCommandPaths(program), "zeta"])` returns `missingFromInventory: ["zeta"]` and an empty `missingFromProgram`.
- Both differences are reported at once, and each sorted bytewise: `compareCommandSets(["b", "a"], ["c", "a"])` returns `{ missingFromProgram: ["b"], missingFromInventory: ["c"] }`.
- The comparator is order-insensitive on its inputs: `compareCommandSets(["b", "a"], ["a", "b"])` is two empty arrays.

`npm run verify` exits 0.

Proof: contributes `src/cli/parity.test.ts` to `node --test src/cli/**/*.test.ts`.
