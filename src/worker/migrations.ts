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

export const workerMigrations: readonly Migration[] = [
  createAgentEnablementTable,
];
