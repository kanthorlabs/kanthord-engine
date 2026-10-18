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
const SCHEMA_KEY_SEPARATOR = "\u0000";
const SCHEMA_TABLE_TYPE = "table";
const SCHEMA_OBJECT_TYPE = 0;
const SCHEMA_OBJECT_NAME = 1;
const SCHEMA_OBJECT_COLUMNS = ["type", "name", "tbl_name", "sql"] as const;
const SCHEMA_MISMATCH_MESSAGE =
  "the schema of this service differs from its migration text; stop the server, delete kanthord.db, tracking.db and their -wal and -shm files in the data directory, and start again";
const EXPECTED_SCHEMA_SQL = `SELECT ${SCHEMA_OBJECT_COLUMNS.join(", ")} FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;
const LIVE_SCHEMA_SQL = `SELECT ${SCHEMA_OBJECT_COLUMNS.join(", ")} FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name IN (SELECT value FROM json_each(?)) OR tbl_name IN (SELECT value FROM json_each(?)) OR substr(name, 1, length(?) + 1) = ? || '_') ORDER BY type, name`;

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

type SchemaObject = readonly [
  type: string,
  name: string,
  table: string,
  sql: string | null,
];

function schemaObjects(
  database: DatabaseSync,
  sql: string,
  ...values: string[]
): SchemaObject[] {
  return database
    .prepare(sql)
    .all(...values)
    .map((row) => [
      String(row.type),
      String(row.name),
      String(row.tbl_name),
      row.sql === null ? null : String(row.sql),
    ]);
}

function expectedSchema(
  migrations: readonly Migration[],
  count: number,
): SchemaObject[] {
  const database = new DatabaseSync(IN_MEMORY_DATABASE);
  try {
    for (const migration of migrations.slice(0, count)) migration(database);
    return schemaObjects(database, EXPECTED_SCHEMA_SQL);
  } finally {
    database.close();
  }
}

function liveSchema(
  database: DatabaseSync,
  service: string,
  expected: readonly SchemaObject[],
): SchemaObject[] {
  return schemaObjects(
    database,
    LIVE_SCHEMA_SQL,
    JSON.stringify(expected.map((object) => object[SCHEMA_OBJECT_NAME])),
    JSON.stringify(
      expected
        .filter((object) => object[SCHEMA_OBJECT_TYPE] === SCHEMA_TABLE_TYPE)
        .map((object) => object[SCHEMA_OBJECT_NAME]),
    ),
    service,
    service,
  );
}

function firstSchemaDifference(
  expected: readonly SchemaObject[],
  live: readonly SchemaObject[],
): string | null {
  const key = (object: SchemaObject) =>
    [object[SCHEMA_OBJECT_TYPE], object[SCHEMA_OBJECT_NAME]].join(
      SCHEMA_KEY_SEPARATOR,
    );
  const left = new Map(expected.map((object) => [key(object), object]));
  const right = new Map(live.map((object) => [key(object), object]));
  const differing = [...new Set([...left.keys(), ...right.keys()])]
    .sort()
    .find(
      (name) =>
        JSON.stringify(left.get(name)) !== JSON.stringify(right.get(name)),
    );
  return differing === undefined
    ? null
    : differing.split(SCHEMA_KEY_SEPARATOR)[SCHEMA_OBJECT_NAME]!;
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
    this.assertSchema(known, versions);
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

  private assertSchema(
    known: ReadonlyMap<string, readonly Migration[]>,
    versions: ReadonlyMap<string, number>,
  ): void {
    for (const [service, count] of versions) {
      const expected = expectedSchema(known.get(service)!, count);
      const object = firstSchemaDifference(
        expected,
        liveSchema(this.database, service, expected),
      );
      if (object !== null)
        throw new Diagnostic(
          "system.database.migration.schema_mismatch",
          SCHEMA_MISMATCH_MESSAGE,
          {
            fields: [
              ["path", this.path],
              ["service", service],
              ["object", object],
            ],
          },
        );
    }
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
