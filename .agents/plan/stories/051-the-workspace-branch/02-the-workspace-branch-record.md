# Story 2 — The workspace branch record

Epic: `.agents/plan/epics/051-the-workspace-branch.md`
Depends on: Story 1 (`01-migration-13`), which creates the table `schema-parity` then compares. It closes the red interval that story opens.
Kind: story-foundation

## Change

### 1 — `src/domain/workspace.ts`

Add `workspaceBranchRow` beside `src/domain/workspace.ts:7` — `workspaceRow`, which is not changed.

```ts
export const workspaceBranchRow = z.object({
  nodeId: nodeIdentity,
  originOid: objectId,
  headOid: objectId,
});
export type WorkspaceBranchRow = z.infer<typeof workspaceBranchRow>;
```

`nodeIdentity` and `objectId` are already imported by the module at
`src/domain/workspace.ts:3` — `nodeIdentity` and `src/domain/workspace.ts:4` — `objectId`. The shape
follows `src/domain/run.ts:48` — `runBaseRow`, the nearest keyless leaf row: no `id`, no
`.strict()`, no `.refine()`, and the inferred type on the next line.

**No `identityKinds` entry is added.** `src/domain/identity.ts:3` — `identityKinds` mints a prefix for
a table that owns its own id, and this table is keyed on the node id, so `nodeIdentity` is the fit and
the three pinned counts of `src/domain/identity.test.ts:17` — `it` do not move.

**No `state` column and no `state` field.** Neither this epic nor `../docs/workflow/worker.md`
section 7 defines a transition for the branch record, and a column with no transitions is a column
nobody can write correctly.

### 2 — `src/domain/repository.ts`

Add the derived ref beside `src/domain/repository.ts:72` — `featureRefOf`:

```ts
export function objectiveRefOf(nodeId: string): string {
  return `refs/heads/${nodeId}`;
}
```

`ref` is a pure function of the key, which is why migration `13` stores no `ref` column. The name
and the shape follow the shipped `<thing>RefOf` convention at
`src/domain/repository.ts:57` — `headRefOf` and `src/domain/repository.ts:72` — `featureRefOf`.

### 3 — the registry, and the two documents it is checked against

Register `workspace_branch: workspaceBranchRow` in `src/domain/rows.ts`, immediately after
`src/domain/rows.ts:45` — `workspace`. The import at `src/domain/rows.ts:21` — `workspaceRow` becomes
`import { workspaceBranchRow, workspaceRow } from "./workspace.ts";`, following
`src/domain/rows.ts:20` — `runBaseRow`, the one shipped import line carrying two schemas.

`workspace` sorts **before** `workspace_branch`, because `workspace` is a proper prefix of it.
`src/domain/rows.test.ts:41` — `Object.keys` asserts `Object.keys(rows)` equals its own sort, so the
position is not free.

Three shipped pins move with the registration:

- `src/domain/rows.test.ts:10` — `it` asserts the length is `22` and becomes `23`.
- `src/domain/rows.test.ts:14` — `it` holds the twenty-two names by value; add `"workspace_branch"`
  after `"workspace"`, and the title of that case becomes twenty-three.
- `docs/proposal/phase-1/domain.md:39` gains `` `workspace_branch` `` after `` `workspace` ``.
  `src/domain/rows.test.ts:62` — `it` reads the line after the `` `node:sqlite`. Tables: `` marker
  and compares the declared names, sorted, against `Object.keys(rows)`.

`src/services/storage/schema-parity.test.ts:90` — `it` then passes, which is the red interval Story 1
(`01-migration-13`) states.

### 4 — the three plan-store methods

`src/services/plan/index.ts` gains one record type, two input types and three members. The record and
the inputs sit with the other `...Input` types above the interface, at
`src/services/plan/index.ts:65` — `SetNodeAssignmentInput`:

```ts
export type WorkspaceBranchRecord = Readonly<{
  nodeId: string;
  originOid: string;
  headOid: string;
}>;

export type WriteWorkspaceBranchInput = Readonly<{
  nodeId: string;
  originOid: string;
}>;

export type SetWorkspaceBranchHeadInput = Readonly<{
  nodeId: string;
  headOid: string;
}>;
```

The read joins the reads, after `src/services/plan/index.ts:94` — `readRepositoryName`:

```ts
  readWorkspaceBranch(
    transaction: Transaction,
    nodeId: string,
  ): WorkspaceBranchRecord | null;
```

