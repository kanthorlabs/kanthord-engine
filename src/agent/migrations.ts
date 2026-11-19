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
    CREATE TABLE agent_variant (
      id TEXT NOT NULL PRIMARY KEY,
      agent_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      instruction TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX agent_variant_display_name ON agent_variant (display_name COLLATE NOCASE);
  `);
};

export const agentMigrations: readonly Migration[] = [createAgentTables];
