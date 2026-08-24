# Story 7 — Attempt driver

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: Story 6. This file imports `runDrivers` from `./run.ts`.

## Change

### `src/domain/attempt.ts`

Make four edits to `attemptRow` at `src/domain/attempt.ts:16-27`.

1. Add `import { runDrivers } from "./run.ts";` after the existing `./column.ts` import. Do not redeclare the enum here; the attempt carries the same closed set as the run.
2. Add one field immediately after `attemptNo` and before `providerId`: `driver: z.enum(runDrivers),`.
3. Make four fields nullable: `providerId: identity("provider").nullable()`, `providerModel: z.string().nullable()`, `timeoutMs: z.int().nullable()`, `baseOid: objectId.nullable()`.
4. Add one `.refine` to the object. `attemptRow` holds no refine today, so this is its first:

```ts
}).refine(
  (row) =>
    row.driver === "internal"
      ? row.providerId !== null &&
        row.providerModel !== null &&
        row.timeoutMs !== null &&
        row.baseOid !== null
      : row.providerId === null &&
        row.providerModel === null &&
        row.timeoutMs === null &&
        row.baseOid === null,
  {
    message:
      "(driver = 'internal') = (provider_id IS NOT NULL AND provider_model IS NOT NULL AND timeout_ms IS NOT NULL AND base_oid IS NOT NULL)",
  },
);
```

The message is the SQL expression EPIC 018 repeats as a table `CHECK`. Copy it exactly.

The attempt carries its own `driver` rather than reading the run, because a row schema validates one row and cannot reach a second one.

### `src/domain/attempt.test.ts`

- Add `driver: "internal" as const,` to `validRow` at `src/domain/attempt.test.ts:10-21`, immediately after `attemptNo`.
- Add a second fixture inside the `describe`, after `validRow`:

```ts
const validExternalRow = {
  ...validRow,
  driver: "external" as const,
  providerId: null,
  providerModel: null,
  timeoutMs: null,
  baseOid: null,
};
```

- Add `it("accepts an external attempt that holds no provider fact", ...)`: `assert.equal(attemptRow.safeParse(validExternalRow).success, true)`.
- Add `it("refuses an external attempt that carries a provider fact", ...)`. Assert `success === false` for each of four inputs, one per field: `{ ...validExternalRow, providerId: "provider_" + ULID_A }`, `{ ...validExternalRow, providerModel: "gpt-4" }`, `{ ...validExternalRow, timeoutMs: 30000 }`, `{ ...validExternalRow, baseOid: OID }`.
- Add `it("refuses an internal attempt that omits a provider fact", ...)`. Assert `success === false` for each of four inputs, one per field: `{ ...validRow, providerId: null }`, `{ ...validRow, providerModel: null }`, `{ ...validRow, timeoutMs: null }`, `{ ...validRow, baseOid: null }`.
- Add `it("driver refine: message equals the DDL CHECK expression", ...)`: parse `{ ...validRow, providerId: null }` and assert `result.error!.issues[0]!.message` equals the exact message string above.
- Add `it("refuses an unknown driver", ...)`: `{ ...validRow, driver: "hybrid" }` fails.

## Constraints

- Import `runDrivers` from `./run.ts`. Do not declare a second driver enum. A domain file may import a domain file.
- Do not touch the missing-required-key loop at `src/domain/attempt.test.ts:27-37`. `.nullable()` rejects a missing key, so the loop stays green and now also covers `driver`.
- `headOid`, `outcome` and `endedAt` stay nullable and unchanged.
- The `attemptOutcomes` tuple, `attemptOutcome` and the tests at `src/domain/attempt.test.ts:63` and `:73` are unchanged.
- `attemptRow` is referenced only from `src/domain/rows.ts:23`. Change no command, no query and no service.
- Write no SQL and no migration. EPIC 018 owns the `driver` column with its `CHECK`, the four nullable columns and the table `CHECK`.

## Verify

- `node --test src/domain/attempt.test.ts src/domain/rows.test.ts` exits 0.
- `attemptRow` refuses an `external` attempt that carries a `providerId`, a `providerModel`, a `timeoutMs` or a `baseOid`, asserted per field.
- `attemptRow` refuses an `internal` attempt that omits any of the four, asserted per field.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `attemptRow` bullet at `.agents/plan/epics/014-external-drive-contract.md:97`.
