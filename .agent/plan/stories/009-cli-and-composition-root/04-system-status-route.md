# Story 04 — the `system.status` route

Epic: `.agent/plan/epics/009-cli-and-composition-root.md`
Depends on: EPIC 008 Story 13 (it writes the last contract test counts this story then edits).

`system.status` is `routed` in the registry (`src/http/contract/system.ts:46-52`) and answers `501` today, because `src/main.ts:188-235` binds no handler for it. Story 05 renders its body, and Story 07 asserts it is bound. See B1 in the index for why this story is here and not in EPIC 010.

## Change

### 1. `src/http/contract/system.ts` — the response schema

Add above `export const system`:

```ts
export const systemStatusResponse = z.strictObject({
  version: z.string().min(1),
  bind: z.string().min(1),
  startedAt: z.string().min(1),
  status: z.enum(["ok", "degraded"]),
  dependencies: z.array(
    z.strictObject({
      name: z.string().min(1),
      status: z.enum(dependencyStatuses),
    }),
  ),
  nodes: z.array(
    z.strictObject({
      kind: nodeKind,
      state: nodeState,
      blockReason: blockReason.nullable(),
      count: z.number().int().positive(),
    }),
  ),
  repositories: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      divergedLandingOid: z.string().min(1),
      divergedUpstreamOid: z.string().min(1),
    }),
  ),
  leases: z.array(
    z.strictObject({
      subjectKind: z.enum(["node", "repository"]),
      subjectId: z.string().min(1),
      owner: z.string().nullable(),
      fence: z.number().int(),
      expiresAt: z.number().int(),
    }),
  ),
});
```

`nodeKind`, `nodeState` and `blockReason` are imported from `../../domain/state.ts:4,17,31`. No enum is restated — a second copy is a defect, and `.agent/plan/epics/009.5-contract-schemas.md` audits the whole contract for one later.

Attach `response: systemStatusResponse` to the `system.status` entry at `src/http/contract/system.ts:46-52`.

Four field decisions, each fixed here so no build-time choice remains:

- `startedAt` is an ISO-8601 string, not epoch milliseconds. `docs/proposal/api/system.md:55` calls it "the process start time" and a human reads this route.
- `blockReason` is present and `null` when the state is not `blocked`, never absent. `docs/proposal/api/system.md:55` requires it "where the state is `blocked`", and an explicitly-`null` field is unambiguous where an absent one is not. `009.5` applies the same rule to every optional value in its audit.
- `repositories` carries both diverged object ids, non-nullable. `src/domain/repository.ts:23-30` refines `state = 'needs-reconcile'` to be exactly the case where both are non-null, so the list cannot hold a null.
- `leases` carries `expiresAt` non-nullable, because the list is the **expired** leases and an expired lease has an expiry.

### 2. `src/domain/health.ts` (new) — the three types both queries need

```ts
export type DependencyStatus = "ok" | "failed" | "not-implemented";
export type DependencyLine = Readonly<{
  name: string;
  status: DependencyStatus;
}>;
export type HealthResult = Readonly<{
  status: "ok" | "degraded";
  dependencies: readonly DependencyLine[];
}>;
```

`src/queries/system/read-health.ts` currently declares all three itself. Replace its three declarations with an import from `src/domain/health.ts`, and keep `export type { DependencyStatus }` there so `src/main.ts:76` needs no edit. `readStatus` imports the same three. A query may import `domain/` and may not import another query (`eslint.config.js:117-129`), so `domain/` is the only place one copy can live. The file is three type aliases and imports nothing, so `src/domain/layout.test.ts:55-66` — no `Date.now`, no `new Date`, no `Math.random` — passes by construction.

### 3. `src/queries/system/read-status.ts` (new)

```ts
export type ReadStatusDependencies = Readonly<{
  storage: Storage;
  clock: Clock;
  health: () => HealthResult;
  version: string;
  bind: string;
  startedAt: string;
}>;

export type ReadStatusResult = Readonly<{
  version: string;
  bind: string;
  startedAt: string;
  status: "ok" | "degraded";
  dependencies: readonly DependencyLine[];
  nodes: readonly NodeCountLine[];
  repositories: readonly ReconcileLine[];
  leases: readonly ExpiredLeaseLine[];
}>;

export function readStatus(
  dependencies: ReadStatusDependencies,
): ReadStatusResult;
```

`health` is an injected function, not an import. `eslint.config.js:117-129` allows a query `domain/` and a service interface only, so `read-status.ts` cannot import `read-health.ts`. `src/main.ts:220` already injects `readRepositoryView` into a command for the same reason, and one injected call site is what makes `docs/proposal/api/system.md:63` — "from the same query, so the two can never disagree" — structural.