The two writes join the writes, after `src/services/plan/index.ts:123` — `setNodeAssignment`:

```ts
  writeWorkspaceBranch(
    transaction: Transaction,
    input: WriteWorkspaceBranchInput,
  ): WorkspaceBranchRecord | null;
  setWorkspaceBranchHead(
    transaction: Transaction,
    input: SetWorkspaceBranchHeadInput,
  ): void;
```

`readWorkspaceBranch` takes the node id positionally, following
`src/services/plan/index.ts:78` — `readNode`, the shipped shape for a single-key read. The two writes
take an input object, because each carries more than one field.

### 5 — the implementation

`src/services/plan/sqlite.ts` gains a local snake-case row type beside
`src/services/plan/sqlite.ts:68` — `EdgeRow`, and three methods. `readWorkspaceBranch` and
`writeWorkspaceBranch` map by hand, exactly as
`src/services/plan/sqlite.ts:223` — `findByImportId` does; no zod schema is parsed, because no
shipped store parses one.

- `readWorkspaceBranch` — `SELECT node_id, origin_oid, head_oid FROM workspace_branch WHERE node_id = ?`,
  cast to `WorkspaceBranchDbRow | undefined`, `null` when undefined.
- `writeWorkspaceBranch` —
  `INSERT INTO workspace_branch (node_id, origin_oid, head_oid) VALUES (?, ?, ?) ON CONFLICT (node_id) DO NOTHING RETURNING node_id, origin_oid, head_oid`,
  binding `input.originOid` twice. It returns the mapped row, or **`null` when the insert conflicted**.

  **The conflict is a typed result, never an exception a command classifies.**
  `AGENTS.md` — `commands/` hold the business logic and import no vendor package, so a command
  reading a SQLite `errcode` is a vendor leak. `ON CONFLICT ... DO NOTHING RETURNING` returns no row
  on a conflict and raises nothing, so Story 7
  (`07-the-loser-of-two-first-claims-refuses`) branches on `null` and never on an error code. A
  narrowed `errcode & 0xff === 19` would also have caught a foreign-key, CHECK or NOT NULL failure,
  which are defects and not contention.

  **The caller supplies one oid.** `head_oid` is written from `input.originOid`, so the two are equal
  at creation by construction rather than by a convention a caller could break.

- `setWorkspaceBranchHead` — `UPDATE workspace_branch SET head_oid = ? WHERE node_id = ?`, returning
  `void`, following `src/services/plan/sqlite.ts:565` — `setNodeAssignment`.

`setWorkspaceBranchHead` is declared and implemented here and called by nothing in this epic.
`.agents/plan/epics/051.3-the-checkpoint-and-the-land.md:65` — `plan.setWorkspaceBranchHead` is its
first caller.

## Constraints

- `workspaceRow` at `src/domain/workspace.ts:7` is not changed. The branch facts live in their own
  table, and `src/commands/startup/sweep-remnants.ts:45` reads `path` as a non-nullable string.
- `workspaceBranchRow` carries no `id`, no `ref`, no `repositoryId` and no `state`. Each is derived or
  undefined, per the epic's Decisions.
- The store parses no row schema. `src/services/plan/sqlite.ts` imports nothing from `src/domain/`
  today for validation, and this story does not start.
- `writeWorkspaceBranch` takes one oid and writes it to both columns. Do not give the input a
  `headOid` field; an API that accepts two independent oids admits a row the epic forbids and no test
  can reject.
- `writeWorkspaceBranch` raises nothing on a conflict. It returns `null`, and the SQL carries
  `ON CONFLICT (node_id) DO NOTHING RETURNING`.
- `setWorkspaceBranchHead` never writes `origin_oid`. The trigger of Story 1 (`01-migration-13`)
  refuses it, and the method must not carry the column at all.
- Register `workspace_branch` in bytewise position. `test/helpers/database.ts:117` — `databaseBytes`
  iterates that registry, so an omission silently drops the table from every byte-identical
  assertion in the suite.

## Verify

```
node --test src/domain/workspace.test.ts src/domain/rows.test.ts src/domain/repository.test.ts src/services/storage/schema-parity.test.ts src/services/plan/sqlite.test.ts
```

