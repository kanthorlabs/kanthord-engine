# Story 8 — Lease owner kind

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: EPIC 013 (sequence order). Independent of Stories 6 and 7.

## Change

### `src/domain/lease.ts`

The file today is:

```ts
export const leaseSubjectKinds = ["node", "repository"] as const;

export const leaseRow = z.object({
  subjectKind: z.enum(leaseSubjectKinds),
  subjectId: anyIdentity,
  owner: z.string().nullable(),
  fence: z.int(),
  acquiredAt: epochMillis.nullable(),
  renewedAt: epochMillis.nullable(),
  expiresAt: epochMillis.nullable(),
});
```

Make three edits.

1. Add the enum immediately after `leaseSubjectKinds`, in the shape `src/domain/event.ts:6-7` uses:

```ts
export const leaseOwnerKinds = ["daemon", "actor"] as const;
export type LeaseOwnerKind = (typeof leaseOwnerKinds)[number];
```

`daemon` is the phase-1 meaning `docs/proposal/database/lease.md` already describes. `actor` is a registered human or harness of EPIC 015.

2. Add one field immediately after `owner` and before `fence`: `ownerKind: z.enum(leaseOwnerKinds).nullable(),`.
3. Add one `.refine` to the object. `leaseRow` holds no refine today, so this is its first:

```ts
}).refine((row) => (row.owner === null) === (row.ownerKind === null), {
  message: "(owner IS NULL) = (owner_kind IS NULL)",
});
```

The message is the SQL expression EPIC 018 repeats as a table `CHECK`. Copy it exactly.

### `src/domain/lease.test.ts`

- Add `ownerKind: "daemon" as const,` to `validRow` at `src/domain/lease.test.ts:9-17`, immediately after `owner`.
- Add `it("leaseOwnerKinds pins the two owner kinds in order", ...)`: `assert.deepEqual([...leaseOwnerKinds], ["daemon", "actor"])`, `assert.equal(leaseOwnerKinds.length, 2)`.
- Add `it("accepts an unheld lease with both owner fields null", ...)`: `{ ...validRow, owner: null, ownerKind: null }` parses.
- Add `it("accepts an actor-held lease", ...)`: `{ ...validRow, owner: "actor_" + ULID_A, ownerKind: "actor" }` parses.
- Add `it("refuses a lease whose owner and owner kind disagree on null", ...)`. Assert `success === false` for both directions: `{ ...validRow, owner: null }` (owner null, `ownerKind` set) and `{ ...validRow, ownerKind: null }` (owner set, `ownerKind` null).
- Add `it("owner-kind refine: message equals the DDL CHECK expression", ...)`: parse `{ ...validRow, owner: null }` and assert `result.error!.issues[0]!.message` equals `"(owner IS NULL) = (owner_kind IS NULL)"`.
- Add `it("refuses an unknown owner kind", ...)`: `{ ...validRow, ownerKind: "worker" }` fails.
- Import `leaseOwnerKinds` beside `leaseRow` at `src/domain/lease.test.ts:4`.

## Constraints

- Do not touch the missing-required-key loop at `src/domain/lease.test.ts:27-37`. `.nullable()` rejects a missing key, so the loop stays green and now also covers `ownerKind`.
- Read every other existing test in `src/domain/lease.test.ts` (`it` at `:19`, `:23`, `:39`, `:46`, `:57`) before editing. A test that sets `owner: null` on a spread of `validRow` now needs `ownerKind: null` beside it, and that is the only reason to touch it.
- `leaseSubjectKinds`, `subjectKind`, `subjectId`, `fence`, `acquiredAt`, `renewedAt` and `expiresAt` are unchanged.
- `leaseRow` is referenced only from `src/domain/rows.ts:30`. Change no command, no query and no service.
- Write no SQL and no migration. EPIC 018 owns the `owner_kind` column with its `CHECK` and the table `CHECK`.

## Verify

- `node --test src/domain/lease.test.ts src/domain/rows.test.ts` exits 0.
- `leaseRow` refuses a row where `owner` is null and `ownerKind` is set, and refuses the reverse.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `leaseRow` bullet at `.agents/plan/epics/014-external-drive-contract.md:99`.
