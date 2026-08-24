# Story 00 — The table inventory closes both ways

Epic: `.agents/plan/epics/011.1-acceptance-run-preconditions.md`

## Change

Two test files only. No production file changes.

### 1. `src/services/storage/schema-parity.test.ts`

Add an import beside the existing domain imports at line 5:

```ts
import { rows } from "../../domain/rows.ts";
```

Add one `it` inside the existing `describe("src/services/storage/schema-parity.test", ...)` block
(after the last case, `agent_invocation.agents CHECK agrees with the domain agentKinds`, which ends at
line 100). Use the file's existing `buildMigrated()` helper and its two-`after` teardown shape:

```ts
it("the table set after migrate equals Object.keys(rows)", () => {
  const { storage, temporary } = buildMigrated();
  after(() => storage.close());
  after(() => temporary.dispose());

  const tables = storage.transact((t) =>
    t.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ),
  ) as readonly Record<string, unknown>[];

  assert.deepEqual(
    tables.map((row) => row.name),
    Object.keys(rows),
  );
});
```

- `Object.keys(rows)` is already lexicographic (`src/domain/rows.ts:21-43`), so `ORDER BY name`
  matches it with no re-sort.
- The `type = 'table' AND name NOT LIKE 'sqlite_%'` filter is the one used at
  `src/services/storage/migration-0003-execution-and-journal.test.ts:469-472`. Migration 4 creates
  three indexes, so the `type` filter is required.

### 2. `src/domain/rows.test.ts`

Keep the five existing `it` cases unchanged. Add one `it` after the last one (`every key of rows
appears in domain.md`, lines 47-57):

```ts
it("the table list of domain.md equals Object.keys(rows)", () => {
  const domainMd = readFileSync(
    resolve(import.meta.dirname!, "../../docs/proposal/phase-1/domain.md"),
    "utf-8",
  );
  const lines = domainMd.split("\n");
  const markerIndex = lines.indexOf("`node:sqlite`. Tables:");
  assert.notEqual(
    markerIndex,
    -1,
    "domain.md has no `node:sqlite`. Tables: marker",
  );

  const declarationLine = lines
    .slice(markerIndex + 1)
    .find((line) => line.trim().length > 0);
  assert.ok(
    declarationLine !== undefined,
    "domain.md has no table declaration line",
  );

  const declared = [...declarationLine.matchAll(/`([a-z_]+)`/g)].map(
    (match) => match[1] as string,
  );

  assert.equal(
    new Set(declared).size,
    declared.length,
    "domain.md names a table twice",
  );
  assert.deepEqual([...declared].sort(), Object.keys(rows));
});
```

The parser is pinned to exactly one line: the first non-empty line after the literal line
`` `node:sqlite`. Tables: `` (`docs/proposal/phase-1/domain.md:33`). The declaration line is
`domain.md:35`. Nothing else in the document is read, so the backticked identifiers on lines 22,
37 and 10-11 cannot enter the set.

## Constraints

- Do not edit `src/domain/rows.ts`, `docs/proposal/phase-1/domain.md`, any migration, or any other
  test. Both directions must pass against the tree as it stands today: 19 tables, 19 keys, 19 names
  on `domain.md:35`.
- Do not delete the existing `every key of rows appears in domain.md` case. The new case supersedes
  it logically; the epic adds assertions and removes none.
- `schema-parity.test.ts` may import `src/domain/`. It must not import a second storage
  implementation.

## Verify

- `node --test src/services/storage/schema-parity.test.ts` — passes, five cases.
- `node --test src/domain/rows.test.ts` — passes, six cases.
- Regression guard, run by hand and reverted, not committed:
  - Append `t.all("SELECT 1")`-free statement `"CREATE TABLE orphan (id TEXT NOT NULL) STRICT"` to
    the `statements` array of `src/services/storage/migration-0004-event-indexes.ts`. Confirm
    `node --test src/services/storage/schema-parity.test.ts` fails on the new case. Revert.
  - Append `, and the planned table \`orphan\``inside a backtick pair to`docs/proposal/phase-1/domain.md:35`. Confirm `node --test src/domain/rows.test.ts` fails on the
    new case. Revert.
- `npm run verify` exits 0.
- Proof: this story delivers no line of the EPIC Proof block. It is covered by the
  `Coverage required beyond the Proof` bullet "A migration that creates a table with no key in
  `rows` fails `schema-parity.test.ts`, and a table name added to `domain.md` with no row schema
  fails `rows.test.ts`."
