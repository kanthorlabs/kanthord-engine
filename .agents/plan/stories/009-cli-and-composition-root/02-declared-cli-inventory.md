# Story 02 — the declared CLI inventory

Epic: `.agents/plan/epics/009-cli-and-composition-root.md`
Depends on: nothing in this epic. Dispatch it with Story 01.

## Change

### 1. `src/cli/inventory.ts` (new) — the authored list

```ts
export type DeclaredCommand = Readonly<{
  path: readonly string[];
  operationIds: readonly string[];
}>;

export const declaredCommands: readonly DeclaredCommand[];

export function commandPaths(): readonly string[];
```

`commandPaths()` returns `declaredCommands.map((entry) => entry.path.join(" "))`.

`declaredCommands` holds exactly these fourteen entries, in this exact order — bytewise ascending on `path.join(" ")`:

| `path`                       | `operationIds`                                                   |
| ---------------------------- | ---------------------------------------------------------------- |
| `["credential", "register"]` | `["provider.register"]`                                          |
| `["db", "migrate"]`          | `[]`                                                             |
| `["db", "status"]`           | `["system.db"]`                                                  |
| `["plan", "export"]`         | `["plan.export"]`                                                |
| `["plan", "import"]`         | `["plan.revisions", "plan.validate", "plan.import"]`             |
| `["project", "create"]`      | `["project.create"]`                                             |
| `["project", "list"]`        | `["project.list"]`                                               |
| `["project", "repository"]`  | `["repository.list", "project.repositories"]`                    |
| `["project", "show"]`        | `["project.show"]`                                               |
| `["repository", "register"]` | `["provider.list", "repository.inspect", "repository.register"]` |
| `["repository", "show"]`     | `["repository.show"]`                                            |
| `["run"]`                    | `["run.start"]`                                                  |
| `["serve"]`                  | `[]`                                                             |
| `["status"]`                 | `["system.status"]`                                              |

Two rules fix the `operationIds` column, and neither admits a judgement call:

- **An entry names every operation the command calls, in call order.** `.agents/plan/epics/009-cli-and-composition-root.md:20` requires the parity assertion to prove that "no command calls an operation absent from the registry", and a single terminal id cannot carry that. The three multi-call commands are `repository register` (`src/cli/repository/register.ts:35`), `project repository` (`.agents/plan/stories/008-project-and-plan/14-project-cli.md:115`) and `plan import` (`.agents/plan/stories/008-project-and-plan/15-plan-cli-handshake.md:107` fixes the handshake order as `plan.revisions`, `plan.validate`, `plan.import`).
- **Call order, not sorted order.** The array is the sequence the command issues, so `plan import` and `repository register` read as their protocols. Only the outer list of entries is sorted.
- **Two entries call no route.** `serve` is the daemon itself, and `db migrate` opens SQLite directly — `docs/proposal/api/system.md:46` calls it "the one command that does not call HTTP". Each carries an empty array.

## Constraints

- No entry for a phase-2 CLI command. `docs/proposal/api/repository.md:16` names `repository reconcile` and `instruction.md:18` names `instructions resolve`; both front a `stubbed` route whose `introducedIn` is `phase-2`, and this epic implements neither. `run` is the one exception, and it is an exception because `docs/proposal/phase-1/README.md:77` puts it in the P1-E1 oracle.
- `src/cli/inventory.ts` imports `src/http/contract/registry.ts` for nothing. It is data, and Story 03 owns every assertion that crosses it with the registry or the program.
- The order is part of the contract, not a convenience. A test compares two sorted lists with `deepEqual`, so an unsorted literal is a failure rather than a silent pass.

## Verify

```bash
node --test src/cli/inventory.test.ts
```

### `src/cli/inventory.test.ts` (new)

- `declaredCommands.length` is `14`.
- `commandPaths()` holds fourteen distinct strings: `new Set(commandPaths()).size` is `14`.
- `commandPaths()` equals its own bytewise sort, compared through `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`.
- Every `path` is a non-empty array of non-empty lowercase segments matching `/^[a-z][a-z-]*$/`.
- Exactly two entries carry an empty `operationIds`, and their paths are `"db migrate"` and `"serve"`.
- Every other entry's `operationIds` is non-empty, and no id repeats inside one entry.
- The flattened id list holds `17` ids across the twelve calling entries, and all seventeen are distinct: `new Set(flattened).size` is `17`.
- **The P1-E1 oracle is covered.** The test reads `docs/proposal/phase-1/README.md`, takes the lines between the literal `### P1-E1 — The onboarding journey` and the next line starting `### `, extracts every match of ``/`kanthord ((?:[a-z][a-z-]*)(?: [a-z][a-z-]*){0,2})/g``, drops any trailing word beginning `--`, deduplicates and sorts bytewise. The result deep-equals

  ```
  ["credential register", "plan export", "plan import", "project create",
   "repository register", "repository show", "run", "status"]
  ```

  and every one of the eight is in `commandPaths()`. This is the assertion that catches a proposal command the inventory forgot.

  **Its limit is stated, not hidden.** The scan covers eight of the fourteen entries. The other six — `db migrate`, `db status`, `project list`, `project repository`, `project show`, `serve` — appear in no P1-E1 line, and `docs/proposal/api/` names a CLI command for only two of them. A test asserts that exact residue: the six paths not covered by the scan deep-equal that list, so an entry silently added to the inventory lands in the residue and fails the assertion rather than passing unchecked. See B2 in the index.

`npm run verify` exits 0.

Proof: contributes `src/cli/inventory.test.ts` to `node --test src/cli/**/*.test.ts`.
