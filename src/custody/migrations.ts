import type { Migration } from "../kernel/store.ts";

const createCredentialTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE credential (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      revision INTEGER NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX credential_name_revision ON credential (name, revision);
  `);
};

export const custodyMigrations: readonly Migration[] = [createCredentialTable];
