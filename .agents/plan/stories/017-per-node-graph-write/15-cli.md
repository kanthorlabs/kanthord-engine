# Story 15 — The CLI

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: Story 13. The CLI is a typed client of `src/http/contract/`, so the operations must exist first.

## Change

Create `src/cli/node/create.ts`, `src/cli/node/update.ts` and `src/cli/node/delete.ts`, each following the pattern of `src/cli/plan/import.ts`: a `register<Name>` function taking `{ program, client, stdout, stderr, fail, exit }`, a commander sub-command under a `node` group, and a response parsed through the contract schema.

Create `src/cli/node/index.ts` exporting `nodeCommand(program)`, in the shape of `src/cli/plan/index.ts`, so the three files share one group and each registration is idempotent.

### `kanthord node create`

Options: `--project <id>`, `--kind <kind>`, `--title <text>`, `--parent <id>`, `--repo <name>`, `--worker <name>`, `--instruction <path>`, `--acceptance <path>`, `--depends-on <id...>`.

1. Call `plan.revisions` for the project and take the newest entry's `id`, or `null` when the list is empty.
2. Send it as `fromRevision` on `node.create`, with the body the `--kind` selects.
3. Print the returned `id` and `revision` on standard output.

### `kanthord node update`

Options: `--id <id>` plus the same field options as `create`.

1. Call `node.show` for the id, to fill the whole editable field set. An option the caller omits takes the stored value, so the request carries every field and the daemon never keeps a value silently.
2. Compute whether the request changes `parent` or `depends_on` against the `node.show` result. When it does, call `plan.revisions` and send the newest project revision. When it does not, send the `revision` field of the `node.show` result.
3. Print the returned `revision`.

### `kanthord node delete`

Options: `--id <id>`.

1. Call `node.show` for the id to learn its `projectId`, then `plan.revisions` for that project and take the newest entry's `id`.
2. Send it as `fromRevision` on `node.delete`.
3. Print each id of the returned `deleted` array, one per line, on standard output.

### Completeness output

Each command prints every returned `completeness` finding on standard **error**, one per line, and **exits zero**. A completeness finding is a report, not a failure. Print each as its code followed by its message.

### `src/cli/inventory.ts`

Add three entries to `declaredCommands`, keeping the existing sort by `path`:

```ts
  {
    path: ["node", "create"],
    operationIds: ["plan.revisions", "node.create"],
  },
  {
    path: ["node", "delete"],
    operationIds: ["node.show", "plan.revisions", "node.delete"],
  },
  {
    path: ["node", "update"],
    operationIds: ["node.show", "plan.revisions", "node.update"],
  },
```

The `node delete` entry names `node.show` because step 1 above reads the node to learn its project. The EPIC text at `.agents/plan/epics/017-per-node-graph-write.md:94` lists `["plan.revisions", "node.delete"]` for delete; that list omits the read the project id needs, and this story adds it. Record the difference in the commit message.

### `src/cli/program.ts`

Register the three commands, in the pattern of the existing plan registrations.

## Constraints

- `src/cli/` imports no command and no query. It reaches the daemon over HTTP through `DaemonClient`.
- `src/cli/` may import `domain/`, `http/contract/` and `cli/` only.
- Each command parses its response through the contract schema, never through an ad-hoc shape.
- A refusal exits non-zero through `exitCodeForError` of `src/cli/exit-code.ts`. A completeness finding exits zero.
- Add no interactive prompt. `--yes` belongs to `plan import` alone.

## Verify

Create `src/cli/node/create.test.ts`, `src/cli/node/update.test.ts` and `src/cli/node/delete.test.ts`, suite names matching the module path, using the fake client convention of `src/cli/plan/import.test.ts`.

- `node create sends the newest revision` — assert the recorded `node.create` request body carries the `id` of the newest `plan.revisions` entry as `fromRevision`.
- `node create in an empty project sends null` — assert `fromRevision: null` when `plan.revisions` returns an empty list.
- `node create prints the id and the revision` — assert the exact standard-output text.
- `node update fills the whole field set from node.show` — assert the recorded request carries every editable field, with the stored value for each omitted option.
- `node update sends the node revision on a field-only change` — assert `fromRevision` equals the `node.show` revision and that `plan.revisions` was **not** called.
- `node update sends the project revision on a parent change` and `... on a depends_on change` — assert `fromRevision` equals the newest `plan.revisions` entry in each case.
- `node delete sends the newest project revision` and `prints each deleted id on its own line`.
- `each command prints a completeness finding on standard error and exits zero` — one test per command; assert the standard-error text and `exit` code `0`, and assert `fail` was not called.
- `each command exits non-zero on a refusal` — one test per command, driving a `409 stale-revision` response.
- `src/cli/inventory.test.ts` and `src/cli/parity.test.ts` cover the three new entries with no edit beyond the inventory itself; the EPIC 009 parity assertion checks every declared operation id exists in the registry.
- `node --test src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/program.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/cli/node/create.test.ts`, `src/cli/node/update.test.ts` and `src/cli/node/delete.test.ts`. Hermetic coverage bullet `.agents/plan/epics/017-per-node-graph-write.md:171`.
