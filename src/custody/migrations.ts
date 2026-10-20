import type { Migration } from "../kernel/store.ts";

const createCustodyTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE credential (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      holder TEXT NOT NULL,
      sealed_to TEXT,
      revision INTEGER NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      available_at INTEGER,
      strikes INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX credential_name_holder_revision ON credential (name, holder, revision);
    CREATE TABLE custody_master_key (
      id INTEGER NOT NULL PRIMARY KEY,
      verifier BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
};

export const custodyMigrations: readonly Migration[] = [createCustodyTables];
