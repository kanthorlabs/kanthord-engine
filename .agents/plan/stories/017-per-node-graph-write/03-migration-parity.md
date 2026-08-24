# Story 3 — Migration parity, split in two questions

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: Story 2. **Coupled with Story 2** — Story 2 turns this test red, and this story is the only fix. Implement Story 2 then Story 3 with no verify gate between them.

## Change

Two tests answer two different questions, and neither answers both.

- `migration-0002-graph-and-plan.test.ts` answers "did migration 0002 ship the schema version 2 declared". Its expectation is frozen history.
- `migration-0006-revision-origin.test.ts` answers "does the schema the daemon reaches today equal the proposal fence today". Its expectation is the live document.

### `src/services/storage/migration-0002-graph-and-plan.test.ts`

Add a module-level constant above the `describe` block, holding the version-2 `plan_revision` DDL verbatim as it stands at `src/services/storage/migration-0002-graph-and-plan.ts:7-16`:

```ts
const historicalPlanRevisionStatement =
  "CREATE TABLE plan_revision ( id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), parent_id TEXT REFERENCES plan_revision(id), import_id TEXT NOT NULL, submitted_blob TEXT NOT NULL REFERENCES blob(hash), choices_blob TEXT NOT NULL REFERENCES blob(hash), accepted_blob TEXT NOT NULL REFERENCES blob(hash), UNIQUE (project_id, import_id) ) STRICT";
```

That string is the normalized form: every whitespace run collapsed to one space, no trailing `;`. It must equal `normalize(graphAndPlan.statements[0])[0]` exactly.

Change the assertion at `src/services/storage/migration-0002-graph-and-plan.test.ts:214-217` from:

```ts
      ["plan_revision", "node", "edge"].flatMap(proposalStatements),
```

to:

```ts
      [historicalPlanRevisionStatement, ...["node", "edge"].flatMap(proposalStatements)],
```

The test keeps three entries, so no historical coverage is deleted.

Update the `it` title at `:207` from `parity: the three statements reproduce the three proposal tables verbatim, in order` to:

```
parity: node and edge match the proposal, and plan_revision matches the frozen version-2 DDL
```

Update the registry pin at `:232-239` to the six-entry list, and update its `it` title to name six migrations.

### `src/services/storage/migration-0001-core-entities.test.ts:186-187`

Update the registry pin and its `it` title to the six-entry list. **The migrations array is pinned in four test files, not three.** Missing this one alone fails `npm run verify`.

### `src/services/storage/migration-0003-execution-and-journal.test.ts:438`

Update the registry pin and its `it` title to the six-entry list.

### `src/services/storage/migration-0004-event-indexes.test.ts:35-49`

Update the registry pin and its `it` title to the six-entry list.

### `src/services/storage/migration-0006-revision-origin.test.ts`

Add one assertion. Take the `CREATE TABLE` statement out of `statements` by prefix rather than by index:

```ts
const created = migration0006RevisionOrigin.statements.filter((statement) =>
  statement.trimStart().startsWith("CREATE TABLE"),
);
```

Assert `created.length === 1`, then assert `normalize(created[0]!)` deep-equals `proposalStatements("plan_revision")`, using the same `normalize` helper shape as `migration-0002-graph-and-plan.test.ts:208-212`.

## Constraints

- Do not delete an assertion. The 0002 test keeps three entries in its expected list.
- Do not change `proposalStatements` at `test/helpers/proposal.ts:8-27`.
- Do not change `docs/proposal/database/plan_revision.md`. Story 1 owns that fence, and this story asserts against it.
- Write the historical constant as a literal, never as a re-read of `graphAndPlan.statements`. A constant that derives from the code under test asserts nothing.

## Verify

- `node --test src/services/storage/migration-0001-core-entities.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0006-revision-origin.test.ts` exits 0.
- `grep -rn "migration0004EventIndexes,$" src/services/storage/*.test.ts` returns nothing — every registry pin now names all six migrations.
- `migration-0002-graph-and-plan.test.ts` still asserts three statements, with `historicalPlanRevisionStatement` first.
- `migration-0006-revision-origin.test.ts` asserts its single `CREATE TABLE` statement equals `proposalStatements("plan_revision")`.
- A deliberate one-character edit to `docs/proposal/database/plan_revision.md` turns the 0006 test red and leaves the 0002 test green. Confirm this by hand once, revert the edit, and record the confirmation in the commit message.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/services/storage/migration-0002-graph-and-plan.test.ts` and `src/services/storage/migration-0006-revision-origin.test.ts`. Hermetic coverage bullet `.agents/plan/epics/017-per-node-graph-write.md:142`.
