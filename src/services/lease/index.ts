import type { LeaseOwnerKind } from "../../domain/lease.ts";
import type { LeaseRefusal } from "../../domain/lease-hierarchy.ts";
import type { Transaction } from "../storage/index.ts";

export type LeaseSubjectKind = "node" | "repository";

export type LeaseRecord = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string | null;
  ownerKind: LeaseOwnerKind | null;
  fence: number;
  acquiredAt: number | null;
  renewedAt: number | null;
  expiresAt: number | null;
}>;

export type AcquireLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  ownerKind: LeaseOwnerKind;
  ttlMs: number;
  now: number;
}>;

export type RenewLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  ownerKind: LeaseOwnerKind;
  fence: number;
  ttlMs: number;
  now: number;
}>;

export type ReleaseLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  ownerKind: LeaseOwnerKind;
  fence: number;
  now: number;
}>;

export type AcquireLeaseResult = Readonly<{
  record: LeaseRecord;
  acquired: boolean;
}>;

export type ExpireLeasesOfOwnerInput = Readonly<{
  owner: string;
  now: number;
}>;

export type LeaseSubject = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
}>;

export type ReadLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  now: number;
}>;

export type AssertHeldInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  fence: number;
  now: number;
}>;

export type LeaseErrorCode = "not-implemented" | "lease-held" | "lease-fenced";

export class LeaseError extends Error {
  readonly code: LeaseErrorCode;
  readonly refusal?: LeaseRefusal;
  constructor(code: LeaseErrorCode, message: string, refusal?: LeaseRefusal) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
    this.refusal = refusal;
  }
}

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
