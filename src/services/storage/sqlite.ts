import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "../clock/index.ts";
import type { MigrationStatus, Storage, Transaction } from "./index.ts";
import { StorageError } from "./index.ts";
import type { Migration } from "./migration.ts";
import { openDatabase, runInTransaction } from "./connection.ts";

export type SqliteStorageDependencies = Readonly<{
  path: string;
  clock: Clock;
  migrations: readonly Migration[];
}>;

type AppliedRow = Readonly<{
  version: number;
  name: string;
  appliedAt: number;
}>;

export class SqliteStorage implements Storage {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly migrations: readonly Migration[];
  private closed = false;
  private transactionOpen = false;

  constructor(dependencies: SqliteStorageDependencies) {
    validateMigrations(dependencies.migrations);
    this.clock = dependencies.clock;
    this.migrations = dependencies.migrations;
    this.database = openDatabase(dependencies.path);
  }

  transact<T>(work: (transaction: Transaction) => T): T {
    this.assertOpen();
    this.assertIdle();
    this.transactionOpen = true;
    try {
      return runInTransaction(this.database, work);
    } finally {
      this.transactionOpen = false;
    }
  }

  migrate(): MigrationStatus {
    this.assertOpen();
    this.assertIdle();
    this.ensureMigrationTable();

    const applied = this.readApplied();
    const byVersion = new Map(this.migrations.map((m) => [m.version, m]));
    for (const row of applied) {
      const declared = byVersion.get(row.version);
      if (declared === undefined) {
        throw new StorageError(
          "storage-migration-failed",
          `the database holds migration ${row.version} ${row.name}, which this binary does not know`,
        );
      }
      if (declared.name !== row.name) {
        throw new StorageError(
          "storage-migration-failed",
          `migration ${row.version} is recorded as ${row.name} and declared as ${declared.name}`,
        );
      }
    }

    const appliedVersions = new Set(applied.map((m) => m.version));
    for (const migration of [...this.migrations].sort(
      (a, b) => a.version - b.version,
    )) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      if (migration.rebuild === true) {
        this.database.exec("PRAGMA foreign_keys = OFF");
        this.database.exec("PRAGMA legacy_alter_table = ON");
      }
      try {
        runInTransaction(this.database, (transaction) => {
          for (const statement of migration.statements) {
            transaction.run(statement);
          }
          transaction.run(
            "INSERT INTO migration (version, name, applied_at) VALUES (?, ?, ?)",
            [migration.version, migration.name, this.clock.now()],
          );
        });
      } catch (cause) {
        throw withCause(
          new StorageError(
            "storage-migration-failed",
            `migration ${migration.version} ${migration.name} failed: ${message(cause)}`,
          ),
          cause,
        );
      } finally {
        if (migration.rebuild === true) {
          this.database.exec("PRAGMA legacy_alter_table = OFF");
          this.database.exec("PRAGMA foreign_keys = ON");
        }
      }
    }

    return this.status();
  }

  status(): MigrationStatus {
    this.assertOpen();
    this.assertIdle();
    this.ensureMigrationTable();

    const applied = this.readApplied();
    const appliedVersions = new Set(applied.map((m) => m.version));
    const pending = [...this.migrations]
      .sort((a, b) => a.version - b.version)
      .filter((m) => !appliedVersions.has(m.version))
      .map((m) => ({ version: m.version, name: m.name }));

    return {
      applied: applied.map((m) => ({
        version: m.version,
        name: m.name,
        appliedAt: m.appliedAt,
      })),
      pending,
    };
  }

  ping(): void {
    this.database.prepare("SELECT 1").get();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }

  private assertIdle(): void {
    if (this.transactionOpen) {
      throw new StorageError(
        "storage-transaction-failed",
        "a transaction is already open",
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError(
        "storage-transaction-failed",
        "the storage is closed",
      );
    }
  }

  private ensureMigrationTable(): void {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
    );
  }

  private readApplied(): readonly AppliedRow[] {
    const rows = this.database
      .prepare(
        "SELECT version, name, applied_at FROM migration ORDER BY version ASC",
      )
      .all();
    return rows.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      appliedAt: Number(row.applied_at),
    }));
  }
}

function validateMigrations(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new StorageError(
        "storage-migration-failed",
        `the migration list is invalid: version ${migration.version} is not a positive integer`,
      );
    }
    if (seen.has(migration.version)) {
      throw new StorageError(
        "storage-migration-failed",
        `the migration list is invalid: version ${migration.version} appears twice`,
      );
    }
    seen.add(migration.version);
  }
}

function withCause(error: StorageError, cause: unknown): StorageError {
  error.cause = cause;
  return error;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
