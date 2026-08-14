# Story 7 — `services/lease` gains its complete interface and its SQLite implementation

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 3 (the `owner_kind` column) and Story 5 (`liveLeaseRefusal`).

## Change

### `src/services/lease/index.ts`

The current file is 52 lines. Amend it in place.

- `LeaseRecord` at `:5-13` gains `ownerKind: LeaseOwnerKind | null`, declared after `owner`. `LeaseOwnerKind` is imported from `src/domain/lease-hierarchy.ts`; a service interface may import `domain/`.
- `AcquireLeaseInput` at `:15-20` gains `ownerKind: LeaseOwnerKind` and `now: number`. It keeps `subjectKind`, `subjectId`, `owner` and `ttlMs`.
- `RenewLeaseInput` at `:22-28` gains `ownerKind: LeaseOwnerKind` and `now: number`.
- `ReleaseLeaseInput` at `:30-34` gains `owner: string`, `ownerKind: LeaseOwnerKind` and `now: number`. **Without `owner` the "release matches owner and fence" promise is unimplementable.**
- New `AcquireLeaseResult`:

  ```ts
  export type AcquireLeaseResult = Readonly<{
    record: LeaseRecord;
    acquired: boolean;
  }>;
  ```

  `acquired` is `true` on a new acquisition and `false` on a same-owner reuse, so a caller distinguishes the two without reading the fence.

- New `ExpireLeasesOfOwnerInput`: `Readonly<{ owner: string; now: number }>`.
- New `LeaseSubject`: `Readonly<{ subjectKind: LeaseSubjectKind; subjectId: string }>`.
- New `ReadLeaseInput` and `AssertHeldInput`. `ReadLeaseInput` is `Readonly<{ subjectKind; subjectId }>`. `AssertHeldInput` is `Readonly<{ subjectKind; subjectId; owner; fence }>`.

The `Lease` interface at `:47-52` becomes exactly these seven methods, in this order:

```ts
export interface Lease {
  acquire(
    transaction: Transaction,
    input: AcquireLeaseInput,
  ): AcquireLeaseResult;
  renew(transaction: Transaction, input: RenewLeaseInput): LeaseRecord;
  release(transaction: Transaction, input: ReleaseLeaseInput): void;
  expired(transaction: Transaction, now: number): readonly LeaseRecord[];
  expireLeasesOfOwner(
    transaction: Transaction,
    input: ExpireLeasesOfOwnerInput,
  ): readonly LeaseSubject[];
  read(transaction: Transaction, input: ReadLeaseInput): LeaseRecord | null;
  assertHeld(transaction: Transaction, input: AssertHeldInput): void;
}
```

Add no eighth method. `LeaseErrorCode` at `:36` keeps its three members: `not-implemented`, `lease-held` and `lease-fenced`.

**`now` is passed, never read from a clock inside the lease service.** Every input carries `now: number`. `SqliteLease` takes no `Clock` dependency. The command reads `clock.now()` once per transaction and passes the same value everywhere, so one claim writes one instant.

### `src/services/lease/not-implemented.ts`

Widen the four existing method signatures to the new shapes and add the three new methods, each throwing `LeaseError("not-implemented", ...)` with the same message. The class stays in the repository because `src/domain/layout.test.ts:144` asserts `lease/not-implemented.ts` exists.

### `src/services/lease/sqlite.ts`

New file exporting `class SqliteLease implements Lease`. It takes no constructor dependency: every statement runs in the caller's `Transaction`. `BEGIN IMMEDIATE` at `src/services/storage/connection.ts:35` serializes writers, so the hierarchy read and the acquisition write of one `acquire` cannot interleave with another writer's.

`Transaction.run` at `src/services/storage/index.ts:2` returns `void`, so a zero-row conditional `UPDATE` is invisible to it. **Every conditional write runs through `transaction.all` with a `RETURNING` clause, and an empty result is the refusal.** Add no method to `Transaction`, and do not use `SELECT changes()`.

The shared returning list, used by every statement below, is:

```sql
RETURNING subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
```

#### `acquire`

Three statements, in this exact order.

**1. The hierarchy read.** One `SELECT` over `lease` joined to `node`, collecting every live lease on the subject, on its parent and on its children, ordered by `subject_id`:

```sql
SELECT l.subject_id, l.owner, l.owner_kind, l.expires_at, n.kind, n.parent_id
FROM lease l
JOIN node n ON n.id = l.subject_id
WHERE l.subject_kind = 'node'
  AND l.owner IS NOT NULL
  AND l.expires_at IS NOT NULL
  AND l.expires_at > ?
  AND (
    l.subject_id = ?
    OR l.subject_id = (SELECT parent_id FROM node WHERE id = ?)
    OR n.parent_id = ?
    OR n.parent_id = (SELECT parent_id FROM node WHERE id = ?)
  )
ORDER BY l.subject_id
```

