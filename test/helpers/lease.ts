import type { LeaseOwnerKind } from "../../src/domain/lease.ts";
import {
  liveLeaseRefusal,
  type LeaseHierarchyInput,
  type LiveLease,
} from "../../src/domain/lease-hierarchy.ts";
import type { NodeKind } from "../../src/domain/state.ts";
import type { Transaction } from "../../src/services/storage/index.ts";
import { migrations } from "../../src/services/storage/migrations.ts";
import { SqliteStorage } from "../../src/services/storage/sqlite.ts";
import { SqliteLease } from "../../src/services/lease/sqlite.ts";
import { createMockClock } from "./clock.ts";
import {
  LeaseError,
  type AcquireLeaseInput,
  type AcquireLeaseResult,
  type AssertHeldInput,
  type ExpireLeasesOfOwnerInput,
  type Lease,
  type LeaseRecord,
  type LeaseSubject,
  type LeaseSubjectKind,
  type ReadLeaseInput,
  type ReleaseLeaseInput,
  type RenewLeaseInput,
} from "../../src/services/lease/index.ts";

export type LeaseFake = Readonly<{
  lease: Lease;
  calls: readonly string[];
}>;

export function createLeaseFake(): LeaseFake {
  const calls: string[] = [];
  const unexpected = (name: string): never => {
    calls.push(name);
    throw new Error(`unexpected lease call: ${name}`);
  };
  const lease: Lease = {
    acquire(): never {
      return unexpected("acquire");
    },
    renew(): never {
      return unexpected("renew");
    },
    release(): never {
      return unexpected("release");
    },
    expired(): never {
      return unexpected("expired");
    },
    expireLeasesOfOwner(): never {
      return unexpected("expireLeasesOfOwner");
    },
    read(): never {
      return unexpected("read");
    },
    assertHeld(): never {
      return unexpected("assertHeld");
    },
  };
  return { lease, calls };
}

const RETURNING =
  "RETURNING subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at";

type LeaseRow = Readonly<{
  subject_kind: LeaseSubjectKind;
  subject_id: string;
  owner: string | null;
  owner_kind: LeaseOwnerKind | null;
  fence: number;
  acquired_at: number | null;
  renewed_at: number | null;
  expires_at: number | null;
}>;

type NodeRelativeRow = Readonly<{
  id: string;
  kind: NodeKind;
  parent_id: string | null;
}>;

type LiveLeaseRow = Readonly<{
  subject_id: string;
  owner: string;
  owner_kind: LeaseOwnerKind;
  fence: number;
  expires_at: number;
}>;

function toLeaseRecord(row: LeaseRow): LeaseRecord {
  return {
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    owner: row.owner,
    ownerKind: row.owner_kind,
    fence: row.fence,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
  };
}

export type BackedLeaseFake = Readonly<{
  lease: Lease;
  calls: readonly Readonly<{ name: string; input: unknown }>[];
}>;

