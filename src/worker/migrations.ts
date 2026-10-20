import type { Migration } from "../kernel/store.ts";

const createWorkerTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE worker_registration (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      resource_identity TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      instance_id TEXT,
      registered_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX worker_registration_live_client ON worker_registration (client_id) WHERE ended_at IS NULL;
    CREATE TABLE worker_instance (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      worker TEXT NOT NULL,
      revision INTEGER NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX worker_instance_name_revision ON worker_instance (name, revision);
    CREATE UNIQUE INDEX worker_instance_fingerprint ON worker_instance (fingerprint);
  `);
};

export const workerMigrations: readonly Migration[] = [createWorkerTables];
