# Story 17 — The composition root binds every route this epic adds

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: every story from 3 to 16.

Without this story `src/http/server/dispatch.ts:26-31` answers `501` for all three routes from the real composition root, while a handler test injected into `createTestApp` answers `200`. That is the exact defect this story closes.

## Change

### `src/services/config/`

- `Settings` at `src/services/config/index.ts:23-30` gains `leaseTtlMs: number`, declared after `attemptLimit` at `:29`.
- `src/services/config/convict.ts` gains the schema entry beside `attemptLimit` at `:217-221`:

  ```ts
  leaseTtlMs: {
    format: "positiveInteger",
    default: 300000,
    env: "KANTHORD_LEASE_TTL_MS",
  },
  ```

- The env-integer list at `src/services/config/convict.ts:332` gains `["KANTHORD_LEASE_TTL_MS", "leaseTtlMs"]`.
- The settings projection at `:476` gains `leaseTtlMs: config.get("leaseTtlMs") as number`.

A claim with no expiry has no recovery, and the whole epic rests on expiry.

`test/helpers/home.ts:17-28` writes a base config. Add `leaseTtlMs: 300000` to that base, so an existing daemon-backed test keeps a known TTL and `writeConfig({ leaseTtlMs: ... })` overrides it.

### `src/main.ts`

- `lease` and `execution` are **already constructed** in `src/main.ts` by Story 9, which needed them for `recoverExpiredLeases`, and Story 13 already bound them into `revokeActor`. Reuse those two bindings; construct neither a second time.

  ```ts
  const lease = new SqliteLease();
  const execution = new SqliteExecution({ ids });
  ```

  `main.ts` stays the **only** file that names either. **A story that changes a required signature updates its call sites in the same story**, so this story's `main.ts` work is route binding and configuration only. Leaving every composition edit to this story would keep `npm run typecheck` red from Story 9 to here for a reason no story declared.

- The handler map at `src/main.ts:213` gains three entries, placed after `node.show` at `:307-309`:

  ```ts
  "node.claim": claimNodeHandler({
    claimNode: (input) =>
      claimNode(
        {
          storage, plan, lease, execution, events, clock, ids,
          sweepExpiredExternalLeases: (transaction, sweepInput) =>
            sweepExpiredExternalLeases({ plan, lease, execution, events }, transaction, sweepInput),
          attemptLimit: settings.attemptLimit,
          leaseTtlMs: settings.leaseTtlMs,
          instanceId,
        },
        input,
      ),
  }),
  "node.heartbeat": heartbeatNodeHandler({ ... }),
  "node.release": releaseNodeHandler({ ... }),
  ```

  `instanceId` is the `const` EPIC 016 hoisted at `src/main.ts:136`. **`main.ts` binds `sweepExpiredExternalLeases` into `claimNode`**, because a command never imports a command, and `.agents/plan/epics/110-scheduler-leases-and-the-general-worker.md:30` sets that precedent.

- `node.list` at `:304-306` passes the parsed filter through unchanged; the handler and query signatures of Story 15 already agree.
- The `recoverExpiredLeases` binding at `:190-194` and the `revokeActor` binding already carry their new dependencies, from Story 9 and Story 13. Assert they do; add them only if a story before this one left them out.
- `unimplementedFor(handlers)` at `:338` holds **none** of `node.claim`, `node.heartbeat` and `node.release` after this change. That is a property of the production code; the test proves it over HTTP and never by importing this file.

### The construction order

`ids`, then `events`, then `lease`, then `execution`, then the handler map. `SqliteLease` takes no dependency and `SqliteExecution` takes `ids`, so the order is one way and there is no cycle.

## Constraints

- `main.ts` is the only file that names `SqliteLease` or `SqliteExecution`.
- Do not construct `NotImplementedLease` anywhere in `main.ts`.
- Bind exactly three new handler entries. Do not bind a `stubbed` operation.
- Do not open a transaction in `main.ts`. Every command opens its own.
- Do not add a background timer, an interval or a scheduler loop.
- `settings.leaseTtlMs` reaches `claimNode` and `heartbeatNode` and nothing else.

## Verify

**The proof of this story is not a unit test.** New file `src/main.claim.test.ts`, in the pattern of `src/main.test.ts:1-30`. It migrates one home through the CLI, launches the real daemon through `launchDaemon` at `test/helpers/daemon.ts:29`, and drives every route of this epic over HTTP against one database. **It uses no injected handler map at any step**, so every assertion runs against the production composition root.

It proves no packaging: `package.json` publishes `dist/main.js`, `launchDaemon` spawns `src/main.ts`, and `npm run verify` never runs `npm run build`.

### Port and host isolation

`test/helpers/home.ts:17-28` defaults to port `7421` and `allowedHosts` of `127.0.0.1:7421`. `npm test` runs `src/main.test.ts`, `src/main.readiness.test.ts` and this file, and two daemons on one port collide. **Follow `src/main.test.ts` exactly**: take a port from `reservePort()` of `test/helpers/port.ts`, pass it through `writeConfig({ http: { port, allowedHosts: [`127.0.0.1:${port}`] } })`, and address every request at that port. Do not rely on the default.