// A hand-written Lease implementation backed by the real SQLite rows, for
// command tests that must assert real lease rows without reaching the service
// implementation. Mirrors the statements of src/services/lease/sqlite.ts.
export function createBackedLeaseFake(): BackedLeaseFake {
  const calls: Readonly<{ name: string; input: unknown }>[] = [];
  const record = <T>(name: string, input: unknown, work: () => T): T => {
    calls.push({ name, input });
    return work();
  };

  const read = (
    transaction: Transaction,
    input: ReadLeaseInput,
  ): LeaseRecord | null => {
    const row = transaction.get(
      `SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
FROM lease
WHERE subject_kind = ? AND subject_id = ?`,
      [input.subjectKind, input.subjectId],
    ) as LeaseRow | undefined;
    return row === undefined ? null : toLeaseRecord(row);
  };

  const lease: Lease = {
    acquire(
      transaction: Transaction,
      input: AcquireLeaseInput,
    ): AcquireLeaseResult {
      return record("acquire", input, () => {
        if (input.subjectKind !== "node") {
          throw new Error(
            `the lease service supports node subjects only, not ${input.subjectKind}`,
          );
        }
        const relatives = transaction.all(
          `SELECT n.id, n.kind, n.parent_id
FROM node n
WHERE n.id = ?
   OR n.id = (SELECT parent_id FROM node WHERE id = ?)
   OR n.parent_id = ?
   OR (n.parent_id IS NOT NULL
       AND n.parent_id = (SELECT parent_id FROM node WHERE id = ?))
ORDER BY n.id`,
          [input.subjectId, input.subjectId, input.subjectId, input.subjectId],
        ) as readonly NodeRelativeRow[];
        const target = relatives.find((row) => row.id === input.subjectId);
        if (target === undefined) {
          throw new Error(`unknown node ${input.subjectId}`);
        }
        const identities = relatives.map((row) => row.id);
        const placeholders = identities.map(() => "?").join(", ");
        const leaseRows = transaction.all(
          `SELECT subject_id, owner, owner_kind, fence, expires_at
FROM lease
WHERE subject_kind = 'node'
  AND owner IS NOT NULL
  AND expires_at IS NOT NULL
  AND expires_at > ?
  AND subject_id IN (${placeholders})
ORDER BY subject_id`,
          [input.now, ...identities],
        ) as readonly LiveLeaseRow[];
        const liveLeases: readonly LiveLease[] = leaseRows.map((row) => ({
          subjectId: row.subject_id,
          owner: row.owner,
          ownerKind: row.owner_kind,
          fence: row.fence,
          expiresAt: row.expires_at,
        }));
        const hierarchy: LeaseHierarchyInput = {
          targetId: target.id,
          targetKind: target.kind,
          parentId: target.parent_id,
          childIds: relatives
            .filter((row) => row.parent_id === target.id)
            .map((row) => row.id),
          siblingIds: relatives
            .filter(
              (row) =>
                row.parent_id !== null &&
                row.parent_id === target.parent_id &&
                row.id !== target.id,
            )
            .map((row) => row.id),
          owner: input.owner,
          liveLeases,
        };
        const refusal = liveLeaseRefusal(hierarchy);
        if (refusal !== null) {
          throw new LeaseError(
            "lease-held",
            "the lease is held by another owner",
            refusal,
          );
        }
        const liveSelf = liveLeases.find(
          (candidate) => candidate.subjectId === target.id,
        );
        if (liveSelf !== undefined) {
          const rows = transaction.all(
            `UPDATE lease SET renewed_at = ?, expires_at = ?
WHERE subject_kind = 'node' AND subject_id = ? AND owner = ? AND fence = ?
${RETURNING}`,
            [
              input.now,
              input.now + input.ttlMs,
              input.subjectId,
              input.owner,
              liveSelf.fence,
            ],
          ) as readonly LeaseRow[];
          const row = rows[0];
          if (row === undefined) {
            throw new LeaseError(
              "lease-held",
              "the lease is held by another owner",
            );
          }
          return { record: toLeaseRecord(row), acquired: false };
        }
        const rows = transaction.all(
          `INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at)
VALUES ('node', ?, ?, ?, 1, ?, ?, ?)
ON CONFLICT (subject_kind, subject_id) DO UPDATE SET
  owner = excluded.owner,
  owner_kind = excluded.owner_kind,
  fence = lease.fence + 1,
  acquired_at = excluded.acquired_at,
  renewed_at = excluded.renewed_at,
  expires_at = excluded.expires_at
WHERE lease.owner IS NULL OR lease.expires_at <= ?
${RETURNING}`,
          [
            input.subjectId,
            input.owner,
            input.ownerKind,
            input.now,
            input.now,
            input.now + input.ttlMs,
            input.now,
          ],
        ) as readonly LeaseRow[];
        const row = rows[0];
        if (row === undefined) {
          throw new LeaseError(
            "lease-held",
            "the lease is held by another owner",
          );
        }
        return { record: toLeaseRecord(row), acquired: true };
      });
    },
    renew(transaction: Transaction, input: RenewLeaseInput): LeaseRecord {
      return record("renew", input, () => {
        const rows = transaction.all(
          `UPDATE lease SET renewed_at = ?, expires_at = ?
WHERE subject_kind = ? AND subject_id = ? AND owner = ? AND fence = ? AND expires_at > ?
${RETURNING}`,
          [
            input.now,
            input.now + input.ttlMs,
            input.subjectKind,
            input.subjectId,
            input.owner,
            input.fence,
            input.now,
          ],
        ) as readonly LeaseRow[];
        const row = rows[0];
        if (row === undefined) {
          throw new LeaseError(
            "lease-fenced",
            `the lease of ${input.subjectId} is not held by ${input.owner} at fence ${input.fence}`,
          );
        }
        return toLeaseRecord(row);
      });
    },
    release(transaction: Transaction, input: ReleaseLeaseInput): void {
      record("release", input, () => {
        const rows = transaction.all(
          `UPDATE lease SET owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL
WHERE subject_kind = ? AND subject_id = ? AND owner = ? AND fence = ? AND expires_at > ?
${RETURNING}`,
          [
            input.subjectKind,
            input.subjectId,
            input.owner,
            input.fence,
            input.now,
          ],
        ) as readonly LeaseRow[];
        if (rows.length === 0) {
          throw new LeaseError(
            "lease-fenced",
            `the lease of ${input.subjectId} is not held by ${input.owner} at fence ${input.fence}`,
          );
        }
      });
    },
    expired(transaction: Transaction, now: number): readonly LeaseRecord[] {
      return record("expired", { now }, () => {
        const rows = transaction.all(
          `SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
FROM lease
WHERE subject_kind = 'node' AND expires_at IS NOT NULL AND expires_at <= ?
ORDER BY subject_id`,
          [now],
        ) as readonly LeaseRow[];
        return rows.map(toLeaseRecord);
      });
    },
    expireLeasesOfOwner(
      transaction: Transaction,
      input: ExpireLeasesOfOwnerInput,
    ): readonly LeaseSubject[] {
      return record("expireLeasesOfOwner", input, () => {
        const rows = transaction.all(
          `UPDATE lease SET expires_at = ?
WHERE owner = ? AND expires_at > ?
RETURNING subject_kind, subject_id`,
          [input.now, input.owner, input.now],
        ) as readonly Readonly<{
          subject_kind: LeaseSubjectKind;
          subject_id: string;
        }>[];
        const subjects = rows.map((row) => ({
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
        }));
        subjects.sort((a, b) =>
          Buffer.compare(
            Buffer.from(a.subjectId, "utf8"),
            Buffer.from(b.subjectId, "utf8"),
          ),
        );
        return subjects;
      });
    },
    read(transaction: Transaction, input: ReadLeaseInput): LeaseRecord | null {
      return record("read", input, () => read(transaction, input));
    },
    assertHeld(transaction: Transaction, input: AssertHeldInput): void {
      record("assertHeld", input, () => {
        const recordRow = read(transaction, input);
        if (
          recordRow === null ||
          recordRow.owner !== input.owner ||
          recordRow.fence !== input.fence ||
          recordRow.expiresAt === null ||
          recordRow.expiresAt <= input.now
        ) {
          throw new LeaseError(
            "lease-fenced",
            `the lease of ${input.subjectId} is not held by ${input.owner} at fence ${input.fence}`,
          );
        }
      });
    },
  };
  return { lease, calls };
}

export type ForeignLeaseAcquisitionInput = Readonly<{
  databasePath: string;
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  ownerKind: LeaseOwnerKind;
  ttlMs: number;
  now: number;
}>;

export function acquireLeaseOnDatabaseFile(
  input: ForeignLeaseAcquisitionInput,
): AcquireLeaseResult {
  const storage = new SqliteStorage({
    path: input.databasePath,
    clock: createMockClock({ start: input.now }),
    migrations,
  });
  try {
    const lease = new SqliteLease();
    return storage.transact((transaction) =>
      lease.acquire(transaction, {
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        owner: input.owner,
        ownerKind: input.ownerKind,
        ttlMs: input.ttlMs,
        now: input.now,
      }),
    );
  } finally {
    storage.close();
  }
}
