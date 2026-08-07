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
