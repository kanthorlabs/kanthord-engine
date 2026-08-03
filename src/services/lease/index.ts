import type { Transaction } from "../storage/index.ts";

export type LeaseSubjectKind = "node" | "repository";

export type LeaseRecord = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string | null;
  fence: number;
  acquiredAt: number | null;
  renewedAt: number | null;
  expiresAt: number | null;
}>;

export type AcquireLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  ttlMs: number;
}>;

export type RenewLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  fence: number;
  ttlMs: number;
}>;

export type ReleaseLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  fence: number;
}>;

export type LeaseErrorCode = "not-implemented" | "lease-held" | "lease-fenced";

export class LeaseError extends Error {
  readonly code: LeaseErrorCode;
  constructor(code: LeaseErrorCode, message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

export interface Lease {
  acquire(transaction: Transaction, input: AcquireLeaseInput): LeaseRecord;
  renew(transaction: Transaction, input: RenewLeaseInput): LeaseRecord;
  release(transaction: Transaction, input: ReleaseLeaseInput): void;
  expired(transaction: Transaction, now: number): readonly LeaseRecord[];
}
