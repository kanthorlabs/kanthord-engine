# Story 04 — the `501` sweep gains no row

Epic: `.agent/plan/epics/010-contract-completion.md`
Depends on: nothing in this epic. Dispatch it in parallel with Story 01.

`src/http/server/dispatch.test.ts:288-310` already drives every `stubbed` route and asserts `501`. It asserts nothing about state, so the EPIC clause "answers `501` and writes no state" (`docs/proposal/api/README.md:54`, `docs/proposal/api/execution.md:24`) is unproved. This story rewrites that one test into a sweep that can observe a write.

The sweep is only meaningful if a write is reachable. So the app under test binds a **witness** handler to every `routed` operation, and the witness inserts a row. Driving the `stubbed` paths then proves two things at once: dispatch refuses a stub before any handler runs, and `matchRoute` never lands a stubbed path on a routed operation's handler.

**State exactly what this proves, in the test's own comment-free assertion messages and in review.** It proves that a stubbed request never reaches a bound handler, and that no table gained a row — which is the EPIC's own wording (`.agent/plan/epics/010-contract-completion.md:47`). It does **not** prove "writes nothing": a row count cannot see an `UPDATE`, and cannot see a `DELETE` offset by an `INSERT`. `writes === 0` is the stronger of the two assertions, because the witness is the only code in the test connected to the temporary database. The count snapshot is the EPIC's literal requirement and is kept for that reason, not because it is the tighter proof.

## Change

### 1. `test/helpers/database.ts` — one new export

```ts
export function tableCounts(
  storage: Storage,
): Readonly<Record<TableName, number>>;
```

- `rows` and `TableName` are imported from `src/domain/rows.ts:21,43`. A test helper may import `domain/`.
- Iterate `Object.keys(rows)` in **bytewise order**, and for each run `SELECT COUNT(*) AS n FROM "<table>"` inside one `storage.transact`.
- The table name is interpolated from the `rows` key, never from a parameter. `rows` is a closed `as const` object, so no free-form string reaches the SQL.
- The result carries all nineteen tables, including `migration`, so a schema change cannot silently drop a table from the snapshot.

### 2. `src/http/server/dispatch.test.ts:288-310` — replace the sweep

The new test is named `"every stubbed route answers 501 and writes no row"`. Its body:

```ts
const temporary = createMigratedStorage();
t.after(() => temporary.dispose());

let writes = 0;
const witness: Handler = () => {
  writes += 1;
  temporary.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `event_01HZY8QF3M4N5P6R7S8T9V0W${String(writes).padStart(2, "0")}`,
        "node",
        "node_01HZY8QF3M4N5P6R7S8T9V0W1A",
        "witness",
        "daemon",
        "d1",
        "{}",
      ],
    );
  });
  return { status: 200, body: {} };
};

const handlers = Object.fromEntries(
  registry
    .filter((entry) => entry.status === "routed")
    .map((entry) => [entry.operationId, witness]),
);
const app = await createTestApp({ handlers });
const before = tableCounts(temporary.storage);

let driven = 0;
for (const entry of registry) {
  if (entry.status !== "stubbed") continue;
  const path = renderPath(entry.path).replace(/:[^/]+/g, "x_01");
  const response = await drive(app, entry.method, path);
  assert.equal(response.status, 501, `${entry.operationId} ${path}`);
  assert.equal(response.body.error.code, "not-implemented", entry.operationId);
  assert.deepEqual(tableCounts(temporary.storage), before, entry.operationId);
  driven += 1;
}
```

`drive` is imported from `test/helpers/app.ts`, where Story 01 exports it. It maps `"DELETE" | "GET" | "POST" | "PUT"` onto `app.del`, `app.get`, `app.post`, `app.put` and sends no body. Do not write a local copy.

Four assertions close the test:

- `assert.equal(driven, registry.filter((entry) => entry.status === "stubbed").length)` — the sweep is derived from the registry, so a new stub is driven with no hand-written list.
- `assert.equal(driven, 30)` — the count today (`src/http/contract/registry.test.ts:29-38`). A registry that gains a stub fails here and the author moves one number, having already been driven by the line above.
- `assert.equal(writes, 0)` — no witness ran.
- `assert.deepEqual(tableCounts(temporary.storage), before)` once more after the loop.

### 3. `src/http/server/dispatch.test.ts` — one companion case

Named `"a routed route reaches the witness and writes a row"`. Same witness and the same app, driving `GET /v1/health`: the response is `200`, `writes` is `1`, and `tableCounts(...).event` is `before.event + 1`.

**Without this case the sweep is vacuous.** It is the proof that the witness can write at all, so `writes === 0` in the sweep means "dispatch refused" rather than "the witness was broken".

## Constraints

- The rewritten sweep replaces `src/http/server/dispatch.test.ts:288-310` and nothing else in that file. Every other case there stays byte-identical, including the two Story 01 additions.
- No production file changes. This story edits one test file and one test helper.
- The app under test has no storage. The witness closes over the temporary storage directly, which is why the write is observable at all.
- `bindingOffenders` (`src/http/server/app.ts:90-117`) refuses a handler bound to a `stubbed` id, so the witness map is filtered to `routed` and `unimplemented` is left empty. `createTestApp` derives `unimplemented` from the handler bag (`test/helpers/app.ts:16-23`), so binding all twenty-three routed ids leaves it empty and `createApp` accepts it.
- The witness ULIDs are literal and ascending. No id is minted at test time.
- `tableCounts` uses `SELECT COUNT(*)`, never `SELECT *`, matching the guard at `src/queries/repository/list-repository.test.ts:263-270`.

## Verify

```bash
node --test src/http/server/dispatch.test.ts test/helpers/database.test.ts
```

- The sweep drives thirty paths, every one answers `501` with `not-implemented`, and the nineteen-table snapshot is identical before and after each call.
- The companion case proves one routed call does move the snapshot.
- `test/helpers/database.test.ts` — if the file does not exist, create it with suite name `"test/helpers/database.test"`. It asserts `Object.keys(tableCounts(storage))` deep-equals the bytewise-sorted keys of `rows` from `src/domain/rows.ts`, that a freshly migrated database reports `0` for every table except `migration`, and that one inserted `event` row moves `event` from `0` to `1` and no other entry.

  **The `migration` count is asserted as `migrations.length`, not as a literal.** Story 02 adds a fourth migration, and whichever of the two stories lands second must not have to move a number here. The literal is pinned once, in Story 02's own `migration-0004-event-indexes.test.ts`.

**One failure is proved by hand and then reverted.** Add a temporary `stubbed`-to-witness binding by removing the `routed` filter from the handler map. `createApp` throws `BindingError`, which confirms the guard. Restore the filter.

`npm run verify` exits 0.

Proof: contributes the `src/http/server/dispatch.test.ts` sweep and `test/helpers/database.test.ts`. Neither is inside the EPIC Proof glob — see B1 in the index.
