# Story 06 — The plan store reads and writes the two columns

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Depends on: Story 04, Story 05

## Change

### `src/services/plan/sqlite.ts`

**`NODE_COLUMNS` (lines 26–27):** Append `, deliverable, verify_json` to the existing column list string. The new string is:

```ts
const NODE_COLUMNS =
  "id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at, deliverable, verify_json";
```

`assignment` is NOT added to `NODE_COLUMNS`.

**`NodeRow` type (lines 47–62):** Add two fields matching the new columns:

```ts
deliverable: string | null;
verify_json: string | null;
```

Do NOT add `assignment`.

**`toNode` mapper (lines 81–97):** Add to the return object:

```ts
deliverable: row.deliverable,
verifyJson: row.verify_json,
```

**`insertNode` (line 424):** Extend the INSERT to include `deliverable` and `verify_json`. In the column list, append `, deliverable, verify_json`. In the VALUES clause, append `, ?, ?`. Pass `node.deliverable ?? null` and `node.verifyJson ?? null` at the corresponding positions in the params array.

In the `ON CONFLICT DO UPDATE` clause, append `, deliverable = excluded.deliverable, verify_json = excluded.verify_json`.

Do NOT add `assignment` to the INSERT column list, VALUES clause, or ON CONFLICT update.

## Constraints

- `assignment` is not read or written anywhere in this story.
- The write path is reached only by `plan import`. No other path writes `deliverable` or `verify_json`.
- `state`, `block_reason`, `discard_reason` stay excluded from the `ON CONFLICT` update clause.
- `verifyJson` in `StoredNode` stores the raw JSON string — parsing to `VerifyBlock` is the caller's responsibility (done in Story 08 by the query layer).

## Tasks

### Task 06 — Cover the two plan-store columns

**Input:** `src/services/plan/sqlite.test.ts`, `src/services/plan/sqlite.ts`

**Action — RED:** Two parts. Write both before you hand the Task over.

Part A — add the three cases named under `## Verify` to
`src/services/plan/sqlite.test.ts`. The file is a required Proof target.

Part B — repair the three exact-member assertions in the same file that the two new
`StoredNode` members make stale. Each one lists every member of a read row, so each one
gains `deliverable` and `verifyJson`:

- `readGraph returns every member of the seeded initiative`
- `readGraph returns every member of the seeded objective and task`
- `readNode returns the seeded task with every member and null for an unknown id`

The seeded rows carry no deliverable, so both expected values are `null` in all three.

**Action — GREEN:** Edit `src/services/plan/sqlite.ts` exactly as `## Change` names it —
`NODE_COLUMNS`, the `NodeRow` type, the `toNode` mapper and `insertNode`. `assignment`
enters none of the four.

**Action — REFACTOR:** None.

## Verify

```bash
node --test src/services/plan/sqlite.test.ts
```

Add cases to `src/services/plan/sqlite.test.ts`:

1. A node written with `deliverable = "test"` and `verify_json = '{"paths":["a/b.ts"],"commands":["npm test"]}'` is read back with both fields byte-identical via `readNode` and via `readGraph`.
2. A node written with `deliverable = null` and `verify_json = null` is read back with both fields as `null`.
3. Behavioral proof that the write path never sets `assignment`:
   a. Through raw SQL, set `assignment = 'sentinel'` on an existing node row.
   b. Call the plan store's upsert (via `mutateGraph` or equivalent) to upsert that same node with the same `id`.
   c. Read the row back and assert `assignment` is still `'sentinel'` — the upsert did not overwrite it.
   d. Insert a brand-new node through the plan store. Read it back and assert `assignment IS NULL`.

   The node kind used in fixtures for deliverable `"test"` must be `"task"` (not `"initiative"`) — `('task', 'test')` is legal; `('initiative', 'test')` is illegal and would fail the CHECK after Story 04.

Test framework: `node:test` and `node:assert/strict`. Real SQLite via `test/helpers/database.ts` helpers. Follow the existing `build()` pattern in the test file.

Proof: PASS EPIC-047 line for `src/services/plan/sqlite.test.ts`; hermetic coverage — node with `verify_json` reads back byte-identical, node with null reads back null, write path never sets `assignment`.
