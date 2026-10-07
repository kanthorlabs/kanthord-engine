import { canonicalJSON } from "../kernel/json.ts";
import type { Migration } from "../kernel/store.ts";
import { isObject } from "../kernel/values.ts";

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

const createPromptTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE agent_prompt (
      id TEXT NOT NULL PRIMARY KEY,
      scope TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      switches TEXT NOT NULL,
      custom_text TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX agent_prompt_scope_agent_name ON agent_prompt (scope, agent_name);
  `);
};

const addSystemLayerOverride: Migration = (database) => {
  database.exec(`
    ALTER TABLE agent_prompt ADD COLUMN system_layer TEXT;
    UPDATE agent_prompt SET system_layer = 'inherit' WHERE scope = 'agent';
  `);
};

const DEFAULT_CONFIGURATION_KEYS: Readonly<Record<string, string>> = {
  agentProvider: "agent_provider",
  modelIdentifier: "model_identifier",
  reasoningEffort: "reasoning_effort",
};

function renameDefaultConfiguration(configuration: unknown): unknown {
  if (!isObject(configuration) || Array.isArray(configuration))
    return configuration;
  return Object.fromEntries(
    Object.entries(configuration).map(([key, item]) => [
      Object.hasOwn(DEFAULT_CONFIGURATION_KEYS, key)
        ? DEFAULT_CONFIGURATION_KEYS[key]
        : key,
      item,
    ]),
  );
}

const renameDefaultConfigurationKeys: Migration = (database) => {
  const update = database.prepare(
    "UPDATE agent_enablement SET default_configuration = ? WHERE id = ?",
  );
  const rows = database
    .prepare("SELECT id, default_configuration FROM agent_enablement")
    .all() as { id: string; default_configuration: string }[];
  for (const { id, default_configuration } of rows)
    update.run(
      canonicalJSON(
        renameDefaultConfiguration(JSON.parse(default_configuration)),
      ),
      id,
    );
};

export const agentMigrations: readonly Migration[] = [
  createEnablementTable,
  createPromptTable,
  addSystemLayerOverride,
  renameDefaultConfigurationKeys,
];
