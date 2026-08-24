# Story 7 — `services/lease` gains its complete interface and its SQLite implementation

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: Story 3 (the `owner_kind` column) and Story 5 (`liveLeaseRefusal`).

## Change

### `src/services/lease/index.ts`

The current file is 52 lines. Amend it in place.

- `LeaseRecord` at `:5-13` gains `ownerKind: LeaseOwnerKind | null`, declared after `owner`. **`LeaseOwnerKind` is imported from `src/domain/lease.ts`**, which is the one place Story 5 fixes it, beside the `ownerKind` member EPIC 014 adds to `leaseRow`. Do not import it from `src/domain/lease-hierarchy.ts`, and do not declare a second copy here. A service interface may import `domain/`.
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
- New `ReadLeaseInput` is `Readonly<{ subjectKind: LeaseSubjectKind; subjectId: string; now: number }>`, and `AssertHeldInput` is `Readonly<{ subjectKind: LeaseSubjectKind; subjectId: string; owner: string; fence: number; now: number }>`. **Both carry `now`**, so every input of `Lease` carries it, which is the Decision at `.agents/plan/epics/018-claim-and-lease.md:41` and the surface Story 18 publishes. `read` uses `now` to report liveness; `assertHeld` uses it to refuse an expired holding. Neither carries `ownerKind`: `read` supplies it in the record it returns, and `assertHeld` matches on `owner` and `fence`, which are what the fencing rule compares. Story 18's published surface says "every input carrying `now` and `ownerKind`"; correct that sentence to "every input carries `now`, and every input that **writes** an owner carries `ownerKind`" — those are `acquire`, `renew` and `release`.

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

**1. The hierarchy read. It is rooted in `node`, not in `lease`.** The guaranteed first-acquisition case has an **empty** `lease` table, so a query rooted in `lease` returns no row and yields no `targetKind` and no `parentId` — and `liveLeaseRefusal` requires both. Root the query in the target node and **left-join** the lease.

Two statements, in this order.

**1a. The target node and its relatives.**

```sql
SELECT n.id, n.kind, n.parent_id
FROM node n
WHERE n.id = ?
   OR n.id = (SELECT parent_id FROM node WHERE id = ?)
   OR n.parent_id = ?
   OR (n.parent_id IS NOT NULL
       AND n.parent_id = (SELECT parent_id FROM node WHERE id = ?))
ORDER BY n.id
```

Parameters: `input.subjectId` four times. An **absent target row** means the caller named an unknown node: throw a plain `Error`, because `claimNode` resolves the node before it calls `acquire` and an unknown node here is a programming fault.

The `n.parent_id IS NOT NULL` guard on the fourth disjunct is load-bearing. Without it, a target whose `parent_id` is `NULL` — an initiative — makes the subquery `NULL`, and `NULL = NULL` is `NULL` rather than true, so the disjunct is merely never satisfied. The guard states the intent instead of relying on that: **a node with no parent has no siblings by this rule.** The three-valued logic does not accidentally match unrelated null-parent nodes in either form.

**1b. The live leases over those identities.**

```sql
SELECT subject_id, owner, owner_kind, fence, expires_at
FROM lease
WHERE subject_kind = 'node'
  AND owner IS NOT NULL
  AND expires_at IS NOT NULL
  AND expires_at > ?
  AND subject_id IN (<one placeholder per identity from 1a>)
ORDER BY subject_id
```

Parameters: `input.now`, then the identities returned by 1a in their returned order. Build the placeholder list from that count; supply no literal.

Build `LeaseHierarchyInput` from the two results: `targetId` and `targetKind` and `parentId` from the target row of 1a; `childIds` from the 1a rows whose `parent_id` equals the subject; `siblingIds` from the 1a rows whose `parent_id` equals the subject's parent and whose `id` differs from the subject; `liveLeases` from 1b, each carrying `fence`. Call `liveLeaseRefusal`. A non-null refusal raises `LeaseError("lease-held", ...)`, and the refusal object travels on the error as a `refusal` property so the caller builds `leaseHeldDetails` from it with no second read.