Three statements, one transaction, each with its ordering fixed in the SQL:

```sql
SELECT kind AS kind, state AS state, block_reason AS blockReason, COUNT(*) AS count
FROM node
GROUP BY kind, state, block_reason
ORDER BY kind ASC, state ASC, block_reason ASC
```

```sql
SELECT id AS id, name AS name,
       diverged_landing_oid AS divergedLandingOid,
       diverged_upstream_oid AS divergedUpstreamOid
FROM repository
WHERE state = 'needs-reconcile'
ORDER BY id ASC
```

```sql
SELECT subject_kind AS subjectKind, subject_id AS subjectId,
       owner AS owner, fence AS fence, expires_at AS expiresAt
FROM lease
WHERE expires_at IS NOT NULL AND expires_at <= ?
ORDER BY subject_kind ASC, subject_id ASC
```

**Every column is aliased to its result name, and the row is returned as-is.** `Transaction.all` returns `readonly unknown[]` (`src/services/storage/index.ts:3`), so each row is cast to the line type and pushed without a field-by-field rebuild. `src/queries/repository/list-repository.ts:29-33` selects snake_case and rebuilds by hand; that shape exists there because it also derives four computed fields. This query derives none, so aliasing in SQL is the smaller change and leaves no mapping to invent.

The lease parameter is `dependencies.clock.now()`. Expiry is inclusive: a lease whose `expires_at` equals the clock is expired. `src/services/storage/migration-0003-execution-and-journal.ts:20-29` is the table, and `PRIMARY KEY (subject_kind, subject_id)` makes the lease order total.

`version`, `bind` and `startedAt` are copied through unchanged. `status` and `dependencies` are `dependencies.health()`.

### 4. `src/http/server/system/status.ts` (new)

```ts
export type StatusHandlerDependencies = Readonly<{
  readStatus: () => ReadStatusResult;
}>;

export function statusHandler(dependencies: StatusHandlerDependencies): Handler;
```

`src/http/server/system/db.ts` is the shape: parse nothing, call once, return `{ status: 200, body: result }`. No branch.

### 5. `src/main.ts` — bind it

- **`startedAt` is captured at process entry, not at handler-binding time.** Add `const startedAt = new Date().toISOString();` immediately after the imports, above `const program = new Command()` at `src/main.ts:79`. `docs/proposal/api/system.md:55` says "the process start time"; capturing it after config load, home-lock acquisition and the tool probe would report the moment the daemon finished booting instead. It is the one `new Date()` in `src/main.ts` outside `publishIdentity` at `:112`, and `src/domain/layout.test.ts:55-66` scans `src/domain/` only, so it is legal there.
- Add to the `handlers` object of `:188-235`, between `"system.db"` and `"provider.register"`:

```ts
"system.status": statusHandler({
  readStatus: () =>
    readStatus({
      storage,
      clock,
      health: () => readHealth({ reporters }),
      version: KANTHORD_VERSION,
      bind: settings.http.bind,
      startedAt,
    }),
}),
```

The `system.health` binding at `:189-191` keeps its own `() => readHealth({ reporters })`. One `readHealth` implementation, two call sites, no second computation of the dependency list.

### 6. The four contract counts this story moves

**These are post-EPIC-008 values, not current-tree values.** `.agent/plan/stories/008-project-and-plan/13-graph-queries.md:173-174` leaves twenty response-bearing operations and twenty-eight `components.schemas` keys. This story adds one of each.

- `src/http/contract/system.test.ts:173-196` — `withResponse.length` becomes **21**, and the sorted id list gains `"system.status"`.
- `src/http/contract/registry.test.ts:88-99` — the same `withResponse` list, gaining `"system.status"`.
- `src/http/contract/system.test.ts:168` — the title and the body drop `system.status`; only `blob.show` carries no response schema.
- `src/http/contract/openapi.test.ts:205-224` — `components.schemas` holds **29** keys, bytewise sorted: `Error`, the seven `<id>.request` keys and the twenty-one `<id>.response` keys. The one added key is the literal `system.status.response`, and it sorts between `repository.show.response` and `system.db.response`.
- `src/http/contract/openapi.test.ts:184-203` — `system.status` now yields `Object.keys(responses)` of `["200", "default"]`.