Extend `src/domain/workspace.test.ts`, which already holds `ULID_A`, `HASH` and `OID` at
`src/domain/workspace.test.ts:6`, and `src/services/plan/sqlite.test.ts`, whose fixture factory is
`src/services/plan/sqlite.test.ts:50` — `build` over
`test/helpers/database.ts:32` — `createMigratedStorage` and whose seeder is
`src/services/plan/sqlite.test.ts:108` — `seedAll`.

Add, each as a separate `it`:

1. `"workspaceBranchRow accepts a row keyed on an objective identity"` — parse
   `{ nodeId: "objective_" + ULID_A, originOid: OID, headOid: OID }` and assert `success === true`.

2. `"workspaceBranchRow rejects each missing key"` — loop over `Object.keys(validRow)`, delete one
   per iteration, assert `success === false` with the key in the message, following
   `src/domain/workspace.test.ts:29` — `it`.

3. `"workspaceBranchRow rejects a wrong identity kind and a non-object id"` — three parses:
   `nodeId: "repo_" + ULID_A`, `originOid: "not-an-object-id"` and `headOid: ""`, each asserted
   `false`.

4. `"rows holds twenty-three tables and workspace_branch is one of them"` — assert
   `Object.keys(rows).length === 23`, that the array holds `"workspace_branch"` exactly once, and
   that it equals its own bytewise sort.

5. `"domain.md declares workspace_branch in its table line"` — the shipped case at
   `src/domain/rows.test.ts:62` — `it` covers it once the document carries the name; assert here
   additionally that the declared list holds no duplicate.

6. `"schema-parity finds the migrated table set equal to Object.keys(rows)"` — the shipped case at
   `src/services/storage/schema-parity.test.ts:90` — `it` passes once the row is registered; assert
   here additionally that the migrated table list holds `"workspace_branch"` and no
   `git_operation_old`.

7. `"a round trip through writeWorkspaceBranch and readWorkspaceBranch returns the written row field by field"`
   — write `{ nodeId: fixtureIds.objective, originOid: OID_A }` in one `storage.transact`, read it
   back in a second, and `deepEqual` the record against
   `{ nodeId: fixtureIds.objective, originOid: OID_A, headOid: OID_A }`. The single input oid
   reaching both columns is the assertion.

8. `"writeWorkspaceBranch returns the record it inserted"` — `deepEqual` the returned value against
   the same object, and assert the value is returned without a second `SELECT` by wrapping the
   transaction in `src/services/plan/sqlite.test.ts:2682` — `recordingTransaction` and asserting the
   recorded statement list holds exactly one `INSERT` and no `SELECT`.

9. `"readWorkspaceBranch returns null for an objective with no record"` — assert `null` by value. The
   control is case 7 over the same fixture, which returns a record.

10. `"setWorkspaceBranchHead moves head_oid and leaves origin_oid"` — write the row of case 7, call
    `setWorkspaceBranchHead` with `OID_B`, and assert `headOid === OID_B` and `originOid === OID_A`.

11. `"setWorkspaceBranchHead on an objective with no record writes nothing"` — call it over the empty
    fixture and assert `SELECT count(*) FROM workspace_branch` reads `0`. The control is case 10,
    which writes.

12. `"a second writeWorkspaceBranch on one objective returns null and raises nothing"` — assert the
    second call returns `null`, that it does **not** throw, that the stored row still holds the
    first `origin_oid`, and that a write on a **different** objective returns a record. Story 7
    (`07-the-loser-of-two-first-claims-refuses`) rests on this result, so it is proven at the store
    before a command depends on it.

12b. `"a foreign-key failure still throws and is not reported as a conflict"` — the control for case 12. Write a record naming a `nodeId` no `node` row carries; assert it throws rather than
returning `null`. Without this, a store that swallowed every constraint would pass case 12.

13. `"objectiveRefOf returns refs/heads/ followed by the node id"` — assert
    `objectiveRefOf("objective_a") === "refs/heads/objective_a"` by value, in
    `src/domain/repository.test.ts`.

14. `"the repository of a branch record joins from node"` — seed the branch record on
    `fixtureIds.objective`, read the node with `plan.readNode`, and assert
    `node.repositoryId === fixtureIds.repository` by value.
    `src/services/storage/migration-0002-graph-and-plan.ts:33` — `CHECK` is what makes the join total
    for an objective, so no null branch exists to test.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/workspace.test.ts`,
`src/services/storage/schema-parity.test.ts` and `src/services/plan/sqlite.test.ts` in
`PASS EPIC-051`.