`liveLeaseRefusal` decides no liveness, so the `expires_at > ?` predicate in 1b is what makes every supplied row live.

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
WHERE subject_kind = ? AND subject_id = ? AND owner = ? AND fence = ? AND expires_at > ?
```

plus the returning list. Parameters end with `input.now`. It moves no fence. An empty result raises `LeaseError("lease-fenced", ...)`.

**The `expires_at > ?` predicate is lease safety and it is required.** Without it a heartbeat that arrives after `expires_at`, with no sweep yet run, extends a dead holding and restores the old harness's authority. That contradicts `leaseTtlMs` being the whole bound, contradicts "the current live pair" of the report rule, and defeats abandoned-objective recovery: a harness that stopped reporting could hold its objective for ever by heartbeating late. The claim-driven sweep runs at the next claim, so "expired but not yet swept" is a window of unbounded length, not a moment.

#### `release`

```sql
UPDATE lease SET owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL
WHERE subject_kind = ? AND subject_id = ? AND owner = ? AND fence = ? AND expires_at > ?
```

plus the returning list, with `input.now` as the last parameter. It moves no fence. `owner` and `owner_kind` are cleared together, which the null-agreement `CHECK` of migration 0007 requires. An empty result raises `LeaseError("lease-fenced", ...)`, and an expired holding is one of the cases that produces it: a harness whose lease died has no release to give, and the sweep frees the row.

**This is a stated amendment to the EPIC.** `.agents/plan/epics/018-claim-and-lease.md:81` enumerates four cleared columns for `release` and leaves `acquired_at` set, while the expiry sweep at `:108` clears five and includes `acquired_at`. Two paths that both free a lease must leave the same row shape, or a reader cannot tell a released lease from an expired one, and a test that asserts a freed row has to branch on which path freed it. **`release` therefore clears the same five columns as the sweep.** `acquired_at` is the start of the current holding, a released lease has no holding, and the column carries no `CHECK`, so clearing it loses nothing. `fence` is the only column that survives either path, and it survives both.

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

One `SELECT` by primary key, returning one `LeaseRecord` or `null`. It applies **no** expiry predicate and returns the row as stored, because a caller that needs to see an expired holding — the sweep, and the objective-release check of Story 12 — reads it here. `input.now` is not used in the `WHERE`; the caller compares `expiresAt` against it.

#### `assertHeld`

Read the row and raise `LeaseError("lease-fenced", ...)` when it is absent, when its `owner` differs from `input.owner`, when its `fence` differs from `input.fence`, **or when its `expires_at` is null or at or before `input.now`**. It writes nothing. The expiry arm is the same safety rule as `renew`: an expired holding is not held, so an assertion that ignores expiry would license a write from a dead owner. It ships for EPIC 110 and Story 12 uses it.

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

- `a first acquire against an empty lease table inserts the row with fence 1` — **assert the whole `lease` table is empty before the call**, not merely that the subject has no row, so the hierarchy read is exercised with nothing to join. Then assert `acquired: true`, `fence: 1`, `owner`, `ownerKind`, `acquiredAt`, `renewedAt` equal to `now`, and `expiresAt` equal to `now + ttlMs`. This is the case a `lease`-rooted hierarchy query cannot serve.
- `the hierarchy read resolves the target from node and not from lease` — with an empty `lease` table, acquire the **task**, and assert it succeeds. Then acquire an **initiative** and assert it succeeds with no sibling lookup error, so the null-parent guard is exercised.
- `an acquire of an unknown node throws a plain Error` — assert it is not a `LeaseError`, because `claimNode` resolves the node first and an unknown node here is a programming fault.
- `the refusal carries the holder's fence` — assert the `refusal` property of the raised `LeaseError` carries `subjectId`, `holder`, `holderKind`, `fence`, `relation` and `expiresAt`, so `leaseHeldDetails` needs no second read.
- `a same-owner acquire of a live lease returns acquired false and moves no fence` — assert the fence is identical, `renewedAt` and `expiresAt` moved to the later `now`, and `acquiredAt` unchanged.
- `an acquire over a free lease writes fence + 1` — acquire, release, acquire again as another owner, assert fence `2`.
- `an acquire over an expired lease writes fence + 1` — acquire at `now`, acquire at `now + ttlMs` as another owner, assert fence `2` and the new owner.
- **`an acquire over a pre-existing free row continues that row's fence and never resets to 1`** — `INSERT` a `lease` row directly with a null `owner`, a null `owner_kind`, a null `expires_at` and `fence` of `7`, then acquire it. Assert the fence is **`8`**. Do not accept `1`.

  This is the case the two assertions above cannot catch: both reach a free row that this suite itself created at fence `1`, so an implementation that reset the fence on the insert path would still report `2` and pass them. A reset fence is the exact failure the fence exists to prevent — a stale holder presenting the old owner and fence would match the row again. The `INSERT ... ON CONFLICT` upsert takes its `DO UPDATE` branch here, so `fence = lease.fence + 1` reads `7`; the literal `1` in the `VALUES` clause applies only to a genuinely absent row. Spiked and confirmed against `node:sqlite`.

- `an acquire whose expires_at equals now exactly is admitted` — acquire, then acquire as another owner at `now` equal to the stored `expires_at`. Assert it succeeds with fence `2`, because the guard is `expires_at <= ?`. Pin the boundary, so a later change to `<` is caught.
- `an acquire of a task held by another owner raises lease-held` — assert the code and assert the `refusal` property carries `relation: "self"`.
- `an acquire of a task whose parent objective another owner holds raises lease-held with relation ancestor`.
- `an acquire of a task whose sibling another owner holds raises lease-held with relation sibling`.
- `an acquire of an objective one of whose tasks another owner holds raises lease-held with relation descendant`.
- `an acquire of a task the same owner already holds at the objective succeeds` — the actor holds the objective lease, then acquires the task; assert `acquired: true`, the task fence is `1`, and the objective fence did not move.
- `renew with the current fence extends the expiry and moves no fence`.
- `renew with any other fence raises lease-fenced and writes nothing` — assert the row is deep-equal before and after.
- `renew with the wrong owner raises lease-fenced and writes nothing`.
- **`renew of an expired holding raises lease-fenced and writes nothing`** — acquire at `now`, then `renew` at `now + ttlMs` with the **right** owner and the **right** fence, and assert it raises and the row is deep-equal before and after. Without the expiry predicate this call succeeds and resurrects a dead claim.
- **`release of an expired holding raises lease-fenced and writes nothing`** — the same shape, with the right owner and fence.
- **`assertHeld of an expired holding raises lease-fenced`** — the same shape, and assert `assertHeld` passes for the identical row while it is still live.
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
- Proof: `PASS EPIC-018`, through `src/services/lease/sqlite.test.ts`. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:183`, `:185`.
