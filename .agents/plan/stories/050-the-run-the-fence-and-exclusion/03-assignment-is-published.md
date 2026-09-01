# Story 3 — `assignment` is published

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 2 (the `workerId` zod schema in `src/domain/worker-id.ts`), EPIC 047 Story 7 (migration `11` creates the `node.assignment` column).
Kind: story-foundation

## Change

**`src/domain/node.ts` — `nodeRow` at line 9-49.**

Add one field after `worker` at `src/domain/node.ts:18`:

```ts
assignment: workerId.nullable(),
```

Import `workerId` from `"./worker-id.ts"`. Add no refine: an assignment is legal on any node kind and in any state, and EPIC 047 created the column nullable with no CHECK.

**`src/domain/plan-graph.ts` — `StoredNode` at line 3-19.**

Add one field after `worker` at `src/domain/plan-graph.ts:11`:

```ts
assignment: string | null;
```

**`src/services/plan/sqlite.ts` — the read path.**

Four coordinated edits, all driven by the single `NODE_COLUMNS` constant:

- `src/services/plan/sqlite.ts:26-27` — add `assignment` to `NODE_COLUMNS`, directly after `worker`. `NODE_COLUMNS` feeds both `SELECT_NODE` (`:29`) and `INSERT_NODE` (`:42-45`), so both change together.
- `src/services/plan/sqlite.ts:42-45` — `INSERT_NODE` binds positional `?` placeholders for the first nine columns and hardcodes `'pending', NULL, NULL` for `state`, `block_reason` and `discard_reason`. Adding `assignment` after `worker` shifts that layout. Bind `NULL` for `assignment` in the `VALUES` list rather than adding a parameter: an import never sets an assignment, and the write path for the column is `plan.setNodeAssignment` of EPIC 050.1 and the switch of EPIC 056. **Do not add `assignment` to the `ON CONFLICT ... DO UPDATE SET` clause.** A re-import must leave an existing assignment untouched, because the switch of EPIC 056 is the only operation that changes one. The `NULL` in `VALUES` therefore applies to a first insert only.
- `src/services/plan/sqlite.ts:47-62` — add `assignment: string | null;` to the private `NodeRow` type, after `worker`.
- `src/services/plan/sqlite.ts:81-97` — add `assignment: row.assignment,` to `toNode`, after `worker`.

`readGraph` (`:142-158`), `readNode` (`:160-177`) and `readAllNodes` (`:179-187`) all select through `SELECT_NODE`, so they need no further edit.

**`src/http/contract/graph.ts` — the node projection.**

Add to `nodeShowResponse` at `src/http/contract/graph.ts:155-167`, after `worker` at `:160`:

```ts
assignment: z.string().nullable(),
```

Add it to `nodeShowResponse`, **not** to `nodeListItem` at `:131-141`. `nodeListItem` is the list projection and `nodeShowResponse` extends it; the EPIC names `node.show` and `project.graph`. Adding a field to `nodeListItem` would add it to `node.list` as well, which the EPIC does not ask for.

Add `assignment` to `nodeAttributes` at `src/http/contract/graph.ts:183-191`, which is the `project.graph` node projection.

**The two projection sources.**

- `src/queries/node/show-node.ts:61` — `showNode`, which `src/main.ts:510-512` binds to `node.show`. Thread `assignment` from `StoredNode` into the returned view.
- `src/queries/project/show-project-graph.ts` — the `project.graph` projection, which builds `nodeAttributes`. Thread `assignment` in there too.

The field is a direct copy from `StoredNode`; no domain branch is involved.

**Examples.** Add `assignment: null` to the `nodeClaim_node` example literal at `src/http/contract/execution.ts:60-81`. `src/http/contract/example.test.ts:73-142` parses every example against its schema, so an example missing a required field fails.

**Every fixture that a widened schema now refuses.** `assignment` is required-and-nullable on `nodeRow`, on `nodeShowResponse` and on `nodeAttributes`, so every fixture parsed against one of them needs the key. Enumerated against HEAD, and each is test-owned:

- `src/domain/node-view.test.ts`, `src/domain/plan-candidate.test.ts`, `src/domain/plan-diff.test.ts`, `src/domain/plan-graph.test.ts` — `StoredNode` fixtures. Add `assignment: null`, and make no fixture property optional: `StoredNode.assignment` is `string | null`, never `undefined`.
- `src/cli/node/claim.test.ts`, `src/cli/node/delete.test.ts`, `src/cli/node/release.test.ts`, `src/cli/node/show.test.ts`, `src/cli/node/unblock.test.ts`, `src/cli/node/update.test.ts`, `src/cli/project/graph.test.ts`, `src/cli/reachability.test.ts` — daemon-response fixtures parsed against `nodeShowResponse` or `nodeAttributes`.
- `src/http/server/node/claim-node.test.ts`, `src/http/server/node/release-node.test.ts`, `src/http/server/project/show-project-graph.test.ts` — handler responses. `src/http/server/project/show-project-graph.test.ts:261` pins the sorted attribute key list; insert `"assignment"` first, because the list is lexicographic.
- `src/commands/startup/recover-expired-leases.test.ts:653` — its `parseNode` helper parses a selected row against `nodeRow`. Add `assignment` to the helper's column list.