### Advancing the clock without a wall-clock wait

The real daemon runs `SystemClock`, so the test cannot advance time, and a `sleep` would make the suite non-hermetic and slow. **Expire the leases by writing the rows.**

**Expire both the objective lease and the task lease, in one committed statement.** `node.heartbeat` renewed both, so expiring the task row alone leaves the objective live under the first actor — and the second actor's claim is then refused `lease-held` on the objective rather than served. The claim under test cannot succeed unless both are dead.

```sql
UPDATE lease SET expires_at = 1
WHERE subject_kind = 'node' AND subject_id IN (?, ?)
```

Bind the task identity and the objective identity. Assert the statement reported **two** changed rows through a `RETURNING subject_id` read, so a mis-bound identity fails the test rather than silently expiring one row.

The second connection is opened and configured by the test, because **`busy_timeout` is connection-local** and the daemon's setting says nothing about this one:

1. `new DatabaseSync(join(home.path, "kanthord.db"))`.
2. `PRAGMA busy_timeout = 5000` and `PRAGMA foreign_keys = ON` on that handle. The timeout is what waits out a concurrent daemon write instead of failing with `SQLITE_BUSY`.
3. The `UPDATE` above, inside an explicit `BEGIN IMMEDIATE` / `COMMIT`.
4. `close()` the handle, **before** the next HTTP request. Visibility after commit is sound under WAL, and closing first means no reader lingers across the assertion.

This is deterministic, needs no `sleep`, and exercises the same sweep a real expiry does. **Do not shorten `leaseTtlMs` and wait.**

### The sequence, in this exact order

1. `plan.import` one project holding one initiative, one objective and two sibling tasks.
2. `actor.register` a harness, keeping its token.
3. The harness token calls `node.list?state=ready&kind=task` and **receives the two tasks**, asserted by identity.
4. `node.claim` on the first task answers `200`. Assert: `runId` names a task run whose `parent_run_id` is a **valid external objective run**, read back through a direct query; `attemptNo` is `1`; `heartbeatIntervalMs` is `100000`; and the task, its objective and its initiative are all `running`, asserted by identity through `node.show`.
5. A second actor's `node.claim` on the **sibling** task is `409 lease-held`, with `details.subject` of the **objective** and `details.relation` of `ancestor`. Two leases refuse that claim — the objective as `ancestor` and the first task as `sibling` — and `ancestor` precedes `sibling` in `leaseRelations`, so story five's precedence reports the objective.
6. That second actor's `node.claim` on the **objective** is `409 lease-held`, with `details.subject` of the **objective** and `details.relation` of `self`. Two leases refuse that claim — the objective itself as `self` and the first task as `descendant` — and `self` precedes `descendant`, so story five's precedence reports the objective's own holding.
7. An **EPIC-110-style objective acquisition** through `Lease.acquire` on that same objective row, run in-process against the same database file as `owner: "daemon_x"` and `ownerKind: "daemon"`, is refused `lease-held`. This is what proves the phase-2 worker and the harness arbitrate over one row.
8. `node.heartbeat` with the returned fence answers `200`, **extends `expiresAt`** and leaves `fence` unchanged, both asserted from the response and from the row.
9. Expire **both** leases by the direct write above. A second actor's `node.claim` on that same task answers `200`, and the sweep returned it to `ready` first: assert the previous task run ended with outcome `expired`, its attempt closed `cancelled`, the previous objective run ended with outcome `expired`, the new task fence is the old fence plus one, and the new attempt number is **`1`** — numbering is per run, and the sweep ended the old run.
10. The old owner's `node.release` on that task is `409 lease-held`.
11. Record the old owner's stale fence in the test as the value **EPIC 019 must refuse**, and assert it differs from the live fence. This epic ships no report route, so the assertion is on the two fences and not on a report call.

### Two further assertions in the same file

- `the production composition root binds all three routes` — **prove it over HTTP, never by importing `main.ts`.** `AGENTS.md` states that nothing imports `main.ts`, and `eslint.config.js:88` classifies it as `composition-root`, so a test that imports its composition function fails lint. Drive each of `node.claim`, `node.heartbeat` and `node.release` against the launched daemon with a well-formed request and assert the status is **anything but `501`**, which is the `expect: "any-but-501"` mechanism `src/main.test.ts:36` already uses. An unbound route answers `501` through `src/http/server/dispatch.ts:26-31`, so this fails exactly when a handler is missing. Do not import `unimplementedFor`, and do not import the composition function.
- `every request of this test was served by the production composition root` — assert by construction: the file imports neither `createTestApp` nor `test/helpers/app.ts` nor `src/main.ts`, asserted by a source read of itself.

Run:

- `node --test src/main.claim.test.ts src/main.test.ts src/services/config/convict.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-018`, through `src/main.claim.test.ts`. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:169-170`.
