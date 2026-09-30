import type { Migration } from "../kernel/store.ts";

const createAgentEnablementTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE worker_agent_enablement (
      id TEXT NOT NULL PRIMARY KEY,
      agent_name TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      agent_providers TEXT NOT NULL,
      default_configuration TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE UNIQUE INDEX worker_agent_enablement_agent_name_revision ON worker_agent_enablement (agent_name, revision);
  `);
};

const createInstanceTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE worker_instance (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      resource_identity TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX worker_instance_live_client ON worker_instance (client_id) WHERE ended_at IS NULL;
  `);
};

export const workerMigrations: readonly Migration[] = [
  createAgentEnablementTable,
  createInstanceTable,
];