The parameters are `input.now` and then `input.subjectId` four times. The last disjunct collects the siblings. Build `LeaseHierarchyInput` from the rows: `targetId` and `targetKind` from the subject node, `parentId` from it, `childIds` from the rows whose `parent_id` equals the subject, `siblingIds` from the rows whose `parent_id` equals the subject's parent and whose `subject_id` differs from the subject. Call `liveLeaseRefusal`. A non-null refusal raises `LeaseError("lease-held", ...)`, and the refusal object travels on the error as a `refusal` property so the command can build `leaseHeldDetails`.

`liveLeaseRefusal` decides no liveness, so the `expires_at > ?` predicate above is what makes every supplied row live.

**2. The idempotent reuse branch.** When the subject row exists, is live, and its `owner` equals `input.owner`:

```sql
UPDATE lease SET renewed_at = ?, expires_at = ?
WHERE subject_kind = 'node' AND subject_id = ? AND owner = ? AND fence = ?
```

plus the returning list. Parameters: `input.now`, `input.now + input.ttlMs`, `input.subjectId`, `input.owner`, the fence read in step 1. **It moves no fence** and it returns `{ record, acquired: false }`.

**3. The upsert, which is the authoritative guard.**

```sql
INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at)
VALUES ('node', ?, ?, ?, 1, ?, ?, ?)
ON CONFLICT (subject_kind, subject_id) DO UPDATE SET
  owner = excluded.owner,
  owner_kind = excluded.owner_kind,
  fence = lease.fence + 1,
  acquired_at = excluded.acquired_at,
  renewed_at = excluded.renewed_at,
  expires_at = excluded.expires_at
WHERE lease.owner IS NULL OR lease.expires_at <= ?
```

plus the returning list. Parameters: `input.subjectId`, `input.owner`, `input.ownerKind`, `input.now`, `input.now`, `input.now + input.ttlMs`, `input.now`. **The insert is what makes a first claim work**: the `lease` table is not prepopulated, so a conditional `UPDATE` alone changes zero rows for ever. A first acquisition over an absent row writes fence `1`. An acquisition over a free lease and an acquisition over an expired lease each write `fence + 1`. An empty `RETURNING` result raises `LeaseError("lease-held", ...)`.

Return `{ record, acquired: true }`.

#### `renew`

```sql
UPDATE lease SET renewed_at = ?, expires_at = ?
WHERE subject_kind = ? AND subject_id = ? AND owner = ? AND fence = ?
```

plus the returning list. It moves no fence. An empty result raises `LeaseError("lease-fenced", ...)`. It does **not** check expiry: a heartbeat that arrives after expiry but before any sweep still names the live owner and fence, and the sweep is the one place expiry is decided.

#### `release`

```sql
UPDATE lease SET owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL
WHERE subject_kind = ? AND subject_id = ? AND owner = ? AND fence = ?
```

plus the returning list. It moves no fence. `owner` and `owner_kind` are cleared together, which the null-agreement `CHECK` of migration 0007 requires. An empty result raises `LeaseError("lease-fenced", ...)`.

**This is a stated amendment to the EPIC.** `.agent/plan/epics/018-claim-and-lease.md:81` enumerates four cleared columns for `release` and leaves `acquired_at` set, while the expiry sweep at `:108` clears five and includes `acquired_at`. Two paths that both free a lease must leave the same row shape, or a reader cannot tell a released lease from an expired one, and a test that asserts a freed row has to branch on which path freed it. **`release` therefore clears the same five columns as the sweep.** `acquired_at` is the start of the current holding, a released lease has no holding, and the column carries no `CHECK`, so clearing it loses nothing. `fence` is the only column that survives either path, and it survives both.

#### `expired`

```sql
SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
FROM lease
WHERE subject_kind = 'node' AND expires_at IS NOT NULL AND expires_at <= ?
ORDER BY subject_id
```

Node leases only, ordered by `subject_id`.

#### `expireLeasesOfOwner`

```sql
UPDATE lease SET expires_at = ?
WHERE owner = ? AND expires_at > ?
RETURNING subject_kind, subject_id
```

Parameters: `input.now`, `input.owner`, `input.now`. It moves no fence, clears no owner and clears no owner kind. It returns the affected subjects **sorted by `subject_id` under `Buffer.compare`** in the implementation, because `RETURNING` gives no order guarantee. It is the mechanism of Story 13.

#### `read`

One `SELECT` by primary key, returning one `LeaseRecord` or `null`.

#### `assertHeld`

Read the row and raise `LeaseError("lease-fenced", ...)` when it is absent, when its `owner` differs from `input.owner`, or when its `fence` differs from `input.fence`. It writes nothing. It ships for EPIC 110.

