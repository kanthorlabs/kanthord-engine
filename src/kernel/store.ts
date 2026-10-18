import {
  DatabaseSync,
  type PrepareOptions,
  type StatementSync,
} from "node:sqlite";
import { audit } from "./files.ts";
import { Diagnostic } from "./errors.ts";
import { isObject, isString } from "./values.ts";

export const IN_MEMORY_DATABASE = ":memory:";
export const STATEMENT_CACHE_LIMIT = 256;
const DATABASE_PROBE_OK = 1;
const NO_RECORDED_MIGRATION = 0;

export interface Transaction {
  readonly database: DatabaseSync;
}
export type Migration = (database: DatabaseSync) => void;
export type Migrations = ReadonlyArray<{
  service: string;
  migrations: readonly Migration[];
}>;
export interface PendingMigration {
  readonly service: string;
  readonly from: number;
  readonly to: number;
}
export interface MigrationPlan {
  readonly fresh: boolean;
  readonly pending: readonly PendingMigration[];
}

class StatementCache extends DatabaseSync {
  private readonly statements = new Map<string, StatementSync>();

  override prepare(sql: string, options?: PrepareOptions): StatementSync {
    if (options !== undefined) return super.prepare(sql, options);
    const cached = this.statements.get(sql);
    if (cached !== undefined) {
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    const statement = super.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > STATEMENT_CACHE_LIMIT)
      this.statements.delete(this.statements.keys().next().value!);
    return statement;
  }

  override exec(sql: string): void {
    try {
      super.exec(sql);
    } finally {
      this.statements.clear();
    }
  }

  override close(): void {
    super.close();
    this.statements.clear();
  }
}

/** One connection and transaction owner for the operational database. */
function sqliteReason(error: unknown): string {
  const reason = (error as { errstr?: unknown } | null)?.errstr;
  return isString(reason) ? reason : "unknown SQLite failure";
}

export class Store {
  readonly database: DatabaseSync;
  readonly path: string;
  private active = false;
  private closed = false;

  constructor(path: string) {
    this.path = path;
    if (path !== IN_MEMORY_DATABASE)
      for (const suffix of ["", "-wal", "-shm"])
        audit(path + suffix, "file", true);
    try {
      this.database = new StatementCache(path, {
        enableForeignKeyConstraints: true,
      });
    } catch {
      throw new Diagnostic(
        "system.database.open_failed",
        "cannot open database",
        { fields: [["path", path]] },
      );
    }
    try {
      this.audit();
      this.database.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL;",
      );
      this.audit();
      this.database.exec(
        "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=67108864;",
      );
      this.transaction(() => {});
    } catch (error) {
      this.database.close();
      if (error instanceof Diagnostic) throw error;
      throw new Diagnostic(
        "system.database.initialization_failed",
        `cannot initialize database: ${sqliteReason(error)}`,
        { cause: error, fields: [["path", path]] },
      );
    }
  }

  private audit() {
    if (this.path === IN_MEMORY_DATABASE) return;
    audit(this.path, "file");
    audit(this.path + "-wal", "file", true);
    audit(this.path + "-shm", "file", true);
  }

  transaction<T>(work: (transaction: Transaction) => T): T {
    if (this.active) throw new Error("Nested transactions are forbidden.");
    this.database.exec("BEGIN IMMEDIATE");
    this.active = true;
    try {
      this.audit();
      const result = work({ database: this.database });
      if (isObject(result) && "then" in result)
        throw new Error("Transactions must be synchronous.");
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.active = false;
    }
  }

  plan(services: Migrations): MigrationPlan {
    const known = new Map(
      services.map((entry) => [entry.service, entry.migrations]),
    );
    if (known.size !== services.length)
      throw new Diagnostic(
        "system.database.migration.duplicate_service",
        "migration: duplicate service.",
      );
    const exists = this.database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration'",
      )
      .get();
    const records = exists
      ? this.database
          .prepare(
            "SELECT service, version FROM migration ORDER BY service, version",
          )
          .all()
      : [];
    const versions = new Map<string, number>();
    for (const record of records) {
      const name = String(record.service);
      const version = Number(record.version);
      if (
        !known.has(name) ||
        version !== (versions.get(name) ?? 0) + 1 ||
        version > known.get(name)!.length
      )
        throw new Diagnostic(
          "system.database.migration.incompatible_history",
          "the recorded migration history is newer than this binary or comes from another history; install the matching kanthord or restore the database backup",
          { fields: [["path", this.path]] },
        );
      versions.set(name, version);
    }
    return {
      fresh: records.length === NO_RECORDED_MIGRATION,
      pending: services
        .map(({ service, migrations }) => ({
          service,
          from: versions.get(service) ?? NO_RECORDED_MIGRATION,
          to: migrations.length,
        }))
        .filter(({ from, to }) => from < to),
    };
  }

  migrate(
    services: Migrations,
    migrated: (step: PendingMigration) => void = () => {},
  ): void {
    const { pending } = this.plan(services);
    this.transaction(({ database }) =>
      database.exec(
        "CREATE TABLE IF NOT EXISTS migration(service TEXT NOT NULL, version INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY(service, version))",
      ),
    );
    const lists = new Map(
      services.map((entry) => [entry.service, entry.migrations]),
    );
    for (const step of pending) {
      const { service, from, to } = step;
      const migrations = lists.get(service)!;
      for (let index = from; index < to; index++) {
        this.transaction(({ database }) => {
          migrations[index]!(database);
          database
            .prepare("INSERT INTO migration VALUES (?, ?, ?)")
            .run(service, index + 1, Date.now());
        });
      }
      migrated(step);
    }
  }

  backup(path: string): void {
    if (audit(path, "file", true))
      throw new Diagnostic(
        "system.database.backup_failed",
        "cannot write the database backup: the file exists",
        { fields: [["path", path]] },
      );
    try {
      this.database.prepare("VACUUM INTO ?").run(path);
    } catch (error) {
      throw new Diagnostic(
        "system.database.backup_failed",
        `cannot write the database backup: ${sqliteReason(error)}`,
        { cause: error, fields: [["path", path]] },
      );
    }
    audit(path, "file");
  }

  healthcheck(): boolean {
    if (this.closed) return false;
    try {
      return (
        this.database.prepare("SELECT ? AS ok").get(DATABASE_PROBE_OK)?.ok ===
        DATABASE_PROBE_OK
      );
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
