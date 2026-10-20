import type { Migration } from "../kernel/store.ts";

const createRegistrationTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE worker_registration (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      resource_identity TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX worker_registration_live_client ON worker_registration (client_id) WHERE ended_at IS NULL;
  `);
};

export const workerMigrations: readonly Migration[] = [createRegistrationTable];
