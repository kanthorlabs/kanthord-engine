import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Storage } from "../../src/services/storage/index.ts";
import { migrations } from "../../src/services/storage/migrations.ts";
import { SqliteStorage } from "../../src/services/storage/sqlite.ts";
import { rows } from "../../src/domain/rows.ts";
import type { TableName } from "../../src/domain/rows.ts";
import { createMockClock } from "./clock.ts";

export type TemporaryDatabase = Readonly<{ path: string; dispose(): void }>;

export function createTemporaryDatabase(): TemporaryDatabase {
  const dir = fs.mkdtempSync(join(tmpdir(), "kanthord-db-"));
  const dbPath = join(dir, "kanthord.db");

  return {
    path: dbPath,
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TemporaryStorage = Readonly<{
  storage: Storage;
  path: string;
  dispose(): void;
}>;

export function createMigratedStorage(): TemporaryStorage {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000, step: 1000 }),
    migrations,
  });
  storage.migrate();
  return {
    storage,
    path: temporary.path,
    dispose() {
      storage.close();
      temporary.dispose();
    },
  };
}

export function createStorageAtVersion(version: number): TemporaryStorage {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000, step: 1000 }),
    migrations: migrations.filter((migration) => migration.version <= version),
  });
  storage.migrate();
  return {
    storage,
    path: temporary.path,
    dispose() {
      storage.close();
      temporary.dispose();
    },
  };
}

export function tableCounts(
  storage: Storage,
): Readonly<Record<TableName, number>> {
  const tables = (Object.keys(rows) as readonly TableName[])
    .slice()
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  return storage.transact((transaction) => {
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = transaction.get(`SELECT COUNT(*) AS n FROM "${table}"`) as {
        n: number;
      };
      result[table] = row.n;
    }
    return result as Readonly<Record<TableName, number>>;
  });
}

export function tableRows(
  storage: Storage,
  table: TableName,
): readonly Readonly<Record<string, unknown>>[] {
  return storage.transact((transaction) =>
    transaction.all(`SELECT * FROM "${table}" ORDER BY rowid`),
  ) as readonly Readonly<Record<string, unknown>>[];
}

export function tableBytes(storage: Storage, table: TableName): Buffer {
  const rows_ = tableRows(storage, table);
  return Buffer.from(
    JSON.stringify(rows_, (key, value) =>
      value instanceof Uint8Array
        ? { bytes: Buffer.from(value).toString("base64") }
        : value,
    ),
    "utf8",
  );
}

export function databaseBytes(storage: Storage): Buffer {
  const tables = (Object.keys(rows) as readonly TableName[])
    .slice()
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat(
    tables.map((table) =>
      Buffer.concat([
        Buffer.from(`${table}:`, "utf8"),
        tableBytes(storage, table),
        Buffer.from(";", "utf8"),
      ]),
    ),
  );
}
