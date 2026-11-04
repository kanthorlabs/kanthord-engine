import type { Migration } from "../kernel/store.ts";

const createFootprintTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE footprint_cleanup (
      id TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL,
      instance_name TEXT,
      rule TEXT,
      keys TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      state TEXT NOT NULL,
      finished_at INTEGER,
      outcome TEXT
    );
    CREATE TABLE footprint_alert (
      id TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL,
      instance_name TEXT,
      item_key TEXT,
      threshold TEXT NOT NULL,
      value REAL NOT NULL,
      resolved_at INTEGER,
      acknowledged_by TEXT,
      acknowledged_at INTEGER,
      acknowledged_until INTEGER
    );
    CREATE UNIQUE INDEX footprint_alert_open
      ON footprint_alert (kind, IFNULL(instance_name, ''), IFNULL(item_key, ''))
      WHERE resolved_at IS NULL;
  `);
};

export const footprintMigrations: readonly Migration[] = [
  createFootprintTables,
];
