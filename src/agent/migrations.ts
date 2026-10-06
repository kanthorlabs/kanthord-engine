import type { Migration } from "../kernel/store.ts";

const LEGACY_ENABLEMENT_TABLE = "worker_agent_enablement";

const createEnablementTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE agent_enablement (
      id TEXT NOT NULL PRIMARY KEY,
      agent_name TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      agent_providers TEXT NOT NULL,
      default_configuration TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE UNIQUE INDEX agent_enablement_agent_name_revision ON agent_enablement (agent_name, revision);
  `);
  const legacy = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(LEGACY_ENABLEMENT_TABLE);
  if (legacy)
    database.exec(`
      INSERT INTO agent_enablement
        (id, agent_name, revision, state, agent_providers, default_configuration, created_at, removed_at)
      SELECT id, agent_name, revision, state, agent_providers, default_configuration, created_at, removed_at
      FROM ${LEGACY_ENABLEMENT_TABLE};
    `);
};

export const agentMigrations: readonly Migration[] = [createEnablementTable];
