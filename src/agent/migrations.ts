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
    CREATE TABLE agent_cooldown (
      id TEXT NOT NULL PRIMARY KEY,
      credential TEXT NOT NULL,
      model_identifier TEXT NOT NULL,
      code TEXT NOT NULL,
      strikes INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      until_at INTEGER NOT NULL,
      execution_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX agent_cooldown_credential_model_identifier ON agent_cooldown (credential, model_identifier);
  `);
};

export const agentMigrations: readonly Migration[] = [createAgentTables];
