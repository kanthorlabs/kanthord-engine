import type { Migration } from "../kernel/store.ts";

const createAgentTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE agent_enablement (
      id TEXT NOT NULL PRIMARY KEY,
      agent_name TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      agent_providers TEXT NOT NULL,
      default_configuration TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER,
      fallback_configurations TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX agent_enablement_agent_name_revision ON agent_enablement (agent_name, revision);
  `);
};

export const agentMigrations: readonly Migration[] = [createAgentTables];
