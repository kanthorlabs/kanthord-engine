import type { Migration } from "../kernel/store.ts";

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
};

const createPromptTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE agent_prompt (
      id TEXT NOT NULL PRIMARY KEY,
      scope TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      switches TEXT NOT NULL,
      custom_text TEXT NOT NULL,
      system_layer TEXT,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX agent_prompt_scope_agent_name ON agent_prompt (scope, agent_name);
  `);
};

export const agentMigrations: readonly Migration[] = [
  createEnablementTable,
  createPromptTable,
];