### Row mapping

One private mapper turns the SQL row into `LeaseRecord`, converting `owner_kind` to `ownerKind`. Every numeric column is read as a number and every nullable column as `T | null`.

## Constraints

- `SqliteLease` opens no transaction. Every method takes the caller's.
- `SqliteLease` reads no clock and imports no `Clock`.
- The fence moves in exactly one statement, the step-3 upsert. `renew`, `release`, the reuse branch and `expireLeasesOfOwner` all leave it alone.
- `acquire` supports `subjectKind: "node"` only in this epic. A `repository` subject throws a plain `Error` naming the unsupported subject kind. It is a programming fault and not a contention outcome, so it is not a `LeaseError`.
- Add no `Lease` method beyond the seven above.
- Do not import another capability's implementation. `src/domain/layout.test.ts:220` fails on it.
- Do not delete `src/services/lease/not-implemented.ts` or its test.

## Verify

New test file `src/services/lease/sqlite.test.ts`, on real SQLite through `createMigratedStorage` of `test/helpers/database.ts`. Seed one project, one initiative, one objective and two sibling tasks through direct `INSERT` into `node`, so the suite depends on no command. Fixed identities and a fixed `now` of `1700000000000`; `ttlMs` of `300000`.

- `a first acquire against an empty lease table inserts the row with fence 1` — read `lease` before the call and assert it holds no row for the subject, then assert `acquired: true`, `fence: 1`, `owner`, `ownerKind`, `acquiredAt`, `renewedAt` equal to `now`, and `expiresAt` equal to `now + ttlMs`.
- `a same-owner acquire of a live lease returns acquired false and moves no fence` — assert the fence is identical, `renewedAt` and `expiresAt` moved to the later `now`, and `acquiredAt` unchanged.
- `an acquire over a free lease writes fence + 1` — acquire, release, acquire again as another owner, assert fence `2`.
- `an acquire over an expired lease writes fence + 1` — acquire at `now`, acquire at `now + ttlMs` as another owner, assert fence `2` and the new owner.
- `an acquire of a task held by another owner raises lease-held` — assert the code and assert the `refusal` property carries `relation: "self"`.
- `an acquire of a task whose parent objective another owner holds raises lease-held with relation ancestor`.
- `an acquire of a task whose sibling another owner holds raises lease-held with relation sibling`.
- `an acquire of an objective one of whose tasks another owner holds raises lease-held with relation descendant`.
- `an acquire of a task the same owner already holds at the objective succeeds` — the actor holds the objective lease, then acquires the task; assert `acquired: true`, the task fence is `1`, and the objective fence did not move.
- `renew with the current fence extends the expiry and moves no fence`.
- `renew with any other fence raises lease-fenced and writes nothing` — assert the row is deep-equal before and after.
- `renew with the wrong owner raises lease-fenced and writes nothing`.
- `release clears owner, owner kind, acquired_at, renewed_at and expires_at, and keeps the fence` — assert all six columns by name.
- `a released row holds a null in every column but the fence` — assert the row deep-equals `{ subjectKind: "node", subjectId, owner: null, ownerKind: null, fence: <the pre-release fence>, acquiredAt: null, renewedAt: null, expiresAt: null }`. Story 9 asserts the swept row against the same literal shape, which is what the amendment above exists for.
- `release with the right fence and the wrong owner raises lease-fenced and writes nothing`.
- `release with the right owner and the wrong fence raises lease-fenced and writes nothing`.
- `expired returns every node lease at or before now, ordered by subject id` — three leases with distinct expiries, one in the future; assert the two returned in bytewise identity order.
- `expireLeasesOfOwner sets expires_at to now and keeps owner, owner kind and fence` — the actor holds an objective lease and a task lease; assert both rows and assert the returned subject list is the two subjects in bytewise identity order.
- `expireLeasesOfOwner touches no lease of another owner` — assert the other owner's row is deep-equal before and after.
- `expireLeasesOfOwner over an owner with no live lease returns an empty list and writes nothing`.
- `read returns the record or null`.
- `assertHeld passes for the live owner and fence, and raises lease-fenced for an absent row, a wrong owner and a wrong fence` — four cases in one `it`.
- `every input carries now and the service reads no clock` — assert by source read that `src/services/lease/sqlite.ts` includes none of `Date.now(`, `new Date(` and no import from `../clock/`.
- `an acquire on a repository subject throws` — assert a plain `Error`, not a `LeaseError`.

Run:

- `node --test src/services/lease/sqlite.test.ts src/services/lease/not-implemented.test.ts` exits 0.
- `npm run typecheck` exits 0. Every `Lease` consumer compiles against the widened inputs.
- Proof: `PASS EPIC-018`, through `src/services/lease/sqlite.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:183`, `:185`.
