export interface Transaction {
  run(sql: string, parameters?: readonly unknown[]): void;
  get(sql: string, parameters?: readonly unknown[]): unknown;
  all(sql: string, parameters?: readonly unknown[]): readonly unknown[];
}

export type AppliedMigration = Readonly<{
  version: number;
  name: string;
  appliedAt: number;
}>;

export type PendingMigration = Readonly<{ version: number; name: string }>;

export type MigrationStatus = Readonly<{
  applied: readonly AppliedMigration[];
  pending: readonly PendingMigration[];
}>;

export type StorageErrorCode =
  "storage-migration-failed" | "storage-transaction-failed";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface Storage {
  transact<T>(work: (transaction: Transaction) => T): T;
  migrate(): MigrationStatus;
  status(): MigrationStatus;
  close(): void;
  ping(): void;
}