Unchanged: `openapi.test.ts:74-80` (47 paths) and `:112-120` (53 ids), `registry.test.ts:14-16` and `:29-38`, `parity.test.ts` in full, `app.test.ts:160-165` and `dispatch.test.ts:182-194` (21 unimplemented, computed from a two-handler bind and unaffected by any binding this story adds). This story adds no operation and no path.

## Constraints

- No migration. `node`, `repository` and `lease` all exist (`migration-0002-graph-and-plan.ts:17`, `migration-0001-core-entities.ts`, `migration-0003-execution-and-journal.ts:20`).
- No new error code. The route answers `200` or a transport refusal.
- `readStatus` is synchronous end to end. `src/services/storage/connection.ts:90-101` rolls back and throws on a promise returned from `transact`.
- The query re-sorts nothing in TypeScript. Every order is an `ORDER BY`, so the assertion and the index agree.
- `docs/proposal/api/README.md:11` keeps a field schema out of the proposal. Edit no file under `docs/`.

## Verify

```bash
node --test src/queries/system/read-status.test.ts src/queries/system/read-health.test.ts src/http/server/system/status.test.ts src/http/contract/system.test.ts src/http/contract/registry.test.ts src/http/contract/openapi.test.ts
```

### `src/queries/system/read-status.test.ts` (new)

Built on `createMigratedStorage()` (`test/helpers/database.ts:30`) and `createMockClock({ start: 1700000000000, step: 1000 })`.

- An empty database returns three empty arrays and copies `version`, `bind` and `startedAt` through byte for byte.
- **Nodes group and order.** Seeded with `seedGraph` (`test/helpers/rows.ts:79`) plus two extra `task` rows in `blocked` with `block_reason` `attempt-limit` and `stale-base`, the `nodes` array deep-equals, in order:

  ```
  [{ kind: "initiative", state: "pending",  blockReason: null,           count: 1 },
   { kind: "objective",  state: "pending",  blockReason: null,           count: 1 },
   { kind: "task",       state: "blocked",  blockReason: "attempt-limit", count: 1 },
   { kind: "task",       state: "blocked",  blockReason: "stale-base",    count: 1 },
   { kind: "task",       state: "pending",  blockReason: null,           count: 1 }]
  ```

  `blocked` sorts before `pending` bytewise, and a `null` `block_reason` sorts first inside a group. Both are asserted by this exact literal.

- **Only `needs-reconcile` repositories appear.** Two repositories, one `ready` and one `needs-reconcile`, yield one entry carrying both diverged object ids.
- **Only expired leases appear, and the boundary is inclusive.** Three leases at `now - 1`, `now` and `now + 1` yield the first two, and a lease with a `null` `expires_at` yields none.
- Leases order by `subject_kind` then `subject_id`: a `repository` lease and two `node` leases yield the two node leases first, in id order.
- `owner` reaches the result as `null` when the column is null.
- `health` is called exactly once per `readStatus` call, and its `status` and `dependencies` reach the result unchanged. A reporter that throws yields `status: "degraded"`.
- `systemStatusResponse.parse(readStatus(...))` succeeds on every case above. This is the assertion that keeps the query and the schema from drifting.

### `src/http/server/system/status.test.ts` (new)

- A `GET /v1/status` through `createTestApp({ handlers: { "system.status": statusHandler({ readStatus }) } })` answers `200` with the body the injected `readStatus` returned, unchanged.
- No token answers `401`; an `Origin` header answers `403`. Both come free from the middleware chain and are asserted once, matching `src/http/server/system/db.test.ts`.
- The handler calls `readStatus` exactly once and reads neither `context.body` nor `context.parameters`.

### The contract files

- `src/http/contract/system.test.ts` — the two edited assertions above, plus: `systemStatusResponse` rejects an unknown key, rejects an absent `blockReason`, accepts `blockReason: null`, rejects a `count` of `0`, and rejects a `kind` outside `nodeKinds`.
- `src/http/contract/registry.test.ts` — the ten-id `withResponse` list.
- `src/http/contract/openapi.test.ts` — the twenty-nine-key list with `system.status.response` in its sorted position, and `system.status` carrying `["200", "default"]`.
- `src/queries/system/read-health.test.ts` — unchanged in substance. It must stay green after the three types move to `src/domain/health.ts`, which is a type-only move with no runtime effect.

`npm run lint` is part of the gate and is what proves the type move stayed inside the import matrix.

`npm run verify` exits 0.

Proof: contributes `src/queries/system/read-status.test.ts` and `src/http/server/system/status.test.ts`. Neither is inside the EPIC Proof glob — see B2 in the index, which widens the Proof.