`pnpm test` is the check. A fixture missed here fails a suite this story does not name, which is what makes the list explicit rather than left to discovery.

**Field decisions.** Add one line per new schema field to `src/http/contract/field-decisions.fixture.ts`, in the form the file already uses, e.g. `"node.show.response#/properties/assignment required=true nullable=true enum=-"`. `src/http/contract/coverage.test.ts:355` asserts every registry field appears there.

## Constraints

- `assignment` is `z.string().nullable()` in the contract, not the `workerId` regex schema. `src/http/contract/coverage.test.ts:273` asserts every `z.enum` in the contract traces to a `domain/` import, and `src/http/contract/` restates no pattern; the grammar is enforced by `nodeRow` on the write path.
- Do not add `assignment` to `nodeListItem`.
- Do not write `node.assignment` here. The write path is `plan.setNodeAssignment`, which EPIC 050.1 owns.
- Do not add a refine to `nodeRow`.

## Verify

```
node --test src/domain/node.test.ts src/http/contract/graph.test.ts src/services/plan/sqlite.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/queries/node/show-node.test.ts src/queries/project/show-project-graph.test.ts
```

Add to `src/domain/node.test.ts`:

1. `"nodeRow accepts an assignment carrying a worker id"` — `assignment: "general@1"` asserted `true`.

2. `"nodeRow accepts a null assignment"` — asserted `true`.

3. `"nodeRow refuses an assignment value outside the worker id grammar"` — one case per value of `["claude.swe@1", "general", "general@", "general@0", "General@1"]`, each `safeParse` asserted `false`, with the value in the assertion message. Asserted by value, per the EPIC's gate.

4. `"nodeRow accepts an assignment on every node kind"` — one passing case for `initiative`, `objective` and `task`, proving no refine ties the field to a kind.

Add to `src/http/contract/graph.test.ts`:

5. `"nodeShowResponse carries assignment as a nullable string"` — parse a fixture with `assignment: "general@1"` and one with `assignment: null`, both asserted `true`; parse one omitting the key entirely, asserted `false`, so the field is required-and-nullable rather than optional.

6. `"nodeListItem does not carry assignment"` — assert `nodeListItem.safeParse({...validListItem, assignment: null}).success === false`. `nodeListItem` is a `strictObject`, so an extra key fails, which pins the field to `node.show` alone.

Add to `src/services/plan/sqlite.test.ts`:

7. `"readNode returns the assignment stored on the node row"` — open a real SQLite database on a temporary file, migrate fully, seed a node, then `UPDATE node SET assignment = 'general@1' WHERE id = ?`. Call `readNode` and assert the returned `StoredNode.assignment === "general@1"`.

8. `"readAllNodes returns a null assignment for an unassigned node"` — assert `assignment === null` for a freshly seeded node.

9. `"an import writes a null assignment and a re-import leaves an existing one untouched"` — insert a node through the store, assert `assignment === null`; `UPDATE node SET assignment = 'general@1'`; re-insert the same node id through the store; assert `assignment === "general@1"`. A re-import changes no assignment, because the switch of EPIC 056 is the only operation that does.

Add to `src/queries/node/show-node.test.ts`, which already imports `nodeShowResponse` at `:15` and parses a view at `:91`:

10. `"showNode returns the assignment"` — seed a node whose `assignment` column holds `"general@1"`, call `showNode`, and assert the view carries `assignment: "general@1"` and that `nodeShowResponse.safeParse(view).success === true`. This is the EPIC's stated gate for the projection. Do **not** put this case in `src/main.test.ts` or in a server handler test; the query is where the projection is built.

Add to `src/queries/project/show-project-graph.test.ts`:

11. `"project.graph carries the assignment on every node"` — seed one assigned and one unassigned node and assert the serialized graph node attributes carry `"general@1"` and `null` respectively.

`pnpm run verify` exits 0, and `pnpm test` reports zero failures across every suite, not only the named ones.

Proof: PASS lines delivered — `src/domain/node.test.ts` and `src/http/contract/graph.test.ts` in `PASS EPIC-050`.
