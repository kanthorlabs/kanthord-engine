# Story 6 — Run driver

Epic: `.agent/plan/epics/014-external-drive-contract.md`
Depends on: EPIC 013 (sequence order). Stories 7, 12 and 14 import `runDrivers` and `RunDriver` from this file, so run this story before them.

## Change

### `src/domain/run.ts`

The file today is:

```ts
export const runRow = z
  .object({
    id: identity("run"),
    kind: z.enum(["objective", "task"]),
    nodeId: nodeIdentity,
    parentRunId: identity("run").nullable(),
    workspaceId: identity("workspace"),
    worker: workerKind,
    leaseFence: z.int(),
    attemptLimit: z.int(),
    baseOid: objectId,
    headOid: objectId.nullable(),
    state: z.enum(["active", "ended"]),
    outcome: z.string().nullable(),
    endedAt: epochMillis.nullable(),
  })
  .refine((row) => (row.kind === "objective") === (row.parentRunId === null), {
    message: "(kind = 'objective') = (parent_run_id IS NULL)",
  });
```

Make four edits.

1. Above `runRow`, add the enum in the shape `src/domain/event.ts:6-7` uses:

```ts
export const runDrivers = ["internal", "external"] as const;
export type RunDriver = (typeof runDrivers)[number];
```

2. Add one field to the object, immediately after `kind` and before `nodeId`: `driver: z.enum(runDrivers),`.
3. Make three fields nullable: `workspaceId: identity("workspace").nullable()`, `worker: workerKind.nullable()`, `baseOid: objectId.nullable()`.
4. Chain a second `.refine` **after** the existing one, never before it:

```ts
  .refine(
    (row) =>
      row.driver === "internal"
        ? row.workspaceId !== null && row.worker !== null && row.baseOid !== null
        : row.workspaceId === null && row.worker === null && row.baseOid === null,
    {
      message:
        "(driver = 'internal') = (workspace_id IS NOT NULL AND worker IS NOT NULL AND base_oid IS NOT NULL)",
    },
  );
```

The message is the SQL expression EPIC 018 repeats as a table `CHECK`. Copy it exactly.

### `src/domain/run.test.ts`

- Add `driver: "internal" as const,` to `validObjectiveRun` at `src/domain/run.test.ts:10-24` and to `validTaskRun` at `:26-40`, immediately after the `kind` key in each.
- Add a third fixture inside the `describe`, after `validTaskRun`:

```ts
const validExternalRun = {
  ...validObjectiveRun,
  driver: "external" as const,
  workspaceId: null,
  worker: null,
  baseOid: null,
};
```

- Add `it("runDrivers pins the two drivers in order", ...)`: `assert.deepEqual([...runDrivers], ["internal", "external"])`, `assert.equal(runDrivers.length, 2)`.
- Add `it("accepts an external run that holds no workspace, worker or base", ...)`: `assert.equal(runRow.safeParse(validExternalRun).success, true)`.
- Add `it("refuses an external run that carries a daemon-worker fact", ...)`. Assert `success === false` for each of three inputs, one per field: `{ ...validExternalRun, workspaceId: "workspace_" + ULID_A }`, `{ ...validExternalRun, worker: "general@1" }`, `{ ...validExternalRun, baseOid: OID }`.
- Add `it("refuses an internal run that omits a daemon-worker fact", ...)`. Assert `success === false` for each of three inputs, one per field: `{ ...validObjectiveRun, workspaceId: null }`, `{ ...validObjectiveRun, worker: null }`, `{ ...validObjectiveRun, baseOid: null }`.
- Add `it("driver refine: message equals the DDL CHECK expression", ...)`: parse `{ ...validObjectiveRun, workspaceId: null }` and assert `result.error!.issues[0]!.message` equals `"(driver = 'internal') = (workspace_id IS NOT NULL AND worker IS NOT NULL AND base_oid IS NOT NULL)"`.
- Add `it("refuses an unknown driver", ...)`: `runRow.safeParse({ ...validObjectiveRun, driver: "hybrid" })` fails.
- Import `runDrivers` beside `runRow` at `src/domain/run.test.ts:4`.

## Constraints

- Chain the driver refine **after** the `parentRunId` refine. `src/domain/run.test.ts:124-134` asserts `issues[0].message` is the `parentRunId` message for an input whose driver combination is valid; a refine placed first would still leave that test green, but the order is pinned so the two message tests never depend on each other.
- Do not change the existing `parentRunId` refine or its message.
- Do not touch the missing-required-key loop at `src/domain/run.test.ts:50-60`. `.nullable()` in zod 4 rejects a missing key, so the loop stays green and now also covers `driver`.
- `headOid`, `outcome` and `endedAt` stay nullable and unchanged.
- `runRow` is referenced only from `src/domain/rows.ts:39`. Change no command, no query and no service.
- Write no SQL and no migration. EPIC 018 owns the `driver TEXT NOT NULL CHECK (driver IN ('internal', 'external'))` column, the three nullable columns and the table `CHECK`.

## Verify

- `node --test src/domain/run.test.ts src/domain/rows.test.ts` exits 0.
- `runRow` refuses an `external` run that carries a `workspaceId`, a `worker` or a `baseOid`, asserted per field.
- `runRow` refuses an `internal` run that omits any of the three, asserted per field.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `runRow` bullet at `.agent/plan/epics/014-external-drive-contract.md:96`.
