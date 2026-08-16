import type { LeaseOwnerKind } from "../../domain/lease.ts";
import {
  liveLeaseRefusal,
  type LeaseHierarchyInput,
  type LiveLease,
} from "../../domain/lease-hierarchy.ts";
import type { NodeKind } from "../../domain/state.ts";
import type { Transaction } from "../storage/index.ts";
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
} from "./index.ts";

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

function toRecord(row: LeaseRow): LeaseRecord {
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

export class SqliteLease implements Lease {
  acquire(
    transaction: Transaction,
    input: AcquireLeaseInput,
  ): AcquireLeaseResult {
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
    const liveSelf = liveLeases.find((lease) => lease.subjectId === target.id);
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
      return { record: toRecord(row), acquired: false };
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
      throw new LeaseError("lease-held", "the lease is held by another owner");
    }
    return { record: toRecord(row), acquired: true };
  }

  renew(transaction: Transaction, input: RenewLeaseInput): LeaseRecord {
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
    return toRecord(row);
  }

  release(transaction: Transaction, input: ReleaseLeaseInput): void {
    const rows = transaction.all(
      `UPDATE lease SET owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL
WHERE subject_kind = ? AND subject_id = ? AND owner = ? AND fence = ? AND expires_at > ?
${RETURNING}`,
      [input.subjectKind, input.subjectId, input.owner, input.fence, input.now],
    ) as readonly LeaseRow[];
    if (rows.length === 0) {
      throw new LeaseError(
        "lease-fenced",
        `the lease of ${input.subjectId} is not held by ${input.owner} at fence ${input.fence}`,
      );
    }
  }

  expired(transaction: Transaction, now: number): readonly LeaseRecord[] {
    const rows = transaction.all(
      `SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
FROM lease
WHERE subject_kind = 'node' AND expires_at IS NOT NULL AND expires_at <= ?
ORDER BY subject_id`,
      [now],
    ) as readonly LeaseRow[];
    return rows.map(toRecord);
  }

  expireLeasesOfOwner(
    transaction: Transaction,
    input: ExpireLeasesOfOwnerInput,
  ): readonly LeaseSubject[] {
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
  }

  read(transaction: Transaction, input: ReadLeaseInput): LeaseRecord | null {
    const row = transaction.get(
      `SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
FROM lease
WHERE subject_kind = ? AND subject_id = ?`,
      [input.subjectKind, input.subjectId],
    ) as LeaseRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  assertHeld(transaction: Transaction, input: AssertHeldInput): void {
    const record = this.read(transaction, input);
    if (
      record === null ||
      record.owner !== input.owner ||
      record.fence !== input.fence ||
      record.expiresAt === null ||
      record.expiresAt <= input.now
    ) {
      throw new LeaseError(
        "lease-fenced",
        `the lease of ${input.subjectId} is not held by ${input.owner} at fence ${input.fence}`,
      );
    }
  }
}
