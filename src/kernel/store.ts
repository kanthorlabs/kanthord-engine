import { DatabaseSync } from "node:sqlite";
import { audit } from "./files.ts";
import { Diagnostic } from "./errors.ts";
import { isObject, isString } from "./values.ts";

export const IN_MEMORY_DATABASE = ":memory:";
const DATABASE_PROBE_OK = 1;

export interface Transaction {
  readonly database: DatabaseSync;
}
export type Migration = (database: DatabaseSync) => void;
export type Migrations = ReadonlyArray<{
  service: string;
  migrations: readonly Migration[];
}>;

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
      this.database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
      });
    } catch {
      throw new Diagnostic(
        "system.database.open_failed",
        `${path}: cannot open database.`,
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
        `${path}: cannot initialize database: ${sqliteReason(error)}.`,
        { cause: error },
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

  migrate(services: Migrations): void {
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
          "migration: incompatible recorded history.",
        );
      versions.set(name, version);
    }
    this.transaction(({ database }) =>
      database.exec(
        "CREATE TABLE IF NOT EXISTS migration(service TEXT NOT NULL, version INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY(service, version))",
      ),
    );
    for (const { service, migrations } of services) {
      for (
        let index = versions.get(service) ?? 0;
        index < migrations.length;
        index++
      ) {
        this.transaction(({ database }) => {
          migrations[index]!(database);
          database
            .prepare("INSERT INTO migration VALUES (?, ?, ?)")
            .run(service, index + 1, Date.now());
        });
      }
    }
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
